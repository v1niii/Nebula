const { app, BrowserWindow, ipcMain, shell, dialog, session, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const crypto = require('crypto');
const store = require('electron-store');
const { AuthService } = require('./auth-service');
const { AuthLaunchService } = require('./auth-launch-service');

const appStore = new store({ clearInvalidConfig: true });
const authService = new AuthService(appStore);
const authLaunchService = new AuthLaunchService(appStore, authService);

let mainWindow;
let tray = null;
let valorantProcessWatcher = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900, height: 650, minWidth: 480, minHeight: 400,
        autoHideMenuBar: true, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
        icon: path.join(__dirname, 'assets/icon.ico')
    });

    mainWindow.maximize();
    mainWindow.show();

    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'renderer/dist/index.html'));
    }

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.webContents.send('confirm-close');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        stopValorantWatcher();
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets/icon.ico');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Nebula', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);

    tray.setToolTip('Nebula - Valorant Account Manager');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

app.whenReady().then(() => {
    createWindow();
    createTray();
    if (process.env.NODE_ENV !== 'development') setupAutoUpdater();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { /* tray keeps app alive */ }
});

app.on('before-quit', () => { app.isQuitting = true; });

// Scrub plaintext auth files on quit
app.on('will-quit', () => {
    try {
        const fs = require('fs');
        const yaml = require('yaml');
        const base = path.join(process.env.LOCALAPPDATA, 'Riot Games');
        const emptyYaml = yaml.stringify({ private: { 'riot-login': { persist: { session: { cookies: [] } } } } });
        for (const sub of ['Riot Client/Data', 'Beta/Data']) {
            const file = path.join(base, sub, 'RiotGamesPrivateSettings.yaml');
            if (fs.existsSync(file)) fs.writeFileSync(file, emptyYaml, 'utf-8');
        }
    } catch (e) { /* best effort */ }
});

// --- Account IPC ---

ipcMain.handle('get-accounts', () => authService.getAccounts());

ipcMain.handle('login-with-riot', async () => {
    return new Promise((resolve) => {
        const authPartition = `riot-auth-${Date.now()}`;
        const authSession = session.fromPartition(authPartition);
        const nonce = crypto.randomBytes(16).toString('base64url');

        const authWindow = new BrowserWindow({
            width: 500, height: 750, parent: mainWindow, modal: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, session: authSession }
        });
        authWindow.setMenuBarVisibility(false);
        authWindow.setAutoHideMenuBar(true);

        const ALLOWED_DOMAINS = ['auth.riotgames.com', 'authenticate.riotgames.com', 'playvalorant.com', 'account.riotgames.com'];
        authWindow.webContents.on('will-navigate', (event, url) => {
            try {
                const hostname = new URL(url).hostname;
                if (!ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) event.preventDefault();
            } catch { event.preventDefault(); }
        });

        authSession.cookies.set({ url: 'https://auth.riotgames.com', name: 'riotgames.cookie-policy', value: 'accept' }).catch(() => {});
        authWindow.webContents.on('dom-ready', () => {
            authWindow.webContents.insertCSS(`
                .cookie-banner, .cookie-policy, [class*="cookie"], [id*="cookie"],
                .osano-cm-window, .osano-cm-dialog, #onetrust-consent-sdk,
                [class*="consent"], [id*="consent-banner"] { display: none !important; }
            `).catch(() => {});
        });

        authWindow.loadURL(`https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=${nonce}&scope=account%20openid`);

        let resolved = false;
        const finishWithTokens = async (accessToken, idToken) => {
            if (resolved) return;
            resolved = true;
            // Get cookies from both auth.riotgames.com and .riotgames.com (tdid lives on parent domain)
            const [authCookies, rootCookies] = await Promise.all([
                authSession.cookies.get({ domain: 'auth.riotgames.com' }),
                authSession.cookies.get({ domain: 'riotgames.com' }),
            ]);
            const cookies = {};
            [...rootCookies, ...authCookies].forEach(c => { cookies[c.name] = c.value; });
            await authSession.clearStorageData();
            await authSession.clearCache();
            try { authWindow.close(); } catch (e) {}
            resolve(await authService.addAccountFromTokens(accessToken, idToken, cookies));
        };

        const parseTokens = (url) => {
            const i = url.indexOf('#');
            if (i === -1) return null;
            const p = new URLSearchParams(url.substring(i + 1));
            const at = p.get('access_token');
            return at ? { accessToken: at, idToken: p.get('id_token') || '' } : null;
        };

        authWindow.webContents.on('will-redirect', (event, url) => {
            if (resolved) return;
            const tokens = parseTokens(url);
            if (tokens) { event.preventDefault(); finishWithTokens(tokens.accessToken, tokens.idToken); }
        });
        const tryExtract = async () => {
            if (resolved) return;
            try {
                const hash = await authWindow.webContents.executeJavaScript('window.location.hash');
                if (hash?.includes('access_token')) {
                    const p = new URLSearchParams(hash.substring(1));
                    const at = p.get('access_token');
                    if (at) finishWithTokens(at, p.get('id_token') || '');
                }
            } catch (e) {}
        };
        authWindow.webContents.on('did-navigate', tryExtract);
        authWindow.webContents.on('did-finish-load', tryExtract);
        authWindow.webContents.on('did-navigate-in-page', tryExtract);

        const loginTimeout = setTimeout(() => { if (!resolved) try { authWindow.close(); } catch (e) {} }, 5 * 60 * 1000);
        authWindow.on('closed', async () => {
            clearTimeout(loginTimeout);
            try { await authSession.clearStorageData(); await authSession.clearCache(); } catch (e) {}
            if (!resolved) { resolved = true; resolve({ success: false, error: 'Login window was closed.' }); }
        });
    });
});

ipcMain.handle('import-current-account', async () => {
    try {
        const account = await authLaunchService.importCurrentAccount();
        return account ? { success: true, account } : { success: false, error: 'Could not import account.' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('remove-account', async (event, accountId) => {
    try { await authService.removeAccount(accountId); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('set-nickname', async (event, accountId, nickname) => {
    return authService.setNickname(accountId, nickname);
});

ipcMain.handle('reorder-accounts', async (event, orderedIds) => {
    return authService.reorderAccounts(orderedIds);
});

ipcMain.handle('check-session', async (event, accountId) => {
    return authService.checkSession(accountId);
});

ipcMain.handle('launch-valorant', async (event, accountId) => {
    if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'launching');
    try {
        const account = authService.getAccountById(accountId);
        const cookies = await authService.retrieveCookiesSecurely(accountId);
        if (!account || !cookies?.ssid) {
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Account data or cookies missing.');
            return { success: false, error: 'Account data or cookies missing.' };
        }

        const valorantPath = appStore.get('valorantPath');
        const riotClientExists = await authLaunchService.getRiotClientPath();
        if (!valorantPath || !riotClientExists) {
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Riot Client not configured.');
            return { success: false, error: 'Riot Client path not set. Configure it in settings.' };
        }

        const autoLaunch = appStore.get('autoLaunchValorant', true);
        await authLaunchService.launchValorant(account, cookies, autoLaunch);
        await authService.updateLastUsed(accountId);
        startValorantWatcher(accountId);
        return { success: true };
    } catch (error) {
        if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('copy-settings', async (event, fromId, toId) => {
    try {
        const result = await authLaunchService.copyGameSettings(fromId, toId);
        return { success: true, copied: result.copied };
    } catch (error) { return { success: false, error: error.message }; }
});

// --- Settings IPC ---

ipcMain.handle('get-settings', () => {
    let valorantPath = appStore.get('valorantPath');
    if (!valorantPath) {
        const defaultPath = 'C:\\Riot Games';
        const fs = require('fs');
        if (fs.existsSync(defaultPath)) {
            appStore.set('valorantPath', defaultPath);
            valorantPath = defaultPath;
        }
    }
    return {
        valorantPath,
        theme: appStore.get('theme', 'system'),
        autoLaunchValorant: appStore.get('autoLaunchValorant', true),
    };
});

ipcMain.handle('save-settings', async (event, settings) => {
    if (settings.valorantPath) appStore.set('valorantPath', settings.valorantPath);
    if (settings.theme) {
        appStore.set('theme', settings.theme);
        if (mainWindow) mainWindow.webContents.send('apply-theme', settings.theme);
    }
    if (typeof settings.autoLaunchValorant === 'boolean') {
        appStore.set('autoLaunchValorant', settings.autoLaunchValorant);
    }
    return { success: true };
});

ipcMain.handle('select-valorant-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Riot Games Installation Directory' });
    if (!result.canceled && result.filePaths.length > 0) {
        const riotPath = await authLaunchService.getRiotClientPath();
        if (riotPath) { appStore.set('valorantPath', result.filePaths[0]); return { success: true, path: result.filePaths[0] }; }
        return { success: false, error: 'No valid Riot Client found.' };
    }
    return { success: false };
});

ipcMain.handle('minimize-to-tray', () => {
    if (mainWindow) mainWindow.hide();
});

ipcMain.handle('quit-app', () => {
    app.isQuitting = true;
    app.quit();
});

ipcMain.handle('open-external-link', (event, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
});

// --- Watcher ---

function startValorantWatcher(accountId) {
    stopValorantWatcher();
    let found = false, errors = 0;
    valorantProcessWatcher = setInterval(async () => {
        try {
            const running = await authLaunchService.isValorantRunning();
            errors = 0;
            if (running && !found) { found = true; if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'running'); }
            else if (!running && found) { if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'closed'); stopValorantWatcher(); }
        } catch (e) {
            if (++errors >= 5) { if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Monitoring failed.'); stopValorantWatcher(); }
        }
    }, 5000);
}

function stopValorantWatcher() {
    if (valorantProcessWatcher) { clearInterval(valorantProcessWatcher); valorantProcessWatcher = null; }
}
