// HTTP config proxy.
//
// When the Riot Client is launched with
//   --client-config-url=http://127.0.0.1:{port}
// all of its config requests hit this proxy instead of the real
// clientconfig.rpg.riotgames.com endpoint. We forward every request
// upstream to the real host unchanged, except for the chat config payload
// which we rewrite so that chat.host / chat.port / chat.affinities all
// point at our XMPP MITM proxy instead of Riot's chat servers.
//
// The rewrite is NOT conditional on appear-offline state — whenever the
// proxy is running, we always route chat through ourselves. The XMPP
// proxy itself handles the actual presence-stanza rewriting based on
// the current offline-mode flags.

const http = require('http');
const https = require('https');

const REAL_CONFIG_HOST = 'clientconfig.rpg.riotgames.com';

function fetchUpstream(method, path, headers, body) {
    return new Promise((resolve, reject) => {
        const upstreamHeaders = { ...headers };
        upstreamHeaders.host = REAL_CONFIG_HOST;
        delete upstreamHeaders['content-length'];
        // Force identity encoding — we don't want to deal with gzip/br round-
        // trips. The Riot Client can handle identity responses just fine.
        upstreamHeaders['accept-encoding'] = 'identity';
        const req = https.request({
            hostname: REAL_CONFIG_HOST,
            port: 443,
            method,
            path,
            headers: upstreamHeaders,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Deep-walk a JSON object and rewrite anything referencing Riot chat hosts
// to point at our local XMPP proxy. Riot's clientconfig uses FLAT dot-
// notation keys (e.g. `"chat.host": "..."`, `"chat.port": 5223`,
// `"chat.affinities": {...}`), so we can't rely on nesting alone. We match
// on the key NAME + value shape.
function rewriteChatConfig(obj, xmppPort) {
    let rewrote = false;
    const target = '127.0.0.1';
    const chatHostRe = /\.chat\.si\.riotgames\.com$/i;
    const rewrittenKeys = [];

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        for (const key of Object.keys(node)) {
            const val = node[key];
            const keyLower = key.toLowerCase();
            const isChatKey = keyLower.startsWith('chat.') || keyLower === 'chat';

            // Strings that look like a chat server hostname — rewrite unconditionally.
            if (typeof val === 'string' && chatHostRe.test(val)) {
                node[key] = target;
                rewrote = true;
                rewrittenKeys.push(`${key}=host`);
                continue;
            }

            // Chat port: key is either literal "chat.port" or "port" under a chat-y parent.
            if (typeof val === 'number' && (keyLower === 'chat.port' || keyLower.endsWith('.chat.port'))) {
                node[key] = xmppPort;
                rewrote = true;
                rewrittenKeys.push(`${key}=port`);
                continue;
            }

            // Affinities map: either "chat.affinities" or a key ending in ".affinities"
            // within a chat-y branch. Walk its values and rewrite any chat-host string.
            if (val && typeof val === 'object' && !Array.isArray(val) &&
                (keyLower === 'chat.affinities' || keyLower.endsWith('.affinities') ||
                 (keyLower === 'affinities' && isChatKey))) {
                for (const aff of Object.keys(val)) {
                    if (typeof val[aff] === 'string' && chatHostRe.test(val[aff])) {
                        val[aff] = target;
                        rewrote = true;
                        rewrittenKeys.push(`${key}.${aff}=affinity`);
                    }
                }
                continue;
            }

            // Recurse into nested objects (rare in Riot's flat config, but safe).
            walk(val);
        }
    }

    walk(obj);

    // Belt-and-suspenders: handle the unlikely nested form too.
    if (obj && typeof obj === 'object' && obj.chat && typeof obj.chat === 'object') {
        if (typeof obj.chat.host === 'string') { obj.chat.host = target; rewrote = true; }
        if (typeof obj.chat.port === 'number') { obj.chat.port = xmppPort; rewrote = true; }
    }

    if (rewrote) console.log(`[config-proxy] rewrote: ${rewrittenKeys.join(', ')}`);
    return rewrote;
}

class ConfigProxy {
    constructor() {
        this.server = null;
        this.port = 0;
        this.xmppPort = 0;
    }

    async start(xmppPort) {
        this.xmppPort = xmppPort;
        this.server = http.createServer((req, res) => this._handle(req, res));
        this.server.on('error', (err) => console.log(`[config-proxy] server error: ${err.message}`));
        return new Promise((resolve, reject) => {
            this.server.listen(0, '127.0.0.1', (err) => {
                if (err) return reject(err);
                this.port = this.server.address().port;
                console.log(`[config-proxy] listening on 127.0.0.1:${this.port}, upstream=${REAL_CONFIG_HOST}, xmppPort=${this.xmppPort}`);
                resolve();
            });
        });
    }

    stop() {
        if (this.server) {
            try { this.server.close(); } catch {}
            this.server = null;
        }
    }

    _handle(req, res) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const reqBody = Buffer.concat(chunks);
            try {
                const upstream = await fetchUpstream(req.method, req.url, req.headers, reqBody);
                let body = upstream.body;
                const ct = upstream.headers['content-type'] || '';
                if (ct.includes('json')) {
                    try {
                        const parsed = JSON.parse(body.toString('utf-8'));
                        const modified = rewriteChatConfig(parsed, this.xmppPort);
                        if (modified) {
                            body = Buffer.from(JSON.stringify(parsed), 'utf-8');
                            console.log(`[config-proxy] rewrote chat config in ${req.url}`);
                        }
                    } catch { /* not JSON or parse failed, pass through */ }
                }
                // Strip content-length / encoding before writing — node re-sets it.
                const outHeaders = { ...upstream.headers };
                delete outHeaders['content-length'];
                delete outHeaders['content-encoding'];
                delete outHeaders['transfer-encoding'];
                res.writeHead(upstream.statusCode, outHeaders);
                res.end(body);
            } catch (e) {
                console.log(`[config-proxy] upstream error for ${req.url}: ${e.message}`);
                res.writeHead(502);
                res.end('upstream error');
            }
        });
    }
}

module.exports = { ConfigProxy, rewriteChatConfig };
