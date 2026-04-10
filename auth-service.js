const fetch = require('node-fetch');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

// Constants
const AUTH_ENDPOINTS = {
  AUTHORIZE: 'https://auth.riotgames.com/authorize',
  ENTITLEMENTS: 'https://entitlements.auth.riotgames.com/api/token/v1',
  USERINFO: 'https://auth.riotgames.com/userinfo',
};

const RIOT_CLIENT_PLATFORM = Buffer.from(JSON.stringify({
  platformType: 'PC', platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown'
})).toString('base64');

// Region to SGP shard mapping for player-preferences
const REGION_SGP_MAP = {
  'NA': 'usw2', 'LATAM': 'usw2', 'BR': 'usw2',
  'EU': 'euc1', 'AP': 'apse1', 'KR': 'apne1',
};

// TLS cipher suites that match the real Riot Client fingerprint (bypasses Cloudflare)
const RIOT_CIPHERS = [
  'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA', 'DES-CBC3-SHA',
].join(':');

const RIOT_SIGALGS = [
  'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512', 'rsa_pkcs1_sha1',
].join(':');

const riotAgent = new https.Agent({
  ciphers: RIOT_CIPHERS, sigalgs: RIOT_SIGALGS,
  secureOptions: crypto.constants.SSL_OP_NO_ENCRYPT_THEN_MAC,
  minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
  rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], keepAlive: true,
});

let _cachedBuild = null;
async function getRiotClientBuild() {
  if (_cachedBuild) return _cachedBuild;
  try {
    const res = await fetch('https://valorant-api.com/v1/version');
    const data = await res.json();
    if (data.status === 200 && data.data?.riotClientBuild) {
      _cachedBuild = data.data.riotClientBuild;
      return _cachedBuild;
    }
  } catch (e) { /* fallback */ }
  return '111.0.0.3261.5663';
}

async function getRiotHeaders() {
  const build = await getRiotClientBuild();
  return {
    'Content-Type': 'application/json',
    'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
    'Accept': 'application/json',
    'Cache-Control': 'no-cache',
  };
}

class AuthService {
  constructor(store) {
    this.store = store;
    this.accounts = this.store.get('accounts', []);
    // safeStorage is lazy-loaded to ensure it's available after app.ready
    this._safeStorage = null;
  }

  _getSafeStorage() {
    if (!this._safeStorage) {
      this._safeStorage = require('electron').safeStorage;
    }
    return this._safeStorage;
  }

  // --- Cookie Storage (safeStorage-backed) ---

  async storeCookiesSecurely(accountId, cookies) {
    if (!cookies || typeof cookies !== 'object') throw new Error('Invalid cookies.');
    const safe = this._getSafeStorage();
    const data = { ssid: cookies.ssid, clid: cookies.clid, csid: cookies.csid, tdid: cookies.tdid, sub: cookies.sub || accountId, asid: cookies.asid || '' };
    if (safe.isEncryptionAvailable()) {
      const encrypted = safe.encryptString(JSON.stringify(data));
      this.store.set(`secure.${accountId}`, encrypted.toString('base64'));
    } else {
      // Fallback: obfuscated storage (not ideal but functional)
      this.store.set(`secure.${accountId}`, Buffer.from(JSON.stringify(data)).toString('base64'));
    }
  }

  async retrieveCookiesSecurely(accountId) {
    try {
      const raw = this.store.get(`secure.${accountId}`);
      if (!raw) return null;
      const safe = this._getSafeStorage();
      if (safe.isEncryptionAvailable()) {
        const decrypted = safe.decryptString(Buffer.from(raw, 'base64'));
        return JSON.parse(decrypted);
      } else {
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
      }
    } catch (e) {
      return null;
    }
  }

  async deleteCookiesSecurely(accountId) {
    this.store.delete(`secure.${accountId}`);
  }

  // --- Account CRUD ---

  getAccounts() {
    this.accounts = this.store.get('accounts', []);
    return this.accounts.map(acc => ({ ...acc }));
  }

  getAccountById(accountId) {
    this.accounts = this.store.get('accounts', []);
    const account = this.accounts.find(acc => acc.id === accountId);
    return account ? { ...account } : null;
  }

  async addAccountFromTokens(accessToken, idToken, cookies) {
    try {
      const userInfo = await this._getUserInfo(accessToken);
      const detectedRegion = this._detectRegion(userInfo);
      const gameName = userInfo.acct?.game_name;
      const tagLine = userInfo.acct?.tag_line;
      const hasRiotId = gameName && tagLine;

      const accountData = {
        id: userInfo.sub,
        username: gameName || `User (${userInfo.sub.substring(0, 5)})`,
        region: detectedRegion,
        puuid: userInfo.sub,
        displayName: hasRiotId ? `${gameName}#${tagLine}` : (gameName || `User (${userInfo.sub.substring(0, 5)})`),
        nickname: '',
        sortOrder: this.accounts.length,
        lastUsed: Date.now(),
        createdAt: Date.now()
      };

      this._saveAccount(accountData);
      await this.storeCookiesSecurely(accountData.id, {
        ssid: cookies.ssid || '', clid: cookies.clid || '',
        csid: cookies.csid || '', tdid: cookies.tdid || '',
        sub: accountData.id, asid: cookies.asid || ''
      });

      return { success: true, account: { ...accountData } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }


  async removeAccount(accountId) {
    this.accounts = this.store.get('accounts', []);
    this.accounts = this.accounts.filter(a => a.id !== accountId);
    this.store.set('accounts', this.accounts);
    await this.deleteCookiesSecurely(accountId);
    return { success: true };
  }

  // --- Account metadata operations ---

  async updateLastUsed(accountId) {
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountId);
    if (idx > -1) {
      this.accounts[idx].lastUsed = Date.now();
      this.store.set('accounts', this.accounts);
    }
  }

  setNickname(accountId, nickname) {
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountId);
    if (idx > -1) {
      this.accounts[idx].nickname = nickname;
      this.store.set('accounts', this.accounts);
      return { success: true };
    }
    return { success: false, error: 'Account not found.' };
  }

  reorderAccounts(orderedIds) {
    this.accounts = this.store.get('accounts', []);
    const idToAccount = new Map(this.accounts.map(a => [a.id, a]));
    const reordered = orderedIds.map((id, i) => {
      const acc = idToAccount.get(id);
      if (acc) { acc.sortOrder = i; return acc; }
      return null;
    }).filter(Boolean);
    // Append any accounts not in the ordered list
    for (const acc of this.accounts) {
      if (!orderedIds.includes(acc.id)) reordered.push(acc);
    }
    this.accounts = reordered;
    this.store.set('accounts', this.accounts);
    return { success: true };
  }

  // --- Session health ---

  async checkSession(accountId) {
    return this.checkSessionWithCookies(accountId, await this.retrieveCookiesSecurely(accountId));
  }

  async checkSessionWithCookies(accountId, cookies) {
    try {
      if (!cookies?.ssid) return { valid: false, reason: 'No SSID cookie.' };
      const result = await this._performSSIDAuth(cookies.ssid, cookies.clid, cookies.csid, cookies.tdid);
      if (result.success) {
        await this.storeCookiesSecurely(accountId, {
          ssid: result.ssid, clid: result.clid || '', csid: result.csid || '',
          tdid: result.tdid || '', sub: accountId
        });
        return { valid: true };
      }
      return { valid: false, reason: result.message || 'Session expired (~1-3 weeks lifespan).' };
    } catch (e) {
      return { valid: false, reason: e.message };
    }
  }

  // --- Auth methods ---

  async refreshAuth(accountId) {
    try {
      const cookies = await this.retrieveCookiesSecurely(accountId);
      if (!cookies?.ssid) throw new Error('No stored SSID cookie.');

      const authResult = await this._performSSIDAuth(cookies.ssid, cookies.clid, cookies.csid, cookies.tdid);
      if (!authResult.success) throw new Error(authResult.message || 'SSID re-auth failed.');

      const entitlements = await this._getEntitlements(authResult.accessToken);
      await this.storeCookiesSecurely(accountId, {
        ssid: authResult.ssid, clid: authResult.clid || '',
        csid: authResult.csid || '', tdid: authResult.tdid || '', sub: accountId
      });
      await this.updateLastUsed(accountId);

      return { success: true, accessToken: authResult.accessToken, idToken: authResult.idToken, entitlementsToken: entitlements.entitlements_token };
    } catch (error) {
      return { success: false, error: error.message, needsRelogin: true };
    }
  }

  // --- Cloud Settings Auth (uses riot-client client_id for proper RBAC permissions) ---

  async getCloudAuthTokens(ssid, clid, csid, tdid) {
    const cookieMap = {};
    if (ssid) cookieMap.ssid = ssid;
    if (clid) cookieMap.clid = clid;
    if (csid) cookieMap.csid = csid;
    if (tdid) cookieMap.tdid = tdid;
    if (!cookieMap.ssid) throw new Error('No SSID cookie.');

    const build = await getRiotClientBuild();
    const ua = `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`;
    const nonce = crypto.randomBytes(16).toString('base64url');
    const url = `${AUTH_ENDPOINTS.AUTHORIZE}?redirect_uri=http%3A%2F%2Flocalhost%2Fredirect&client_id=riot-client&response_type=token%20id_token&nonce=${nonce}&scope=openid%20link%20ban%20lol_region%20lol%20summoner%20offline_access`;

    const response = await fetch(url, {
      agent: riotAgent, redirect: 'manual',
      headers: { 'User-Agent': ua, 'Cookie': this._formatCookies(cookieMap) },
    });
    const loc = response.headers.get('location');
    if (!loc || !loc.includes('access_token')) throw new Error('Session expired. Launch the account first.');
    const accessToken = new URLSearchParams(loc.split('#')[1]).get('access_token');

    const entR = await fetch(AUTH_ENDPOINTS.ENTITLEMENTS, {
      method: 'POST', agent: riotAgent,
      headers: { 'User-Agent': ua, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!entR.ok) throw new Error('Entitlements failed.');
    const { entitlements_token } = await entR.json();
    return { accessToken, entitlementsToken: entitlements_token };
  }

  // --- Cloud Settings (via SGP player-preferences) ---

  _getSgpPrefsUrl(region) {
    const shard = REGION_SGP_MAP[(region || 'NA').toUpperCase()] || 'usw2';
    return `https://player-preferences-${shard}.pp.sgp.pvp.net/playerPref/v3`;
  }

  async getCloudSettings(accessToken, entitlementsToken, region) {
    const url = `${this._getSgpPrefsUrl(region)}/getPreference/Ares.PlayerSettings`;
    const build = await getRiotClientBuild();
    const res = await fetch(url, {
      agent: riotAgent,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
        'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
      },
    });
    if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`);
    const body = await res.json();
    if (!body.data) throw new Error('No settings data returned.');
    return body;
  }

  async putCloudSettings(accessToken, entitlementsToken, region, settingsBlob) {
    const url = `${this._getSgpPrefsUrl(region)}/savePreference`;
    const build = await getRiotClientBuild();
    const res = await fetch(url, {
      method: 'PUT', agent: riotAgent,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
        'Content-Type': 'application/json',
        'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
      },
      body: JSON.stringify({ type: 'Ares.PlayerSettings', data: settingsBlob.data }),
    });
    if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
    return res.json();
  }

  // --- Private helpers ---

  _detectRegion(userInfo) {
    let shard = null;
    const affinity = userInfo.affinity;
    if (affinity) {
      const keys = ['pp', 'live.valorant', 'live', 'pbe'];
      for (const key of keys) {
        if (affinity[key] && typeof affinity[key] === 'string') { shard = affinity[key].toLowerCase(); break; }
      }
      if (!shard) {
        const first = Object.values(affinity).find(v => typeof v === 'string');
        if (first) shard = first.toLowerCase();
      }
    }

    const directMap = { eu: 'EU', europe: 'EU', ap: 'AP', apac: 'AP', kr: 'KR', korea: 'KR', br: 'BR', latam: 'LATAM', na: 'NA', pbe: 'PBE' };
    if (shard && directMap[shard] && shard !== 'am' && shard !== 'americas') return directMap[shard];

    const country = (userInfo.country || '').toLowerCase();
    if (['bra', 'br'].includes(country)) return 'BR';
    if (['arg', 'ar', 'chl', 'cl', 'col', 'co', 'per', 'pe', 'mex', 'mx', 'ury', 'uy', 'pry', 'py', 'ecu', 'ec', 'ven', 've', 'bol', 'bo', 'cri', 'cr', 'pan', 'pa', 'gtm', 'gt', 'hnd', 'hn', 'slv', 'sv', 'nic', 'ni', 'dom', 'do', 'cub', 'cu'].includes(country)) return 'LATAM';
    if (['deu', 'de', 'gbr', 'gb', 'fra', 'fr', 'esp', 'es', 'ita', 'it', 'nld', 'nl', 'pol', 'pl', 'swe', 'se', 'nor', 'no', 'dnk', 'dk', 'fin', 'fi', 'prt', 'pt', 'aut', 'at', 'bel', 'be', 'che', 'ch', 'cze', 'cz', 'rou', 'ro', 'hun', 'hu', 'tur', 'tr', 'rus', 'ru', 'ukr', 'ua', 'irl', 'ie', 'bgr', 'bg', 'hrv', 'hr', 'svk', 'sk', 'ltu', 'lt', 'lva', 'lv', 'est', 'ee', 'srb', 'rs', 'grc', 'gr'].includes(country)) return 'EU';
    if (['jpn', 'jp', 'aus', 'au', 'sgp', 'sg', 'tha', 'th', 'phl', 'ph', 'idn', 'id', 'mys', 'my', 'vnm', 'vn', 'twn', 'tw', 'hkg', 'hk', 'ind', 'in', 'nzl', 'nz'].includes(country)) return 'AP';
    if (['kor', 'kr'].includes(country)) return 'KR';

    return 'NA';
  }

  async _performSSIDAuth(ssid, clid, csid, tdid) {
    const cookieMap = {};
    if (ssid) cookieMap.ssid = ssid;
    if (clid) cookieMap.clid = clid;
    if (csid) cookieMap.csid = csid;
    if (tdid) cookieMap.tdid = tdid;
    if (!cookieMap.ssid) return { success: false, message: 'SSID required.' };

    try {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const url = `${AUTH_ENDPOINTS.AUTHORIZE}?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=${nonce}&scope=account%20openid`;

      // Use browser-like headers for cookie reauth since cookies come from webview
      const response = await fetch(url, {
        method: 'GET', agent: riotAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': this._formatCookies(cookieMap),
        },
        redirect: 'manual'
      });

      const redirectUrl = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && redirectUrl && redirectUrl.includes('access_token')) {
        const params = new URLSearchParams(redirectUrl.split('#')[1]);
        const accessToken = params.get('access_token');
        const idToken = params.get('id_token');
        if (!accessToken || !idToken) return { success: false, message: 'Tokens not found.', needsRelogin: true };

        const latest = this._extractCookies(response, { ...cookieMap });
        return { success: true, accessToken, idToken, ssid: latest.ssid || ssid, clid: latest.clid || clid, csid: latest.csid || csid, tdid: latest.tdid || tdid };
      }
      return { success: false, message: 'Session expired.', needsRelogin: true };
    } catch (error) {
      return { success: false, error: 'network_error', message: error.message, needsRelogin: true };
    }
  }

  async _getEntitlements(accessToken) {
    const headers = await getRiotHeaders();
    const response = await fetch(AUTH_ENDPOINTS.ENTITLEMENTS, {
      method: 'POST', agent: riotAgent,
      headers: { ...headers, 'Authorization': `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Entitlements failed: ${response.status}`);
    return await response.json();
  }

  async _getUserInfo(accessToken) {
    const headers = await getRiotHeaders();
    const response = await fetch(AUTH_ENDPOINTS.USERINFO, {
      method: 'GET', agent: riotAgent,
      headers: { ...headers, 'Authorization': `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`User info failed: ${response.status}`);
    return await response.json();
  }

  _saveAccount(accountData) {
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountData.id);
    if (idx >= 0) {
      const existing = this.accounts[idx];
      this.accounts[idx] = { ...existing, ...accountData, createdAt: existing.createdAt, nickname: existing.nickname || accountData.nickname || '', sortOrder: existing.sortOrder ?? accountData.sortOrder ?? idx };
    } else {
      this.accounts.push({ ...accountData, sortOrder: accountData.sortOrder ?? this.accounts.length });
    }
    this.store.set('accounts', this.accounts);
  }

  _extractCookies(response, existing = {}) {
    const headers = response.headers.raw?.()?.['set-cookie'] || [];
    headers.forEach(str => {
      const parts = str.split(';')[0].split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        if (name && value) existing[name] = value;
      }
    });
    return existing;
  }

  _formatCookies(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

module.exports = { AuthService };
