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
        try {
            const r = await this._localApi('GET', '/entitlements/v1/token');
            if (r && r.ok) {
                const d = await r.json();
                if (d.accessToken && d.subject) return { puuid: d.subject, accessToken: d.accessToken };
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

        // Quick auth check (10s) - if fails, session is expired
        const authResult = await this.waitForAuth(10000);
        if (!authResult) {
            console.log('Session expired. Reopening login page...');
            await this.closeRiotProcesses();
            await new Promise(r => setTimeout(r, 2000));

            // Clear session but keep tdid for 2FA bypass
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
        return { sessionExpired: false };
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

    // Fallback: use the product-launcher API if Valorant didn't auto-launch
    async tryApiLaunch() {
        try {
            const r = await this._localApi('POST', '/product-launcher/v1/products/valorant/patchlines/live', {});
            if (r && r.ok) { console.log('Valorant launched via API.'); return true; }
        } catch {}
        // Second fallback: spawn another instance with --launch-product
        try {
            const exePath = await this.getRiotClientPath();
            spawn(exePath, ['--launch-product=valorant', '--launch-patchline=live'], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) }).unref();
            console.log('Launched second instance with --launch-product.');
            return true;
        } catch {}
        return false;
    }

    // --- Add / Import accounts ---

    async importCurrentAccount() {
        const auth = await this.getAuthenticatedAccount();
        if (!auth) throw new Error('Riot Client is not running or not logged in. Open the Riot Client and log in first.');
        const result = await this.authService.addAccountFromTokens(auth.accessToken, '', {});
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
        let uxSeen = false;
        while (Date.now() - start < 5 * 60 * 1000) {
            const uxRunning = await this._isProcessRunning('RiotClientUx.exe');
            if (uxRunning) uxSeen = true;
            else if (uxSeen) throw new Error('Riot Client was closed before login completed.');
            auth = await this.getAuthenticatedAccount();
            if (auth) break;
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
        for (let i = 0; i < 5; i++) {
            if (!await this._isProcessRunning('RiotClientServices.exe')) break;
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

    // --- Copy game settings ---

    async copyGameSettings(fromPuuid, toPuuid) {
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
        await fs.mkdir(dst, { recursive: true });
        const files = (await fs.readdir(src)).filter(f => f.endsWith('.ini'));
        if (!files.length) throw new Error('No settings files found.');
        let copied = 0;
        for (const file of files) { await fs.copyFile(path.join(src, file), path.join(dst, file)); copied++; }
        return { copied, files };
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

module.exports = { AuthLaunchService };
