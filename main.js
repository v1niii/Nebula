const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const store = require('electron-store');

// Set app name and model ID so Windows shows "Nebula" in taskbar/task manager
app.setName('Nebula');
if (process.platform === 'win32') app.setAppUserModelId('com.v1niii.nebula');
const { AuthService } = require('./auth-service');
const { AuthLaunchService, KEY_PATTERNS, EXCLUDE_KEY_PATTERNS, ADDITIVE_CATEGORIES } = require('./auth-launch-service');
const gameService = require('./game-service');

const appStore = new store({ clearInvalidConfig: true });
const authService = new AuthService(appStore);
const authLaunchService = new AuthLaunchService(appStore, authService);

let mainWindow;
let tray = null;
let valorantProcessWatcher = null;
let watchedAccountId = null;

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
    tray.setToolTip('Nebula - Valorant Account Manager');
    rebuildTrayMenu();
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// Rebuilds the tray right-click menu with the current account list as
// quick-launch shortcuts. Called on startup and whenever the account list
// changes (add/remove/reorder/nickname).
function rebuildTrayMenu() {
    if (!tray) return;
    const accounts = authService.getAccounts() || [];
    const template = [
        { label: 'Show Nebula', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    ];
    if (accounts.length) {
        template.push({ type: 'separator' });
        template.push({ label: 'Launch', enabled: false });
        // Limit to 10 to keep the menu compact; users with more accounts can
        // still use the main window.
        for (const acc of accounts.slice(0, 10)) {
            const label = acc.nickname
                ? `${acc.nickname} (${acc.displayName || acc.username})`
                : (acc.displayName || acc.username || 'Unknown');
            template.push({
                label,
                click: () => launchFromTray(acc.id),
            });
        }
    }
    template.push({ type: 'separator' });
    template.push({ label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

// Kicks off a launch from the tray menu. Surfaces the main window first so
// the user sees the launching status indicator, then calls the same shared
// launch function the IPC handler uses.
function launchFromTray(accountId) {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    performLaunch(accountId).catch(e => console.warn('[tray] launch failed:', e?.message));
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

// Single-instance lock: if Nebula is already running, quit this new process
// and focus/restore the existing window instead. Without this, every launch
// spawns a fresh tray icon and window, leaving orphans in Task Manager.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        createTray();
        if (process.env.NODE_ENV !== 'development') setupAutoUpdater();

        // Load the persisted name cache for the Match Info "yoinker" fallback.
        // Stored in userData so it survives across Nebula restarts and grows
        // organically as the user plays — every match adds new puuid → name
        // mappings that persist forever.
        const nameCachePath = path.join(app.getPath('userData'), 'name-cache.json');
        gameService.loadNameCache(nameCachePath).catch(() => {});

        // Proactive region self-heal: some accounts stick to a wrong stored
        // region because their live-API calls (rank, store) never succeed
        // on this session and so never flow through resolveLiveAuthTokens.
        // Walk every account once at startup, ask PAS for the real Valorant
        // region, and update the store. Silent on failure — accounts with
        // expired sessions are simply skipped and retried on next launch.
        setTimeout(() => { scanAllAccountRegions().catch(() => {}); }, 2000);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

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
        rebuildTrayMenu();
        return { success: true, account };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('import-current-account', async () => {
    try {
        const account = await authLaunchService.importCurrentAccount();
        rebuildTrayMenu();
        return account ? { success: true, account } : { success: false, error: 'Could not import account.' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('remove-account', async (event, accountId) => {
    try {
        await authService.removeAccount(accountId);
        await authLaunchService.deleteSnapshot(accountId);
        // Clear the in-memory region-verified flag so a re-import of the same
        // puuid runs the probe fresh instead of trusting a stale verdict.
        regionVerifiedThisSession.delete(accountId);
        rebuildTrayMenu();
        return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('set-nickname', async (event, accountId, nickname) => {
    const result = authService.setNickname(accountId, nickname);
    rebuildTrayMenu();
    return result;
});

ipcMain.handle('reorder-accounts', async (event, orderedIds) => {
    const result = authService.reorderAccounts(orderedIds);
    rebuildTrayMenu();
    return result;
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

// Shared launch entry point — invoked by both the `launch-valorant` IPC
// handler (from the main window) and the tray quick-launch menu. Returns the
// same shape so both callers can react consistently.
async function performLaunch(accountId) {
    if (launchInProgress) return { success: false, error: 'A launch is already in progress. Please wait.' };
    launchInProgress = true;
    // Stop the previous watcher and wait for any in-flight snapshot to complete BEFORE
    // we start overwriting the Riot Client directory with the new account's data.
    // Also reset the previously-watched account's UI state so it doesn't stay stuck on "Running".
    if (watchedAccountId && watchedAccountId !== accountId && mainWindow) {
        mainWindow.webContents.send('update-launch-status', watchedAccountId, 'idle');
    }
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
            }).catch((e) => {
                releaseLaunchLock();
                if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
                console.warn('Re-login flow failed:', e?.message || e);
            });
            return { success: false, error: 'Session expired. Please log in via the Riot Client — session will be saved automatically.', sessionExpired: true };
        }

        await authService.updateLastUsed(accountId);
        if (autoLaunch) {
            startValorantWatcher(accountId);
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
}

ipcMain.handle('launch-valorant', (event, accountId) => performLaunch(accountId));

ipcMain.handle('copy-cloud-settings', async (event, fromId, toId, categories) => {
    try {
        const fromAcc = authService.getAccountById(fromId);
        const toAcc = authService.getAccountById(toId);
        if (!fromAcc || !toAcc) throw new Error('Account not found.');

        // SAFETY: never write to RiotUserSettings.ini while Valorant is running.
        // Mid-session file writes are a Vanguard red flag and can trigger the
        // "VALORANT failed to launch" / temporary suspension screen.
        if (await authLaunchService.isValorantRunning()) {
            throw new Error('Close Valorant before copying settings.');
        }

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

        // Self-heal regions via PAS so the SGP shard routing below uses the
        // actual Valorant region for each side, not a stale userInfo-derived
        // guess from import time.
        const healRegion = async (accountId, current) => {
            if (regionVerifiedThisSession.has(accountId)) return current;
            const auth = accountId === fromId ? srcAuth : dstAuth;
            const probed = await authService._probeValorantRegion({
                accessToken: auth.accessToken,
                entitlementsToken: auth.entitlementsToken,
                puuid: accountId,
            });
            if (!probed) return current; // don't burn the retry budget on a failed probe
            regionVerifiedThisSession.add(accountId);
            if (probed !== current) {
                authService.updateAccountRegion(accountId, probed);
                return probed;
            }
            return current;
        };
        fromAcc.region = await healRegion(fromId, fromAcc.region);
        toAcc.region = await healRegion(toId, toAcc.region);

        // Build the flat list of pattern strings for every enabled category (used by
        // both the cloud backfill and the local .ini merge — keeps them in lockstep).
        // `additivePatterns` is a strict subset containing only the patterns whose
        // target values should never be wiped when source is empty (crosshair blob).
        const allCatKeys = Object.keys(KEY_PATTERNS);
        const cats = categories || Object.fromEntries(allCatKeys.map(k => [k, true]));
        const enabledPatterns = [];
        const additivePatterns = [];
        for (const cat of allCatKeys) {
            if (!cats[cat] || !KEY_PATTERNS[cat]?.length) continue;
            enabledPatterns.push(...KEY_PATTERNS[cat]);
            if (ADDITIVE_CATEGORIES.has(cat)) additivePatterns.push(...KEY_PATTERNS[cat]);
        }

        const [srcBlob, dstBlob] = await Promise.all([
            authService.getCloudSettings(srcAuth.accessToken, srcAuth.entitlementsToken, fromAcc.region),
            authService.getCloudSettings(dstAuth.accessToken, dstAuth.entitlementsToken, toAcc.region),
        ]);
        // Decode both blobs. Use the DESTINATION's compression method for the
        // encode round-trip so the uploaded blob matches what target's Valorant
        // client can read back — source and target can be in different legacy
        // formats, and mismatching them produces the in-game "Error retrieving
        // settings from server" error.
        const { settings: srcSettings } = authService._decodeSettingsBlob(srcBlob.data);
        const { settings: dstSettings, method: dstMethod } = authService._decodeSettingsBlob(dstBlob.data);

        // CRITICAL: Valorant only persists non-default values, and some keys
        // (MouseSensitivityADS/Zoomed, gamepad deadzones, etc.) never sync to cloud.
        // Backfill the source blob with local-file values so the mirror merge sees
        // the full picture — otherwise target's old cloud value survives and overrides
        // our local write on next launch.
        if (enabledPatterns.length) {
            const localShape = await authLaunchService.readLocalSettingsAsCloudShape(fromId, enabledPatterns);
            for (const arrName of ['floatSettings', 'boolSettings', 'stringSettings', 'intSettings']) {
                if (!srcSettings[arrName]) srcSettings[arrName] = [];
                for (const entry of localShape[arrName]) {
                    const idx = srcSettings[arrName].findIndex(s => s.settingEnum === entry.settingEnum);
                    if (idx >= 0) srcSettings[arrName][idx] = entry; // local file wins — it's the source of truth
                    else srcSettings[arrName].push(entry);
                }
            }
        }

        const merged = authService.mergeSelectiveSettings(srcSettings, dstSettings, cats, KEY_PATTERNS, EXCLUDE_KEY_PATTERNS, ADDITIVE_CATEGORIES);
        const newData = authService._encodeSettingsBlob(merged, dstMethod);
        await authService.putCloudSettings(dstAuth.accessToken, dstAuth.entitlementsToken, toAcc.region, { data: newData });

        // Local .ini merge runs the same pattern set against the per-account
        // RiotUserSettings.ini with mirror semantics (removing keys that source
        // doesn't have so Valorant re-defaults them).
        let localMergeWarning = null;
        if (enabledPatterns.length) {
            try {
                const localResult = await authLaunchService.mergeIniKeys(fromId, toId, 'RiotUserSettings.ini', enabledPatterns, additivePatterns);
                if (localResult.merged === 0 && localResult.removed === 0) {
                    localMergeWarning = 'Local file merge touched 0 keys — target account may have never launched Valorant on this PC.';
                }
            } catch (e) {
                localMergeWarning = `Local file merge failed: ${e.message}`;
            }
        }

        return { success: true, localMergeWarning };
    } catch (error) {
        console.error('[copy] failed:', error.message);
        return { success: false, error: error.message };
    }
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
        // Opt-in live API features — both default OFF. When off, the tabs are
        // hidden AND the IPC handlers refuse the request (no endpoint calls).
        enableStoreFeature: appStore.get('enableStoreFeature', false),
        enableMatchInfoFeature: appStore.get('enableMatchInfoFeature', false),
        // Optional Henrikdev API key for the community-cache name fallback.
        // Empty string = not configured = skip that fallback entirely.
        henrikdevApiKey: appStore.get('henrikdevApiKey', ''),
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
    if (typeof settings.enableStoreFeature === 'boolean') {
        appStore.set('enableStoreFeature', settings.enableStoreFeature);
    }
    if (typeof settings.enableMatchInfoFeature === 'boolean') {
        appStore.set('enableMatchInfoFeature', settings.enableMatchInfoFeature);
    }
    if (typeof settings.henrikdevApiKey === 'string') {
        appStore.set('henrikdevApiKey', settings.henrikdevApiKey.trim());
    }
    return { success: true };
});

// --- Live Valorant API IPC (gated by opt-in settings) ---

// Shared helper: fetch access + entitlements tokens for the given account.
// Prefers stored cookies, falls back to snapshot cookies, mirrors the
// copy-cloud-settings flow so the same auth path is reused.
// Self-heals the stored region via PAS once per session — fixes legacy
// accounts that were saved with the LoL affinity before PAS detection
// existed, without forcing the user to re-import.
const regionVerifiedThisSession = new Set();
async function resolveLiveAuthTokens(accountId) {
    const account = authService.getAccountById(accountId);
    if (!account) throw new Error('Account not found.');
    const stored = await authService.retrieveCookiesSecurely(accountId);
    let cookies = stored?.ssid ? stored : null;
    if (!cookies) {
        const snap = await authLaunchService.extractCookiesFromSnapshot(accountId);
        if (snap?.ssid) cookies = snap;
    }
    if (!cookies?.ssid) throw new Error('Session expired. Launch this account first.');
    const { accessToken, entitlementsToken } = await authService.getCloudAuthTokens(
        cookies.ssid, cookies.clid, cookies.csid, cookies.tdid
    );

    let region = account.region;
    if (!regionVerifiedThisSession.has(accountId)) {
        // Probe every pd shard in parallel and pick whichever returns
        // 200/404 for this puuid's MMR. This is the authoritative source —
        // PAS chat affinity can return chat-POP codes (e.g. `us-br1`) that
        // don't match the game region, so we don't trust it anymore.
        const probedRegion = await authService._probeValorantRegion({
            accessToken, entitlementsToken, puuid: account.id,
        });
        if (probedRegion) {
            regionVerifiedThisSession.add(accountId);
            if (probedRegion !== region) {
                console.log(`[main] region self-heal: ${account.displayName || accountId.slice(0, 8)} ${region} → ${probedRegion}`);
                authService.updateAccountRegion(accountId, probedRegion);
                region = probedRegion;
            }
        } else {
            console.warn(`[main] region probe failed for ${account.displayName || accountId.slice(0, 8)} — will retry on next call`);
        }
    }

    return { accessToken, entitlementsToken, puuid: account.id, region };
}

// Walk every stored account and ask PAS for the real Valorant region.
// Runs once shortly after startup so broken/stale region labels get fixed
// without waiting for the user to trigger a live-API call on each account.
// Silent per-account failures — any account we can't get tokens for is
// skipped and retried next launch.
async function scanAllAccountRegions() {
    const accounts = authService.getAccountsList?.() || authService.accounts || [];
    if (!accounts.length) return;
    console.log(`[main] region scan: probing ${accounts.length} account(s)`);
    let healed = 0, failed = 0;
    for (const acc of accounts) {
        if (regionVerifiedThisSession.has(acc.id)) continue;
        try {
            const stored = await authService.retrieveCookiesSecurely(acc.id);
            let cookies = stored?.ssid ? stored : null;
            if (!cookies) {
                const snap = await authLaunchService.extractCookiesFromSnapshot(acc.id);
                if (snap?.ssid) cookies = snap;
            }
            if (!cookies?.ssid) { failed++; continue; }
            const { accessToken, entitlementsToken } = await authService.getCloudAuthTokens(
                cookies.ssid, cookies.clid, cookies.csid, cookies.tdid
            );
            const probedRegion = await authService._probeValorantRegion({
                accessToken, entitlementsToken, puuid: acc.id,
            });
            if (!probedRegion) { failed++; continue; }
            regionVerifiedThisSession.add(acc.id);
            if (probedRegion !== acc.region) {
                console.log(`[main] region scan heal: ${acc.displayName || acc.id.slice(0, 8)} ${acc.region} → ${probedRegion}`);
                authService.updateAccountRegion(acc.id, probedRegion);
                healed++;
            }
        } catch (e) {
            failed++;
        }
    }
    console.log(`[main] region scan done: ${healed} healed, ${failed} skipped`);
    // Stored regions are fixed immediately; the renderer's account-list badge
    // catches up on the next fetch (launch, refresh, tab switch). Every live
    // API call reads region straight from `resolveLiveAuthTokens`, which
    // already uses the healed value — no stale data leaks into the backend.
}

ipcMain.handle('get-store', async (event, accountId) => {
    if (!appStore.get('enableStoreFeature', false)) {
        return { success: false, error: 'Store feature is disabled in settings.' };
    }
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const store = await gameService.getStore(ctx);
        return { success: true, store };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-match-info', async (event, accountId) => {
    if (!appStore.get('enableMatchInfoFeature', false)) {
        return { success: false, error: 'Match Info feature is disabled in settings.' };
    }
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const henrikdevApiKey = appStore.get('henrikdevApiKey', '');
        const info = await gameService.getMatchInfo(ctx, { henrikdevApiKey });
        return { success: true, match: info };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Rank badge lookup for a single account (used by Account Manager display).
// NOT gated by the Match Info feature toggle — a single rank fetch per account
// is lightweight, stays account-scoped, and is part of the core account
// management experience. The heavier Match Info surface is still gated.
ipcMain.handle('get-account-rank', async (event, accountId) => {
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const rank = await gameService.getAccountRank(ctx);
        return { success: true, rank };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Today's session stats: W/L, K/D, RR delta. Like rank badges, this is a
// core account-management feature and is NOT gated behind the Match Info flag.
ipcMain.handle('get-session-stats', async (event, accountId) => {
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const session = await gameService.getSessionStats(ctx);
        return { success: true, session };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Full player stats for the click-to-inspect modal in Match Info.
// Auth comes from the VIEWING account — we use its tokens to query any
// target puuid's MMR / match history.
ipcMain.handle('get-player-stats', async (event, viewerAccountId, targetPuuid) => {
    if (!appStore.get('enableMatchInfoFeature', false)) {
        return { success: false, error: 'Match Info feature is disabled.' };
    }
    try {
        const ctx = await resolveLiveAuthTokens(viewerAccountId);
        const stats = await gameService.getPlayerStats(ctx, targetPuuid);
        return { success: true, stats };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Full skin catalog for the "browse skins" wishlist dialog. When called
// with an accountId, cross-references the static catalog against Riot's
// live /store/v1/offers to filter out battlepass, VCT, and other non-buyable
// skins — only keeping items that are actually purchasable with VP.
// Both the static catalog and the offers list are cached session-lifetime.
ipcMain.handle('get-skin-catalog', async (event, accountId) => {
    try {
        const catalog = await gameService.ensureSkinCatalog();
        if (!accountId) return { success: true, catalog };
        try {
            const ctx = await resolveLiveAuthTokens(accountId);
            const buyable = await gameService.fetchBuyableSkinOfferIds(ctx);
            if (buyable.size === 0) {
                // Offers fetch failed or returned empty — fall back to unfiltered
                // so the user still sees something.
                return { success: true, catalog };
            }
            const filtered = catalog.filter(s => buyable.has(s.uuid));
            return { success: true, catalog: filtered };
        } catch {
            // Auth failure — still return the unfiltered catalog
            return { success: true, catalog };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- Store wishlist ---
// Stored via electron-store as { [skinLevelUuid]: { name, addedAt } }.
// The renderer checks daily store items against this on fetch and shows a
// badge when a wishlisted item appears in any account's store.
ipcMain.handle('get-wishlist', async () => {
    const stored = appStore.get('storeWishlist', {});
    // Auto-prune entries that aren't in the current browseable catalog —
    // these are orphans from older versions when the catalog had different
    // filtering (e.g. VCT skins were once buyable, now excluded). Without
    // this prune they show up in the wishlist count but are invisible in
    // the UI, so the user sees "1 item" but can't find/remove it.
    try {
        const catalog = await gameService.ensureSkinCatalog();
        const validUuids = new Set(catalog.map(s => s.uuid));
        const cleaned = {};
        let removed = 0;
        for (const [uuid, entry] of Object.entries(stored)) {
            if (validUuids.has(uuid)) cleaned[uuid] = entry;
            else removed++;
        }
        if (removed > 0) {
            appStore.set('storeWishlist', cleaned);
            console.log(`[main] wishlist auto-prune: removed ${removed} orphaned entries`);
        }
        return { success: true, wishlist: cleaned };
    } catch {
        // Catalog fetch failed — return the stored wishlist as-is rather
        // than risk showing nothing.
        return { success: true, wishlist: stored };
    }
});

ipcMain.handle('add-to-wishlist', (event, { uuid, name }) => {
    if (!uuid) return { success: false, error: 'uuid required' };
    const current = appStore.get('storeWishlist', {});
    current[uuid] = { name: name || 'Unknown Skin', addedAt: Date.now() };
    appStore.set('storeWishlist', current);
    return { success: true };
});

ipcMain.handle('remove-from-wishlist', (event, uuid) => {
    if (!uuid) return { success: false, error: 'uuid required' };
    const current = appStore.get('storeWishlist', {});
    delete current[uuid];
    appStore.set('storeWishlist', current);
    return { success: true };
});

// --- Player blacklist ---
// Stored via electron-store under the key 'playerBlacklist' as an object
// keyed by puuid: { [puuid]: { name, reason, addedAt } }. Used by Match Info
// to warn the user when a previously-flagged player shows up in their match.
ipcMain.handle('get-blacklist', () => {
    return { success: true, blacklist: appStore.get('playerBlacklist', {}) };
});

ipcMain.handle('add-to-blacklist', (event, { puuid, name, reason }) => {
    if (!puuid) return { success: false, error: 'puuid required' };
    const current = appStore.get('playerBlacklist', {});
    current[puuid] = { name: name || 'Unknown', reason: reason || '', addedAt: Date.now() };
    appStore.set('playerBlacklist', current);
    return { success: true };
});

ipcMain.handle('remove-from-blacklist', (event, puuid) => {
    if (!puuid) return { success: false, error: 'puuid required' };
    const current = appStore.get('playerBlacklist', {});
    delete current[puuid];
    appStore.set('playerBlacklist', current);
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

// Poll every 3s for Valorant process + auth match. Timeout at 60 checks = 3 minutes:
// cold boot + Vanguard init + AV scanning can easily push launch past 90s on slower machines.
const WATCHER_TICK_MS = 3000;
const WATCHER_MAX_CHECKS = 60; // 3 minutes
const WATCHER_API_LAUNCH_CHECK = 2; // ~6s before trying the local API fallback

function startValorantWatcher(accountId) {
    stopValorantWatcher();
    watchedAccountId = accountId;
    let valorantFound = false, checks = 0, apiTried = false;
    valorantProcessWatcher = setInterval(async () => {
        checks++;
        try {
            const valRunning = await authLaunchService.isValorantRunning();

            if (valRunning && !valorantFound) {
                // Verify the running Riot Client is authed as THIS account
                // (prevents false positives from leftover Valorant from the previous account)
                const auth = await authLaunchService.getAuthenticatedAccount();
                if (!auth || auth.puuid !== accountId) return; // wrong account / not yet authed
                valorantFound = true;
                releaseLaunchLock();
                queueSnapshot(accountId);
                sendStatus(accountId, 'running');
            } else if (!valRunning && valorantFound) {
                queueSnapshot(accountId);
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
            } else if (!valorantFound && !apiTried && checks >= WATCHER_API_LAUNCH_CHECK) {
                apiTried = true;
                authLaunchService.tryApiLaunch().catch(() => {});
            } else if (!valorantFound && checks > WATCHER_MAX_CHECKS) {
                releaseLaunchLock();
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
            }
        } catch {
            if (checks > 10) { releaseLaunchLock(); sendStatus(accountId, 'closed'); stopValorantWatcher(); }
        }
    }, WATCHER_TICK_MS);
}

function stopValorantWatcher() {
    if (valorantProcessWatcher) { clearInterval(valorantProcessWatcher); valorantProcessWatcher = null; }
    watchedAccountId = null;
}
