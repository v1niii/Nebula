const fs = require('fs').promises;
const path = require('path');
const yaml = require('yaml');
const fetch = require('node-fetch');
const https = require('https');
const { exec, spawn } = require('child_process');
const os = require('os');
// Constants for Riot Client paths and configuration files
const RIOT_CLIENT_INSTALLS_PATH = path.join(process.env.ProgramData, 'Riot Games', 'RiotClientInstalls.json');
const RIOT_CLIENT_DATA_PATH_BASE = path.join(process.env.LOCALAPPDATA, 'Riot Games');
const RIOT_GAMES_PRIVATE_SETTINGS = 'RiotGamesPrivateSettings.yaml';
const RIOT_CLIENT_SETTINGS = 'RiotClientSettings.yaml';
const RIOT_CLIENT_DATA_FOLDER = 'Riot Client/Data';
const RIOT_CLIENT_CONFIG_FOLDER = 'Riot Client/Config';
const RIOT_CLIENT_BETA_DATA_FOLDER = 'Beta/Data';
const RIOT_CLIENT_BETA_CONFIG_FOLDER = 'Beta/Config';
const RIOT_CLIENT_LOCKFILE = 'Riot Client/Config/lockfile';
const RIOT_CLIENT_BETA_LOCKFILE = 'Beta/Config/lockfile';

class AuthLaunchService {
    constructor(store, authService) {
        this.store = store;
        this.authService = authService;
    }

    // Finds the Riot Client executable path by reading RiotClientInstalls.json
    async getRiotClientPath() {
        if (!os.platform().startsWith('win')) {
            throw new Error('Automatic Riot Client detection is only supported on Windows.');
        }

        try {
            const installDataContent = await fs.readFile(RIOT_CLIENT_INSTALLS_PATH, 'utf-8');
            const installData = JSON.parse(installDataContent);

            // Check known keys in order of preference
            const pathsToCheck = ['rc_live', 'rc_default', 'rc_beta', 'rc_esports'];
            for (const key of pathsToCheck) {
                if (installData[key] && typeof installData[key] === 'string') {
                    try {
                        await fs.access(installData[key]); // Verify the file exists
                        console.log(`Found Riot Client executable at: ${installData[key]}`);
                        return installData[key];
                    } catch {
                        // Path exists, continue checking next key
                    }
                }
            }
            throw new Error('No valid Riot Client executable found in RiotClientInstalls.json.');
        } catch (error) {
            console.error('Error finding Riot Client path:', error);
            throw new Error(`Could not find Riot Client installation. Ensure Riot Games is installed. (${error.message})`);
        }
    }

    // Locates the correct Data and Config directories (Beta or Default) used by Riot Client
    async findCurrentRiotDataPaths() {
        const paths = { dataPath: null, configPath: null };

        const defaultDataPath = path.join(RIOT_CLIENT_DATA_PATH_BASE, RIOT_CLIENT_DATA_FOLDER);
        const defaultConfigPath = path.join(RIOT_CLIENT_DATA_PATH_BASE, RIOT_CLIENT_CONFIG_FOLDER);
        const betaDataPath = path.join(RIOT_CLIENT_DATA_PATH_BASE, RIOT_CLIENT_BETA_DATA_FOLDER);
        const betaConfigPath = path.join(RIOT_CLIENT_DATA_PATH_BASE, RIOT_CLIENT_BETA_CONFIG_FOLDER);

        // Riot Client prefers using the 'Beta' path if it exists
        try {
            await fs.access(betaDataPath);
            await fs.access(betaConfigPath);
            paths.dataPath = betaDataPath;
            paths.configPath = betaConfigPath;
            console.log('Using Beta Riot Client data paths.');
            return paths;
        } catch {
            // Beta path not found, fall back to the default path
        }

        try {
            await fs.access(defaultDataPath);
            await fs.access(defaultConfigPath);
            paths.dataPath = defaultDataPath;
            paths.configPath = defaultConfigPath;
            console.log('Using Default Riot Client data paths.');
            return paths;
        } catch (error) {
            console.error('Could not find valid Riot Client data/config directories:', error);
            throw new Error('Could not locate Riot Client data directories.');
        }
    }

    // Reads and parses the RiotGamesPrivateSettings.yaml file
    async readPrivateSettings(dataPath) {
        const filePath = path.join(dataPath, RIOT_GAMES_PRIVATE_SETTINGS);
        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const parsedYaml = yaml.parse(fileContent);
            return parsedYaml;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`Private settings file not found at ${filePath}. Assuming not logged in.`);
                return null; // File not existing usually means not logged in
            }
            console.error(`Error reading/parsing ${RIOT_GAMES_PRIVATE_SETTINGS}:`, error);
            throw new Error(`Failed to read Riot private settings: ${error.message}`);
        }
    }

    // Extracts cookie values (ssid, sub, etc.) from the parsed private settings YAML
    extractCookiesFromYaml(parsedYaml) {
        try {
            // Navigate through the expected YAML structure
            const cookiesArray = parsedYaml?.private?.['riot-login']?.persist?.session?.cookies;
            if (!Array.isArray(cookiesArray)) {
                return null;
            }

            const cookies = {};
            cookiesArray.forEach(cookie => {
                if (cookie.name && cookie.value) {
                    cookies[cookie.name] = cookie.value;
                }
            });

            // Ensure the essential cookies for identification and auth are present
            if (cookies.ssid && cookies.sub) { // 'sub' contains the PUUID
                return cookies;
            }
            return null;
        } catch (error) {
            console.error('Error extracting cookies from YAML:', error);
            return null;
        }
    }

    // Reads the Riot Client lockfile to get the local API port and password
    async readLockfile() {
        const betaPath = path.join(RIOT_CLIENT_DATA_PATH_BASE, RIOT_CLIENT_BETA_LOCKFILE);
        const defaultPath = path.join(RIOT_CLIENT_DATA_PATH_BASE, RIOT_CLIENT_LOCKFILE);

        for (const lockfilePath of [betaPath, defaultPath]) {
            try {
                const content = await fs.readFile(lockfilePath, 'utf-8');
                const parts = content.split(':');
                if (parts.length >= 4) {
                    return { port: parts[2], password: parts[3] };
                }
            } catch {
                // Try next path
            }
        }
        return null;
    }

    // Gets auth tokens directly from the running Riot Client's local API
    async authenticateViaLockfile() {
        const lockfile = await this.readLockfile();
        if (!lockfile) {
            return null;
        }

        try {
            const agent = new https.Agent({ rejectUnauthorized: false });
            const credentials = Buffer.from(`riot:${lockfile.password}`).toString('base64');
            const response = await fetch(`https://127.0.0.1:${lockfile.port}/riot-client-auth/v1/authorization`, {
                method: 'GET',
                agent,
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                console.log(`Lockfile auth returned ${response.status}`);
                return null;
            }

            const data = await response.json();
            if (data.accessToken && data.subject) {
                console.log('Successfully authenticated via Riot Client lockfile');
                return {
                    accessToken: data.accessToken,
                    idToken: data.idToken || '',
                    puuid: data.subject,
                };
            }
            return null;
        } catch (error) {
            console.log('Lockfile auth failed:', error.message);
            return null;
        }
    }

    // Imports account details - tries lockfile first, then falls back to YAML
    async importCurrentAccount() {
        console.log('Attempting to import current Riot account session...');

        // Method 1: Try lockfile auth (fastest, works if Riot Client is running)
        const lockfileAuth = await this.authenticateViaLockfile();
        if (lockfileAuth) {
            try {
                // We have tokens directly, use them to get user info and save
                const result = await this.authService.addAccountFromTokens(
                    lockfileAuth.accessToken,
                    lockfileAuth.idToken,
                    {} // No browser cookies from this method
                );

                if (result.success) {
                    // Now try to also get cookies from YAML for future re-auth/launch
                    try {
                        const { dataPath } = await this.findCurrentRiotDataPaths();
                        const privateSettings = await this.readPrivateSettings(dataPath);
                        if (privateSettings) {
                            const cookies = this.extractCookiesFromYaml(privateSettings);
                            if (cookies && cookies.ssid) {
                                await this.authService.storeCookiesSecurely(result.account.id, {
                                    ssid: cookies.ssid,
                                    clid: cookies.clid || '',
                                    csid: cookies.csid || '',
                                    tdid: cookies.tdid || '',
                                    sub: result.account.id,
                                });
                                console.log('Stored session data for lockfile-imported account');
                            }
                        }
                    } catch (e) {
                        console.warn('Could not read YAML cookies for lockfile import:', e.message);
                    }
                    return result.account;
                }
            } catch (error) {
                console.warn('Lockfile auth succeeded but account save failed:', error.message);
            }
        }

        // Method 2: Fall back to reading YAML cookies directly
        console.log('Lockfile auth unavailable, trying YAML file import...');
        try {
            const { dataPath } = await this.findCurrentRiotDataPaths();
            const privateSettings = await this.readPrivateSettings(dataPath);

            if (!privateSettings) {
                throw new Error('Could not read Riot private settings. Is the Riot Client running and logged in?');
            }

            const cookies = this.extractCookiesFromYaml(privateSettings);

            if (!cookies || !cookies.ssid || !cookies.sub) {
                throw new Error('Could not extract necessary cookies (ssid, sub) from Riot settings.');
            }

            const accountData = {
                id: cookies.sub,
                username: `Imported (${cookies.sub.substring(0, 5)})`,
                region: 'NA',
                cookies: cookies
            };

            const addedAccount = await this.authService.addImportedAccount(accountData);
            console.log('Successfully imported account via YAML:', addedAccount?.id);
            return addedAccount;

        } catch (error) {
            console.error('Failed to import current account:', error);
            throw new Error('Could not import account. Make sure the Riot Client is running and you are logged in.');
        }
    }

    // Copies Valorant in-game settings (crosshair, keybinds, video) from one account to another
    async copyGameSettings(fromPuuid, toPuuid) {
        const valorantConfigBase = path.join(process.env.LOCALAPPDATA, 'VALORANT', 'Saved', 'Config');
        const sourceDir = path.join(valorantConfigBase, fromPuuid, 'Windows');
        const targetDir = path.join(valorantConfigBase, toPuuid, 'Windows');

        try {
            await fs.access(sourceDir);
        } catch {
            throw new Error('Source account settings not found. Launch Valorant with that account at least once.');
        }

        await fs.mkdir(targetDir, { recursive: true });

        const files = await fs.readdir(sourceDir);
        const settingsFiles = files.filter(f => f.endsWith('.ini'));

        if (settingsFiles.length === 0) {
            throw new Error('No settings files found for the source account.');
        }

        let copied = 0;
        for (const file of settingsFiles) {
            await fs.copyFile(path.join(sourceDir, file), path.join(targetDir, file));
            copied++;
        }

        return { copied, files: settingsFiles };
    }

    // Generates the YAML content for RiotGamesPrivateSettings.yaml using provided cookies

    createPrivateSettingsYaml(cookies) {
        // This structure must match what Riot Client expects to read for authentication
        const yamlStructure = {
            private: {
                'riot-login': {
                    persist: {
                        session: {
                            cookies: [
                                // Order and exact fields might be important
                                { domain: 'auth.riotgames.com', hostOnly: true, httpOnly: true, name: 'tdid', path: '/', persistent: true, secureOnly: true, value: cookies.tdid || '' },
                                { domain: 'auth.riotgames.com', hostOnly: true, httpOnly: true, name: 'ssid', path: '/', persistent: true, secureOnly: true, value: cookies.ssid }, // Essential cookie
                                { domain: 'auth.riotgames.com', hostOnly: true, httpOnly: true, name: 'clid', path: '/', persistent: true, secureOnly: true, value: cookies.clid || '' },
                                { domain: 'auth.riotgames.com', hostOnly: true, httpOnly: false, name: 'sub', path: '/', persistent: true, secureOnly: true, value: cookies.sub }, // Contains PUUID
                                { domain: 'auth.riotgames.com', hostOnly: true, httpOnly: true, name: 'csid', path: '/', persistent: true, secureOnly: true, value: cookies.csid || '' },
                                // Add other cookies here if reverse-engineering shows they are needed
                            ]
                        }
                    }
                }
            }
        };
        return yaml.stringify(yamlStructure);
    }

    // Generates the YAML content for RiotClientSettings.yaml
    createClientSettingsYaml(region = 'NA') {
         const yamlStructure = {
            install: {
                globals: {
                    region: region.toUpperCase(), // Region needs to be uppercase
                    locale: 'en_US',
                }
            },
            patchlines: { // Usually needed
                valorant: "live" // Assuming live patchline
            }
            // Add other settings if discovered to be necessary
        };
        return yaml.stringify(yamlStructure);
    }

    // Attempts to forcefully close Riot Client and Valorant processes
    async closeRiotProcesses() {
        console.log('Attempting to close Riot and Valorant processes...');
        // Include main service, game, and UI processes
        const processesToKill = ['RiotClientServices.exe', 'VALORANT-Win64-Shipping.exe', 'RiotClientUx.exe', 'RiotClientUxRender.exe'];
        const platform = os.platform();

        try {
            if (platform === 'win32') {
                const command = `taskkill /F ${processesToKill.map(p => `/IM ${p}`).join(' ')} /T`;
                await new Promise((resolve) => {
                    exec(command, (error, stdout, stderr) => {
                        // taskkill exits with error if process not found, ignore those specific errors
                        if (error && !stderr.includes('ERROR: The process') && !stderr.includes('not found')) {
                            console.warn(`Taskkill error (ignoring 'not found'): ${stderr || error.message}`);
                        } else if (stdout) {
                            console.log(`Taskkill output: ${stdout}`);
                        }
                        resolve();
                    });
                });
            } else if (platform === 'darwin') { // macOS
                const command = `pkill -f ${processesToKill.join('|')}`; // Adjust command for macOS if needed
                 await new Promise((resolve) => {
                    exec(command, (error, stdout, stderr) => {
                        if (error && error.code !== 1) { // pkill exits 1 if no process found, ignore that
                             console.warn(`pkill error (ignoring 'not found'): ${stderr || error.message}`);
                        } else if (stdout) {
                             console.log(`pkill output: ${stdout}`);
                        }
                        resolve();
                    });
                });
            } else {
                console.warn('Process closing not implemented for this platform:', platform);
            }
            console.log('Finished attempting to close processes.');
            await new Promise(resolve => setTimeout(resolve, 1500)); // Brief pause to allow processes to exit
        } catch (error) {
            console.error('Exception during process closing:', error);
            // Log error but proceed with launch attempt
        }
    }

     // Checks if the main Valorant game process is currently running
     async isValorantRunning() {
        const platform = os.platform();
        const valorantProcessName = 'VALORANT-Win64-Shipping.exe'; // Windows process name

        return new Promise((resolve) => { // No reject needed, just resolve true/false
            let command;
            if (platform === 'win32') {
                command = `tasklist /FI "IMAGENAME eq ${valorantProcessName}"`;
            } else if (platform === 'darwin') {
                command = `pgrep -f ${valorantProcessName}`; // Adjust for macOS if needed
            } else {
                return resolve(false); // Only implemented for Win/Mac currently
            }

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    // Check if the error is the expected "process not found" error code
                    const isNotFoundError = (platform === 'win32' && error.code === 1) || (platform === 'darwin' && error.code === 1);
                    if (isNotFoundError) {
                        // Process not found, this is not a failure, resolve false
                        resolve(false);
                    } else {
                        // An unexpected error occurred during command execution
                        console.error(`Error checking Valorant process: ${stderr || error.message}`);
                        resolve(false); // Assume not running on unexpected error
                    }
                } else {
                    // No error occurred, check stdout to confirm process is running
                    if (platform === 'win32') {
                        resolve(stdout.toLowerCase().includes(valorantProcessName.toLowerCase()));
                    } else if (platform === 'darwin') {
                        resolve(stdout.trim().length > 0);
                    } else {
                        resolve(false); // Should not happen if platform check passed earlier
                    }
                }
            });
        });
    }


    // Main function to launch Valorant for a specific account
    async launchValorant(account, cookies, autoLaunchValorant = true) {
        if (!account || !account.id) {
            throw new Error('Invalid account metadata provided for launch.');
        }
        if (!cookies || !cookies.ssid || !cookies.sub) {
            throw new Error('Invalid or missing cookies provided for launch.');
        }

        console.log(`Attempting launch for account: ${account.id.substring(0, 8)}...`);

        // Step 1: Close existing Riot/Valorant processes
        await this.closeRiotProcesses();

        // Step 2: Find necessary paths
        const riotClientExePath = await this.getRiotClientPath(); // Find RiotClient.exe
        const { dataPath, configPath } = await this.findCurrentRiotDataPaths(); // Find Data/Config dirs

        // Step 3: Write the authentication and settings files
        try {
            await fs.mkdir(dataPath, { recursive: true }); // Ensure dirs exist
            await fs.mkdir(configPath, { recursive: true });

            // Create and write RiotGamesPrivateSettings.yaml (contains auth cookies)
            const privateSettingsContent = this.createPrivateSettingsYaml(cookies);
            await fs.writeFile(path.join(dataPath, RIOT_GAMES_PRIVATE_SETTINGS), privateSettingsContent, 'utf-8');
            console.log('Wrote auth settings file.');

            // Create and write RiotClientSettings.yaml (contains region/locale)
            const clientSettingsContent = this.createClientSettingsYaml(account.region);
            await fs.writeFile(path.join(configPath, RIOT_CLIENT_SETTINGS), clientSettingsContent, 'utf-8');
            console.log('Wrote client settings file.');

        } catch (error) {
            console.error('Error writing Riot configuration files:', error);
            throw new Error(`Failed to write Riot auth/settings files: ${error.message}`);
        }

        // Step 4: Launch the Riot Client
        try {
            const args = autoLaunchValorant ? ['--launch-product=valorant', '--launch-patchline=live'] : [];
            console.log(`Launching Riot Client for account ${account.id.substring(0, 8)}...`);

            const child = spawn(riotClientExePath, args, {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            console.log('Riot Client launch initiated.');

            // Step 5: Overwrite plaintext cookies on disk after Riot Client has read them
            const yamlPath = path.join(dataPath, RIOT_GAMES_PRIVATE_SETTINGS);
            setTimeout(async () => {
                try {
                    // Overwrite with empty structure instead of deleting
                    // (delete can fail if file is locked; overwrite zeroes out the secrets)
                    const emptyYaml = yaml.stringify({ private: { 'riot-login': { persist: { session: { cookies: [] } } } } });
                    await fs.writeFile(yamlPath, emptyYaml, 'utf-8');
                    console.log('Scrubbed plaintext auth data from disk.');
                } catch (e) {
                    // File may be locked by Riot Client - will be overwritten on next launch
                }
            }, 15000);

        } catch (error) {
            console.error('Failed to spawn Riot Client process:', error);
            throw new Error(`Failed to start Riot Client: ${error.message}`);
        }
    }
}

module.exports = { AuthLaunchService };