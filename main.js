const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const store = require('electron-store');

// Set app name and model ID so Windows shows "Nebula" in taskbar/task manager
app.setName('Nebula');
if (process.platform === 'win32') app.setAppUserModelId('com.v1niii.nebula');
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
        title: 'Nebula',
        width: 750, height: 700,
        resizable: false,
        maximizable: false,
        autoHideMenuBar: true, menuBarVisible: false, show: false, center: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
        icon: path.join(__dirname, 'assets/icon.ico')
    });

    mainWindow.setMenu(null);
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
    const iconPath = path.join(__dirname, 'assets/icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Nebula', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);

    tray.setToolTip('Nebula - Valorant Account Manager');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    const sendToRenderer = (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
        }
    };

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[updater] Update available: v${info.version}`);
        sendToRenderer('update-status', { type: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log(`[updater] No updates. Current: v${info.version}`);
    });

    autoUpdater.on('download-progress', (progress) => {
        console.log(`[updater] Downloading: ${progress.percent.toFixed(1)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[updater] Update v${info.version} downloaded, will install on quit.`);
        sendToRenderer('update-status', { type: 'downloaded', version: info.version });
    });

    autoUpdater.on('error', (err) => {
        console.error('[updater] Error:', err.message);
    });

    // Initial check on startup
    autoUpdater.checkForUpdates().catch((e) => console.error('[updater] Check failed:', e.message));

    // Re-check every 4 hours so long-running sessions still get updates
    setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
}

ipcMain.handle('install-update-now', () => {
    autoUpdater.quitAndInstall();
});

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

// No longer need to scrub YAML on quit - snapshot/restore handles auth state

// --- Account IPC ---

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-accounts', () => authService.getAccounts());

// Login via Riot Client: launches the actual Riot Client for the user to log in,
// then snapshots the auth files for future account switching
ipcMain.handle('login-with-riot', async () => {
    try {
        const account = await authLaunchService.addViaRiotClient();
        return { success: true, account };
    } catch (error) {
        return { success: false, error: error.message };
    }
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
    try {
        await authService.removeAccount(accountId);
        await authLaunchService.deleteSnapshot(accountId);
        return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('set-nickname', async (event, accountId, nickname) => {
    return authService.setNickname(accountId, nickname);
});

ipcMain.handle('reorder-accounts', async (event, orderedIds) => {
    return authService.reorderAccounts(orderedIds);
});

ipcMain.handle('check-session', async (event, accountId) => {
    // Check if Riot Client is running and authed as this account
    const auth = await authLaunchService.getAuthenticatedAccount();
    if (auth && auth.puuid === accountId) return { valid: true };
    // Try stored cookies
    const result = await authService.checkSession(accountId);
    if (result.valid) return result;
    // Fallback to snapshot cookies
    const snapCookies = await authLaunchService.extractCookiesFromSnapshot(accountId);
    if (snapCookies?.ssid) return authService.checkSessionWithCookies(accountId, snapCookies);
    return result;
});

let launchInProgress = false;
function releaseLaunchLock() { launchInProgress = false; }

// Serializes all snapshot operations so they never run concurrently with a launch's restore.
// Without this, a launch's restoreAccountData can overwrite the disk while a watcher's snapshot
// is mid-read, corrupting the previous account's saved state.
let snapshotChain = Promise.resolve();
function queueSnapshot(accountId) {
    snapshotChain = snapshotChain.then(() => authLaunchService.snapshotAccountData(accountId).catch(() => {}));
    return snapshotChain;
}

ipcMain.handle('launch-valorant', async (event, accountId) => {
    if (launchInProgress) return { success: false, error: 'A launch is already in progress. Please wait.' };
    launchInProgress = true;
    // Stop the previous watcher and wait for any in-flight snapshot to complete BEFORE
    // we start overwriting the Riot Client directory with the new account's data.
    stopValorantWatcher();
    await snapshotChain;
    if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'launching');
    try {
        const account = authService.getAccountById(accountId);
        if (!account) {
            releaseLaunchLock();
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Account not found.');
            return { success: false, error: 'Account not found.' };
        }

        const autoLaunch = appStore.get('autoLaunchValorant', true);
        const result = await authLaunchService.launchValorant(account, autoLaunch);

        if (result.sessionExpired) {
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Session expired');
            authLaunchService.handleReLogin(accountId).then(() => {
                authService.updateLastUsed(accountId);
                releaseLaunchLock();
                if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
            }).catch(() => { releaseLaunchLock(); });
            return { success: false, error: 'Session expired. Please log in via the Riot Client — session will be saved automatically.', sessionExpired: true };
        }

        await authService.updateLastUsed(accountId);
        if (autoLaunch) {
            startValorantWatcher(accountId);
            // Lock releases when watcher detects Valorant running or gives up
        } else {
            setTimeout(() => sendStatus(accountId, 'closed'), 3000);
            releaseLaunchLock();
        }
        return { success: true };
    } catch (error) {
        releaseLaunchLock();
        if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('copy-settings', async (event, fromId, toId) => {
    try {
        const result = await authLaunchService.copyGameSettings(fromId, toId);
        return { success: true, copied: result.copied, method: 'local' };
    } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('copy-cloud-settings', async (event, fromId, toId) => {
    try {
        const fromAcc = authService.getAccountById(fromId);
        const toAcc = authService.getAccountById(toId);
        if (!fromAcc || !toAcc) throw new Error('Account not found.');

        const getCookies = async (accountId) => {
            const stored = await authService.retrieveCookiesSecurely(accountId);
            if (stored?.ssid) return stored;
            const snap = await authLaunchService.extractCookiesFromSnapshot(accountId);
            if (snap?.ssid) return snap;
            return null;
        };

        const srcCookies = await getCookies(fromId);
        if (!srcCookies?.ssid) throw new Error('Source account session not found. Launch it first.');
        const dstCookies = await getCookies(toId);
        if (!dstCookies?.ssid) throw new Error('Target account session not found. Launch it first.');

        const srcAuth = await authService.getCloudAuthTokens(srcCookies.ssid, srcCookies.clid, srcCookies.csid, srcCookies.tdid);
        const dstAuth = await authService.getCloudAuthTokens(dstCookies.ssid, dstCookies.clid, dstCookies.csid, dstCookies.tdid);

        // Copy cloud settings (crosshair, sens, keybinds)
        const settings = await authService.getCloudSettings(srcAuth.accessToken, srcAuth.entitlementsToken, fromAcc.region);
        await authService.putCloudSettings(dstAuth.accessToken, dstAuth.entitlementsToken, toAcc.region, settings);

        // Also copy local .ini files (catches settings like scoped sensitivity that cloud misses)
        try { await authLaunchService.copyGameSettings(fromId, toId); } catch {}

        return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
});

// --- Settings IPC ---

ipcMain.handle('get-settings', async () => {
    // Auto-detect Riot Client path (this is the source of truth, not user-selected)
    let riotClientPath = '';
    try { riotClientPath = await authLaunchService.getRiotClientPath(); } catch {}
    return {
        riotClientPath,
        theme: appStore.get('theme', 'system'),
        autoLaunchValorant: appStore.get('autoLaunchValorant', true),
    };
});

ipcMain.handle('save-settings', async (event, settings) => {
    if (settings.theme) {
        appStore.set('theme', settings.theme);
        if (mainWindow) mainWindow.webContents.send('apply-theme', settings.theme);
    }
    if (typeof settings.autoLaunchValorant === 'boolean') {
        appStore.set('autoLaunchValorant', settings.autoLaunchValorant);
    }
    return { success: true };
});

// select-valorant-path removed: Riot Client is auto-detected from ProgramData/RiotClientInstalls.json

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

function sendStatus(accountId, status, message) {
    if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, status, message);
    // Auto-clear closed/error states after a few seconds
    if (status === 'closed' || status === 'error') {
        setTimeout(() => {
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
        }, status === 'error' ? 8000 : 5000);
    }
}

function startValorantWatcher(accountId) {
    stopValorantWatcher();
    let valorantFound = false, checks = 0, apiTried = false;
    valorantProcessWatcher = setInterval(async () => {
        checks++;
        try {
            const valRunning = await authLaunchService.isValorantRunning();

            if (valRunning && !valorantFound) {
                valorantFound = true;
                releaseLaunchLock();
                queueSnapshot(accountId);
                sendStatus(accountId, 'running');
            } else if (!valRunning && valorantFound) {
                queueSnapshot(accountId);
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
            } else if (!valorantFound && !apiTried && checks >= 2) {
                apiTried = true;
                authLaunchService.tryApiLaunch().catch(() => {});
            } else if (!valorantFound && checks > 30) {
                releaseLaunchLock();
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
            }
        } catch {
            if (checks > 10) { releaseLaunchLock(); sendStatus(accountId, 'closed'); stopValorantWatcher(); }
        }
    }, 3000);
}

function stopValorantWatcher() {
    if (valorantProcessWatcher) { clearInterval(valorantProcessWatcher); valorantProcessWatcher = null; }
}
