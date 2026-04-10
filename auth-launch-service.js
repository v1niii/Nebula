const fs = require('fs').promises;
const path = require('path');
const yaml = require('yaml');
const fetch = require('node-fetch');
const https = require('https');
const { exec, spawn } = require('child_process');
const os = require('os');

const RIOT_CLIENT_INSTALLS_PATH = path.join(process.env.ProgramData, 'Riot Games', 'RiotClientInstalls.json');
const RIOT_CLIENT_DATA_PATH_BASE = path.join(process.env.LOCALAPPDATA, 'Riot Games');
const RIOT_CLIENT_LOCKFILE = 'Riot Client/Config/lockfile';
const RIOT_CLIENT_BETA_LOCKFILE = 'Beta/Config/lockfile';
const SNAPSHOT_BASE = path.join(process.env.APPDATA || process.env.HOME, 'nebula', 'snapshots');

const AUTH_SNAPSHOT_FILES = [
    { rel: 'Data/RiotClientPrivateSettings.yaml' },
    { rel: 'Data/RiotGamesPrivateSettings.yaml' },
    { rel: 'Config/RiotClientSettings.yaml' },
];
const AUTH_SNAPSHOT_DIRS = [
    { rel: 'Data/Cookies' },
    { rel: 'Data/Sessions' },
];

// Per-category key patterns for surgical settings merges. Substring match (case-sensitive).
// Tested against the suffix of actual Valorant setting enums like
// `EAresFloatSettingName::MouseSensitivityADS`. Never include account-bound or
// progress/flag keys — those go in EXCLUDE_KEY_PATTERNS.
const KEY_PATTERNS = {
    crosshair: [
        'Crosshair',
        'SavedCrosshairProfileData',
        'FadeCrosshairWithFiringError',
    ],
    sensitivity: [
        'MouseSensitivity',          // MouseSensitivity, MouseSensitivityADS, MouseSensitivityZoomed
        'MouseInverted',
        'Gamepad',                   // GamepadBaseRotationSpeedX/Y, deadzones
    ],
    audio: [
        'Volume',                    // OverallVolume, VoiceVolume, SoundEffectsVolume, MusicVolume, etc.
        'HRTF',
        'Mic',                       // MicVolume, MicSensitivityThreshold
        'VoipDucks',                 // VoipDucksMusicVolume, VoipDucksVOFlavor
        'MuteMusicOnAppWindowDeactivate',
        'EnableHRTF',
        'VoiceDevice',               // VoiceDeviceCaptureHandle, VoiceDeviceRenderHandle
        'PushToTalk',                // PushToTalkEnabled, PushToTalkKey, TeamPushToTalkKey
        'TeamVoiceChatEnabled',
        'CustomPartyVoiceChatEnabled',
    ],
    video: [
        // Per-account graphics quality (NOT resolution — that's in the global WindowsClient/GameUserSettings.ini)
        'AntiAliasing',
        'AnisotropicFiltering',
        'BloomQuality',
        'DetailQuality',
        'MaterialQuality',
        'TextureQuality',
        'UIQuality',
        'ShadowsEnabled',
        'VignetteEnabled',
        'DisableDistortion',
        'ImproveClarity',
        'EnableInstabilityIndicators',
        'AdaptiveSharpenEnabled',
        'NvidiaReflexLowLatencySetting',
        'LimitFramerate',            // LimitFramerateInBackground/InMenu/OnBattery
    ],
    minimap: [
        'Minimap',                   // MinimapFixedRotation, MinimapTranslates, MinimapSize, MinimapZoom
        'ShowKeybindsOnMinimap',
    ],
    hud: [
        'AlwaysShowInventoryWidgets',
        'PlayerPerfShow',            // PlayerPerfShowFrameRate / NetworkRtt / PacketLoss / etc.
        'ShowBlood',
        'ShowBulletTracers',
        'ShowCorpses',
        'ColorBlindMode',
        'SpectatorCountWidgetVisible',
        'CollectionShowOwnedOnly',   // collection UI toggle
    ],
    gameplay: [
        'AutoEquip',                 // AutoEquipSkipsMelee, AutoEquipPrioritizeStrongest
        'AutoRescopeSniper',
        'CycleThroughSniperZoomLevels',
        'HoldInputForADS',
        'HoldInputForSniperScopes',
        'SniperToggleHoldInputCycles',
        'AESWheelHold',              // AESWheelHoldDelayMS, AESWheelHoldEnabled
        'PingWheelHold',             // PingWheelHoldDelayMS
        'ShootingRange',             // all shooting range settings
        'Observer',                  // ObserverRunSpeedModifier, WalkSpeed, ObserversSeeBlinds
    ],
    // Cloud-only via actionMappings/axisMappings — handled in mergeSelectiveSettings,
    // not by .ini key patterns. Listed here for symmetry / dialog wiring.
    keybinds: [],
};

// Defense-in-depth: never copy these keys regardless of category. Account-bound,
// progress flags, machine-local identifiers, region pinning, etc. Copying any of
// these across accounts is what gets you the "VALORANT failed to launch" / temporary
// suspension screen.
const EXCLUDE_KEY_PATTERNS = [
    'HasAccepted',
    'HasEver',
    'HasSeen',
    'LastSeen',
    'LastAccepted',
    'LocalSettingsVersion',
    'RoamingSettingsVersion',
    'PreferredGamePods',
    'Premier',
    'ContextAware',
    'CodeOfConduct',
];

class AuthLaunchService {
    constructor(store, authService) {
        this.store = store;
        this.authService = authService;
    }

    // --- Riot Client path detection ---

    async getRiotClientPath() {
        if (!os.platform().startsWith('win')) throw new Error('Windows only.');
        try {
            const data = JSON.parse(await fs.readFile(RIOT_CLIENT_INSTALLS_PATH, 'utf-8'));
            const tryPath = async (p) => { if (p && typeof p === 'string') { try { await fs.access(p); return p; } catch {} } return null; };
            for (const key of ['rc_live', 'rc_default', 'rc_beta', 'rc_esports']) { const f = await tryPath(data[key]); if (f) return f; }
            if (data.associated_client) for (const p of Object.values(data.associated_client)) { const f = await tryPath(p); if (f) return f; }
            if (data.patchlines) for (const p of Object.values(data.patchlines)) { const f = await tryPath(p); if (f) return f; }
            throw new Error('Riot Client not found.');
        } catch (e) { throw new Error(`Could not find Riot Client. (${e.message})`); }
    }

    // --- Lockfile & local API ---

    async readLockfile() {
        for (const rel of [RIOT_CLIENT_BETA_LOCKFILE, RIOT_CLIENT_LOCKFILE]) {
            try {
                const content = await fs.readFile(path.join(RIOT_CLIENT_DATA_PATH_BASE, rel), 'utf-8');
                const parts = content.split(':');
                if (parts.length >= 4) return { port: parts[2], password: parts[3] };
            } catch {}
        }
        return null;
    }

    async _localApi(method, endpoint, body) {
        const lockfile = await this.readLockfile();
        if (!lockfile) return null;
        const agent = new https.Agent({ rejectUnauthorized: false });
        const opts = {
            method, agent,
            headers: { 'Authorization': `Basic ${Buffer.from(`riot:${lockfile.password}`).toString('base64')}`, 'Content-Type': 'application/json' },
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        return fetch(`https://127.0.0.1:${lockfile.port}${endpoint}`, opts);
    }

    async getAuthenticatedAccount() {
        // Primary: entitlements endpoint (full token + PUUID in one call)
        try {
            const r = await this._localApi('GET', '/entitlements/v1/token');
            if (r && r.ok) {
                const d = await r.json();
                if (d.accessToken && d.subject) return { puuid: d.subject, accessToken: d.accessToken };
            }
        } catch {}
        // Fallback: rso-auth (works when entitlements service isn't fully loaded, e.g. tray mode)
        try {
            const tokenRes = await this._localApi('GET', '/rso-auth/v1/authorization/access-token');
            if (tokenRes && tokenRes.ok) {
                const tokenData = await tokenRes.json();
                if (tokenData.accessToken) {
                    const userRes = await this._localApi('GET', '/rso-auth/v1/authorization/userinfo');
                    if (userRes && userRes.ok) {
                        const userData = await userRes.json();
                        // userInfo can be a JSON string nested inside the response
                        const info = typeof userData.userInfo === 'string' ? JSON.parse(userData.userInfo) : (userData.userInfo || userData);
                        if (info.sub) return { puuid: info.sub, accessToken: tokenData.accessToken };
                    }
                }
            }
        } catch {}
        return null;
    }

    async waitForAuth(timeoutMs = 60000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const auth = await this.getAuthenticatedAccount();
            if (auth) return auth;
            await new Promise(r => setTimeout(r, 1000));
        }
        return null;
    }

    // --- Snapshot / Restore ---

    _riotClientDir() { return path.join(RIOT_CLIENT_DATA_PATH_BASE, 'Riot Client'); }
    _snapshotDir(accountId) { return path.join(SNAPSHOT_BASE, accountId); }

    async hasSnapshot(accountId) {
        try { await fs.access(this._snapshotDir(accountId)); return true; } catch { return false; }
    }

    async snapshotAccountData(accountId) {
        const srcBase = this._riotClientDir();
        const destBase = this._snapshotDir(accountId);
        await fs.rm(destBase, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(destBase, { recursive: true });

        for (const { rel } of AUTH_SNAPSHOT_FILES) {
            try { await fs.mkdir(path.dirname(path.join(destBase, rel)), { recursive: true }); await fs.copyFile(path.join(srcBase, rel), path.join(destBase, rel)); }
            catch (e) { console.warn(`Snapshot skip ${rel}: ${e.code}`); }
        }
        for (const { rel } of AUTH_SNAPSHOT_DIRS) {
            try { await fs.cp(path.join(srcBase, rel), path.join(destBase, rel), { recursive: true }); }
            catch (e) { console.warn(`Snapshot skip dir ${rel}: ${e.code}`); }
        }
        console.log(`Snapshot saved for ${accountId.substring(0, 8)}`);
    }

    async restoreAccountData(accountId) {
        const srcBase = this._snapshotDir(accountId);
        const destBase = this._riotClientDir();

        for (const { rel } of AUTH_SNAPSHOT_FILES) {
            try { await fs.mkdir(path.dirname(path.join(destBase, rel)), { recursive: true }); await fs.copyFile(path.join(srcBase, rel), path.join(destBase, rel)); }
            catch (e) { console.warn(`Restore skip ${rel}: ${e.code}`); }
        }
        for (const { rel } of AUTH_SNAPSHOT_DIRS) {
            try { await fs.rm(path.join(destBase, rel), { recursive: true, force: true }).catch(() => {}); await fs.cp(path.join(srcBase, rel), path.join(destBase, rel), { recursive: true }); }
            catch (e) { console.warn(`Restore skip dir ${rel}: ${e.code}`); }
        }
        console.log(`Snapshot restored for ${accountId.substring(0, 8)}`);
    }

    async deleteSnapshot(accountId) {
        await fs.rm(this._snapshotDir(accountId), { recursive: true, force: true }).catch(() => {});
    }

    // --- Launch Valorant ---

    // Returns { sessionExpired: true } if user needs to re-login
    async launchValorant(account, autoLaunchValorant = true) {
        if (!account?.id) throw new Error('Invalid account.');
        const hasSnap = await this.hasSnapshot(account.id);
        if (!hasSnap) throw new Error('No saved session. Remove and re-add the account.');

        console.log(`Launching account ${account.id.substring(0, 8)}...`);

        await this.closeRiotProcesses();
        await new Promise(r => setTimeout(r, 3000));
        await this.restoreAccountData(account.id);

        const riotDir = this._riotClientDir();
        for (const f of ['Config/lockfile', 'Config/lockfile_']) await fs.unlink(path.join(riotDir, f)).catch(() => {});
        for (const lf of [RIOT_CLIENT_LOCKFILE, RIOT_CLIENT_BETA_LOCKFILE]) await fs.unlink(path.join(RIOT_CLIENT_DATA_PATH_BASE, lf)).catch(() => {});

        const exePath = await this.getRiotClientPath();
        const args = autoLaunchValorant ? ['--launch-product=valorant', '--launch-patchline=live'] : [];
        spawn(exePath, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) }).unref();

        // Wait up to 20s for the local Riot Client API to come up authed.
        // 10s was too tight on cold starts / AV scanning / slow disks → false expired.
        const authResult = await this.waitForAuth(20000);
        if (authResult) return { sessionExpired: false };

        // Local API didn't come up in time. Before doing anything destructive,
        // verify via SSID against Riot's auth endpoint — if cookies are still valid,
        // the issue is just slow startup, not an expired session.
        console.log('Local auth timeout — verifying session via SSID before declaring expired...');
        try {
            const cookies = await this.extractCookiesFromSnapshot(account.id);
            if (cookies?.ssid && this.authService) {
                const ssidResult = await this.authService._performSSIDAuth(cookies.ssid, cookies.clid, cookies.csid, cookies.tdid);
                if (ssidResult.success || ssidResult.transient) {
                    // Session is still valid (or we can't tell). Give the local client more time
                    // instead of nuking the auth state.
                    console.log('SSID still valid — extending wait for slow Riot Client startup.');
                    const extended = await this.waitForAuth(30000);
                    if (extended) return { sessionExpired: false };
                    // Still nothing — return success anyway and let the user retry.
                    // We refuse to wipe the snapshot's auth on a timeout when SSID looks fine.
                    return { sessionExpired: false };
                }
            }
        } catch (e) { console.warn('SSID verification failed:', e.message); }

        // SSID definitively expired → safe to clear and prompt re-login
        console.log('Session truly expired. Reopening login page...');
        await this.closeRiotProcesses();
        await new Promise(r => setTimeout(r, 2000));

        const authYamlPath = path.join(riotDir, 'Data', 'RiotGamesPrivateSettings.yaml');
        try {
            const content = await fs.readFile(authYamlPath, 'utf-8');
            const parsed = yaml.parse(content);
            if (parsed?.['riot-login']) parsed['riot-login'].persist = null;
            await fs.writeFile(authYamlPath, yaml.stringify(parsed), 'utf-8');
        } catch {}
        for (const f of ['Config/lockfile', 'Config/lockfile_']) await fs.unlink(path.join(riotDir, f)).catch(() => {});

        spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) }).unref();
        return { sessionExpired: true };
    }

    // Called after user re-logs in on expired session
    async handleReLogin(accountId) {
        const auth = await this.waitForAuth(5 * 60 * 1000);
        if (!auth) throw new Error('Login timed out.');
        await new Promise(r => setTimeout(r, 3000));
        await this.snapshotAccountData(accountId);
        console.log('Session refreshed and saved.');
        await this.closeRiotProcesses();
    }

    // Fallback: use the product-launcher API if Valorant didn't auto-launch from --launch-product.
    // Respawning with --launch-product doesn't help: single-instance detection routes the args
    // to the running instance which doesn't honor them mid-session.
    async tryApiLaunch() {
        try {
            const r = await this._localApi('POST', '/product-launcher/v1/products/valorant/patchlines/live', {});
            if (r && r.ok) { console.log('Valorant launched via API.'); return true; }
        } catch {}
        return false;
    }

    // --- Add / Import accounts ---

    // Read the live RiotGamesPrivateSettings.yaml directly. Works regardless of UI state (tray, hidden, etc).
    async _readLiveRiotCookies() {
        const yamlPath = path.join(this._riotClientDir(), 'Data', 'RiotGamesPrivateSettings.yaml');
        try {
            const content = await fs.readFile(yamlPath, 'utf-8');
            const parsed = yaml.parse(content);
            const cookies = parsed?.['riot-login']?.persist?.session?.cookies || [];
            const map = {};
            for (const c of cookies) { if (c.name && c.value) map[c.name] = c.value; }
            const tdid = map.tdid || parsed?.['rso-authenticator']?.tdid?.value || '';
            if (!map.sub || !map.ssid) return null;
            return { puuid: map.sub, ssid: map.ssid, clid: map.clid || '', csid: map.csid || '', tdid, sub: map.sub };
        } catch { return null; }
    }

    async importCurrentAccount() {
        // Primary: read the YAML file directly (works in any UI state)
        let puuid = null;
        let accessToken = '';
        const liveCookies = await this._readLiveRiotCookies();
        if (liveCookies) {
            puuid = liveCookies.puuid;
            // Use SSID reauth to get a fresh access token for fetching user info (display name + region)
            try {
                const refreshed = await this.authService._performSSIDAuth(liveCookies.ssid, liveCookies.clid, liveCookies.csid, liveCookies.tdid);
                if (refreshed.success) accessToken = refreshed.accessToken;
            } catch {}
        }

        // Fallback: try the local API if YAML wasn't found or had no session
        if (!puuid) {
            const auth = await this.getAuthenticatedAccount();
            if (!auth) throw new Error('Riot Client is not running or not logged in. Open the Riot Client and log in first.');
            puuid = auth.puuid;
            accessToken = auth.accessToken;
        }

        const result = await this.authService.addAccountFromTokens(accessToken, '', {}, puuid);
        if (!result.success) throw new Error(result.error || 'Failed to add account.');
        await this.snapshotAccountData(result.account.id);
        return result.account;
    }

    async addViaRiotClient() {
        // Always kill and clear auth so the login page shows for a fresh account
        await this.closeRiotProcesses();
        await new Promise(r => setTimeout(r, 2000));

        // Clear session but KEEP the tdid (trusted device ID) to avoid 2FA prompts
        const riotDir = this._riotClientDir();
        const authYamlPath = path.join(riotDir, 'Data', 'RiotGamesPrivateSettings.yaml');
        try {
            const content = await fs.readFile(authYamlPath, 'utf-8');
            const parsed = yaml.parse(content);
            // Preserve rso-authenticator.tdid, clear riot-login session
            if (parsed?.['riot-login']) parsed['riot-login'].persist = null;
            await fs.writeFile(authYamlPath, yaml.stringify(parsed), 'utf-8');
        } catch {
            // If file doesn't exist, that's fine - login page will show
        }
        for (const f of ['Data/RiotClientPrivateSettings.yaml', 'Config/lockfile', 'Config/lockfile_']) {
            await fs.unlink(path.join(riotDir, f)).catch(() => {});
        }

        const exePath = await this.getRiotClientPath();
        spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) }).unref();

        console.log('Waiting for Riot Client login...');
        let auth = null;
        const start = Date.now();
        let windowSeen = false;
        let windowGoneSince = 0;

        while (Date.now() - start < 5 * 60 * 1000) {
            auth = await this.getAuthenticatedAccount();
            if (auth) break;

            const [servicesRunning, windowVisible] = await Promise.all([
                this._isProcessRunning('RiotClientServices.exe'),
                this._hasVisibleRiotClientWindow(),
            ]);

            // User fully quit Riot Client
            if (windowSeen && !servicesRunning) {
                throw new Error('Riot Client was closed before login completed.');
            }

            if (windowVisible) {
                windowSeen = true;
                windowGoneSince = 0;
            } else if (windowSeen) {
                if (windowGoneSince === 0) windowGoneSince = Date.now();
                // Window was visible and has been gone for >4 seconds = user closed/minimized to tray
                if (Date.now() - windowGoneSince > 4000) {
                    throw new Error('Riot Client window was closed before login completed. Try again.');
                }
            }

            await new Promise(r => setTimeout(r, 2000));
        }
        if (!auth) throw new Error('Login timed out.');

        const result = await this.authService.addAccountFromTokens(auth.accessToken, '', {});
        if (!result.success) throw new Error(result.error || 'Failed to save account.');

        await new Promise(r => setTimeout(r, 3000));
        await this.snapshotAccountData(result.account.id);
        await this.closeRiotProcesses();
        return result.account;
    }

    // --- Process management ---

    async closeRiotProcesses() {
        const procs = ['RiotClientServices.exe', 'VALORANT-Win64-Shipping.exe', 'RiotClientUx.exe', 'RiotClientUxRender.exe', 'RiotClientCrashHandler.exe'];
        if (os.platform() !== 'win32') return;
        const cmd = `taskkill /F ${procs.map(p => `/IM ${p}`).join(' ')} /T`;
        await new Promise(r => exec(cmd, () => r()));
        await new Promise(r => setTimeout(r, 1000));
        // Verify ALL processes are dead. Valorant is the slowest to exit (Vanguard unload, etc).
        for (let i = 0; i < 10; i++) {
            const [svc, val, ux] = await Promise.all([
                this._isProcessRunning('RiotClientServices.exe'),
                this._isProcessRunning('VALORANT-Win64-Shipping.exe'),
                this._isProcessRunning('RiotClientUx.exe'),
            ]);
            if (!svc && !val && !ux) return;
            await new Promise(r => exec(cmd, () => r()));
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    async isValorantRunning() { return this._isProcessRunning('VALORANT-Win64-Shipping.exe'); }
    async isRiotClientRunning() { return this._isProcessRunning('RiotClientServices.exe'); }

    _isProcessRunning(processName) {
        return new Promise((resolve) => {
            if (os.platform() !== 'win32') return resolve(false);
            exec(`tasklist /FI "IMAGENAME eq ${processName}"`, (error, stdout) => {
                if (error) return resolve(false);
                resolve(stdout.toLowerCase().includes(processName.replace('.exe', '').toLowerCase()));
            });
        });
    }

    // Returns true if any "Riot Client.exe" instance has a visible window titled "Riot Client"
    _hasVisibleRiotClientWindow() {
        return new Promise((resolve) => {
            if (os.platform() !== 'win32') return resolve(false);
            exec(`tasklist /FI "IMAGENAME eq Riot Client.exe" /V /FO CSV /NH`, (error, stdout) => {
                if (error) return resolve(false);
                const lines = stdout.trim().split('\n');
                for (const line of lines) {
                    const cols = line.split('","').map(c => c.replace(/^"|"$/g, '').trim());
                    if (cols.length < 9) continue;
                    const title = cols[8];
                    // Visible windows have a real title; hidden ones show "N/A"
                    if (title && title !== 'N/A') return resolve(true);
                }
                resolve(false);
            });
        });
    }

    // Returns true if processName has at least one instance with a visible window (not hidden in tray)
    _hasVisibleWindow(processName) {
        return new Promise((resolve) => {
            if (os.platform() !== 'win32') return resolve(false);
            exec(`tasklist /FI "IMAGENAME eq ${processName}" /V /FO CSV /NH`, (error, stdout) => {
                if (error) return resolve(false);
                // CSV columns: "Image","PID","Session","Session#","Mem","Status","User","CPU","Window Title"
                const lines = stdout.trim().split('\n');
                for (const line of lines) {
                    const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
                    if (cols.length < 9) continue;
                    const title = cols[8];
                    // "N/A" means hidden window, anything else (including empty) means visible
                    if (title && title !== 'N/A') return resolve(true);
                }
                resolve(false);
            });
        });
    }

    // --- Copy game settings ---

    // Reads a source account's RiotUserSettings.ini and converts each pattern-matching
    // key into cloud-blob shape: { floatSettings: [...], boolSettings: [...], ... }.
    // Used to backfill the cloud blob with values that Valorant only writes locally
    // (e.g. MouseSensitivityADS, MouseSensitivityZoomed, gamepad deadzones) so the
    // cloud sync on next launch doesn't override our local merge with stale values.
    async readLocalSettingsAsCloudShape(puuid, keyPatterns) {
        const result = { floatSettings: [], boolSettings: [], stringSettings: [], intSettings: [] };
        const base = path.join(process.env.LOCALAPPDATA, 'VALORANT', 'Saved', 'Config');
        let dir;
        try {
            const entries = await fs.readdir(base);
            const match = entries.find(e => e.toLowerCase().startsWith(puuid.toLowerCase()));
            if (!match) return result;
            dir = path.join(base, match, 'Windows');
        } catch { return result; }

        let content;
        try { content = await fs.readFile(path.join(dir, 'RiotUserSettings.ini'), 'utf-8'); }
        catch { return result; }

        const isExcluded = (key) => EXCLUDE_KEY_PATTERNS.some(p => key.toLowerCase().includes(p.toLowerCase()));
        const matches = (key) => !isExcluded(key) && keyPatterns.some(p => key.toLowerCase().includes(p.toLowerCase()));

        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('[') || line.startsWith(';') || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            const key = line.slice(0, eq).trim();
            const rawValue = line.slice(eq + 1);
            if (!matches(key)) continue;

            // Type from key prefix (EAresFloat / EAresBool / EAresInt / EAresString)
            if (key.startsWith('EAresFloatSettingName::')) {
                const v = parseFloat(rawValue);
                if (!Number.isNaN(v)) result.floatSettings.push({ settingEnum: key, value: v });
            } else if (key.startsWith('EAresBoolSettingName::')) {
                result.boolSettings.push({ settingEnum: key, value: /^true$/i.test(rawValue.trim()) });
            } else if (key.startsWith('EAresIntSettingName::')) {
                const v = parseInt(rawValue, 10);
                if (!Number.isNaN(v)) result.intSettings.push({ settingEnum: key, value: v });
            } else if (key.startsWith('EAresStringSettingName::')) {
                result.stringSettings.push({ settingEnum: key, value: rawValue });
            }
        }
        return result;
    }

    // Mirror source's pattern-matching keys onto target RiotUserSettings.ini.
    // Semantics:
    //   - keys matching the pattern in source → copy/overwrite in target
    //   - keys matching the pattern in target but NOT in source → DELETE from target
    //     (Valorant will recreate them at default on next launch — matches source's
    //     implicit default, since Valorant only persists non-default values)
    //   - keys NOT matching the pattern → left alone
    async mergeIniKeys(fromPuuid, toPuuid, fileName, keyPatterns) {
        const { src, dst } = await this._resolveValorantConfigDirs(fromPuuid, toPuuid);
        const srcPath = path.join(src, fileName);
        const dstPath = path.join(dst, fileName);
        let srcContent, dstContent;
        try { srcContent = await fs.readFile(srcPath, 'utf-8'); } catch { return { merged: 0, removed: 0 }; }
        try { dstContent = await fs.readFile(dstPath, 'utf-8'); } catch { dstContent = ''; }

        const isExcluded = (key) => EXCLUDE_KEY_PATTERNS.some(p => key.toLowerCase().includes(p.toLowerCase()));
        const matches = (key) => !isExcluded(key) && keyPatterns.some(p => key.toLowerCase().includes(p.toLowerCase()));

        // Parse source into { section: { key: rawLine } }. Section tracking is
        // per-pattern — most Riot config uses a single [Settings] section anyway.
        const srcMap = {};
        let curSection = '';
        for (const rawLine of srcContent.split(/\r?\n/)) {
            const line = rawLine.trim();
            const sec = line.match(/^\[(.+)\]$/);
            if (sec) { curSection = sec[1]; srcMap[curSection] = srcMap[curSection] || {}; continue; }
            const kv = line.match(/^([^=;#\s][^=]*?)=(.*)$/);
            if (kv && matches(kv[1].trim())) {
                srcMap[curSection] = srcMap[curSection] || {};
                srcMap[curSection][kv[1].trim()] = rawLine;
            }
        }

        // Walk target: replace matching-keys-in-both, DELETE matching-keys-not-in-source.
        // Build a new line array instead of in-place splice to keep indices sane.
        const consumed = new Set();
        let merged = 0, removed = 0;
        const outLines = [];
        const dstSections = new Map(); // section → index in OUT array of last non-empty line in that section
        let tgtSection = '';

        for (const rawLine of dstContent.split(/\r?\n/)) {
            const line = rawLine.trim();
            const sec = line.match(/^\[(.+)\]$/);
            if (sec) {
                tgtSection = sec[1];
                outLines.push(rawLine);
                dstSections.set(tgtSection, outLines.length - 1);
                continue;
            }
            const kv = line.match(/^([^=;#\s][^=]*?)=(.*)$/);
            if (kv) {
                const key = kv[1].trim();
                if (matches(key)) {
                    const srcLine = srcMap[tgtSection]?.[key];
                    if (srcLine !== undefined) {
                        outLines.push(srcLine);
                        consumed.add(`${tgtSection}::${key}`);
                        merged++;
                    } else {
                        // Matching pattern but not in source → drop it (Valorant will re-default on launch)
                        removed++;
                        continue;
                    }
                } else {
                    outLines.push(rawLine);
                }
            } else {
                outLines.push(rawLine);
            }
            if (outLines.length && outLines[outLines.length - 1].trim()) {
                dstSections.set(tgtSection, outLines.length - 1);
            }
        }

        // Append source-only keys (matching pattern, not yet in target) to their section.
        for (const [section, keys] of Object.entries(srcMap)) {
            for (const [key, srcLine] of Object.entries(keys)) {
                if (consumed.has(`${section}::${key}`)) continue;
                if (dstSections.has(section)) {
                    const insertAt = dstSections.get(section) + 1;
                    outLines.splice(insertAt, 0, srcLine);
                    for (const [s, idx] of dstSections) if (idx >= insertAt) dstSections.set(s, idx + 1);
                    dstSections.set(section, insertAt);
                } else {
                    if (outLines.length && outLines[outLines.length - 1] !== '') outLines.push('');
                    outLines.push(`[${section}]`);
                    outLines.push(srcLine);
                    dstSections.set(section, outLines.length - 1);
                }
                merged++;
            }
        }

        await fs.mkdir(dst, { recursive: true });
        await fs.writeFile(dstPath, outLines.join('\r\n'), 'utf-8');
        return { merged, removed };
    }

    async _resolveValorantConfigDirs(fromPuuid, toPuuid) {
        const base = path.join(process.env.LOCALAPPDATA, 'VALORANT', 'Saved', 'Config');
        const findDir = async (puuid) => {
            try {
                const entries = await fs.readdir(base);
                const match = entries.find(e => e.toLowerCase().startsWith(puuid.toLowerCase()));
                return match ? path.join(base, match, 'Windows') : null;
            } catch { return null; }
        };
        const src = await findDir(fromPuuid);
        if (!src) throw new Error('Source account settings not found. Launch Valorant with that account first.');
        const dst = await findDir(toPuuid);
        if (!dst) throw new Error('Target account config not found. Launch Valorant with that account first.');
        return { src, dst };
    }

    // --- Session cookie extraction from snapshot ---

    async extractCookiesFromSnapshot(accountId) {
        try {
            const yamlPath = path.join(this._snapshotDir(accountId), 'Data', 'RiotGamesPrivateSettings.yaml');
            const content = await fs.readFile(yamlPath, 'utf-8');
            const parsed = yaml.parse(content);
            const cookies = parsed?.['riot-login']?.persist?.session?.cookies || [];
            const map = {};
            for (const c of cookies) { if (c.name && c.value) map[c.name] = c.value; }
            const tdid = parsed?.['rso-authenticator']?.tdid?.value || '';
            return { ssid: map.ssid || '', clid: map.clid || '', csid: map.csid || '', tdid, sub: map.sub || accountId };
        } catch { return null; }
    }
}

module.exports = { AuthLaunchService, KEY_PATTERNS, EXCLUDE_KEY_PATTERNS };
