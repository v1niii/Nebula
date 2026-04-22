// TLS XMPP MITM proxy.
//
// The Riot Client opens its own XMPP connection to Riot's chat server and
// broadcasts presence stanzas. Our standalone XMPP session can't control
// that. So instead we sit between the Riot Client and the real chat server:
// the config proxy (see config-proxy.js) rewrites the Riot Client's chat
// config to point at this proxy, and we relay everything transparently
// except for outbound `<presence>` stanzas — those get rewritten to
// type="unavailable" when the account is in appear-offline mode.
//
// Riot's real chat servers live at `{affinity}.chat.si.riotgames.com:5223`
// over TLS. The Riot Client doesn't pin certs (that's why Deceive works),
// so we present a self-signed cert for localhost. The initial XMPP stream
// the client sends contains a `to='{affinity}.pvp.net'` attribute, which
// we parse to pick the upstream chat host.

const tls = require('tls');
const selfsigned = require('selfsigned');

// Map from XMPP domain (e.g. eu2.pvp.net) to the chat server cluster host
// that serves it. Derived empirically from Riot's chat config — each region
// has a small set of clusters. If an unknown domain appears we fall back to
// guessing: lowercase domain minus `.pvp.net` → `{x}.chat.si.riotgames.com`.
// The Riot Client's chat config response actually lists these mappings, but
// we rely on the to='...' attribute in the stream open as the source of
// truth at connection time.
const DOMAIN_TO_CHAT_HOST = {
    // Europe
    'eu1.pvp.net': 'eun1.chat.si.riotgames.com',
    'eu2.pvp.net': 'eun1.chat.si.riotgames.com',
    'eu3.pvp.net': 'euw1.chat.si.riotgames.com',
    // North America
    'na1.pvp.net': 'na2.chat.si.riotgames.com',
    'na2.pvp.net': 'na2.chat.si.riotgames.com',
    // Asia / LATAM / BR — best-effort; the actual mapping is config-driven
    'asia1.pvp.net': 'jp1.chat.si.riotgames.com',
    'kr1.pvp.net': 'kr1.chat.si.riotgames.com',
    'latam1.pvp.net': 'la1.chat.si.riotgames.com',
    'br1.pvp.net': 'br1.chat.si.riotgames.com',
};

function resolveChatHostForDomain(domain) {
    return DOMAIN_TO_CHAT_HOST[domain] || null;
}

// Rewrite a single `<presence>` stanza so friends' clients render us as
// offline, WITHOUT sending `type='unavailable'` (which Valorant's own UI
// interprets as us logging out of chat, hiding the friend list + chat).
//
// The trick (same as Deceive): keep the outer <presence> as implicitly-
// available so the XMPP session stays live and Valorant shows its normal
// UI to us, but strip all the rich-presence children (<games>, <private>,
// <status>, <c>, etc.) and replace them with `<show>offline</show>`.
// Valorant's friend-list renderer reads `<show>` to pick the status label,
// and "offline" is exactly what we want it to display.
//
// Subscribe / unsubscribe / probe / error stanzas are control flow and
// must pass through untouched.
function rewritePresenceStanza(stanza) {
    const typeMatch = stanza.match(/\stype\s*=\s*['"]([^'"]*)['"]/);
    if (typeMatch && typeMatch[1] && typeMatch[1] !== 'available') {
        return stanza;
    }
    // Find end of the opening <presence...> tag so we can keep attributes
    // (e.g. xmlns, id) intact and only replace the body.
    const openEnd = stanza.indexOf('>');
    if (openEnd < 0) return stanza;
    const isSelfClose = stanza[openEnd - 1] === '/';
    const openTag = isSelfClose
        ? stanza.slice(0, openEnd - 1) // drop trailing '/' for self-closing
        : stanza.slice(0, openEnd + 1);
    const openWithGt = openTag.endsWith('>') ? openTag : openTag + '>';
    return `${openWithGt}<show>offline</show></presence>`;
}

// Scan a chunk of XMPP bytes for complete `<presence>` stanzas and rewrite
// them. Returns { rewritten, remaining } where `remaining` is whatever is
// left after the last fully-parsed stanza (could contain a partial stanza
// that needs more data to complete).
function processOutgoing(buffer, shouldRewrite) {
    if (!shouldRewrite) return { rewritten: buffer, remaining: '' };
    let out = '';
    let i = 0;
    while (i < buffer.length) {
        const openIdx = buffer.indexOf('<presence', i);
        // Must be followed by whitespace, `>`, or `/` to be a real tag
        if (openIdx < 0) {
            out += buffer.slice(i);
            return { rewritten: out, remaining: '' };
        }
        const nextChar = buffer[openIdx + '<presence'.length];
        if (nextChar !== ' ' && nextChar !== '>' && nextChar !== '/' && nextChar !== '\t' && nextChar !== '\n') {
            // Not actually <presence — keep scanning after this char
            out += buffer.slice(i, openIdx + 1);
            i = openIdx + 1;
            continue;
        }
        // Flush content before the presence tag
        out += buffer.slice(i, openIdx);
        // Find end of this stanza: either self-closing `/>` before any `>`,
        // or `</presence>` after the opening tag ends.
        const openEnd = buffer.indexOf('>', openIdx);
        if (openEnd < 0) {
            // Incomplete tag header — wait for more data
            return { rewritten: out, remaining: buffer.slice(openIdx) };
        }
        const isSelfClose = buffer[openEnd - 1] === '/';
        let endIdx;
        if (isSelfClose) {
            endIdx = openEnd + 1;
        } else {
            const closeIdx = buffer.indexOf('</presence>', openEnd);
            if (closeIdx < 0) {
                // Incomplete stanza — wait for more data
                return { rewritten: out, remaining: buffer.slice(openIdx) };
            }
            endIdx = closeIdx + '</presence>'.length;
        }
        const stanza = buffer.slice(openIdx, endIdx);
        out += rewritePresenceStanza(stanza);
        i = endIdx;
    }
    return { rewritten: out, remaining: '' };
}

class XmppProxy {
    constructor() {
        this.server = null;
        this.port = 0;
        // Global flag — when true, outgoing presence stanzas on any
        // proxied connection get rewritten to type='unavailable'. We don't
        // correlate per-puuid because the Riot Client only hosts one
        // user's chat connection at a time.
        this.globalOffline = false;
        this._pems = null;
    }

    _makeServer() {
        // Mirror Deceive's approach: minimal TLS config, no SNI callback,
        // no cipher overrides, no SAN. Just cert + key + force TLS 1.2.
        // BoringSSL's TLS 1.3 path rejects our RSA cert with
        // NO_CERTIFICATE_SET; 1.2 handshake accepts it fine.
        const s = tls.createServer({
            key: this._pems.private,
            cert: this._pems.cert,
            maxVersion: 'TLSv1.2',
        }, (clientSocket) => this._handleClient(clientSocket));
        s.on('error', (err) => console.log(`[xmpp-proxy] server error: ${err.message}`));
        s.on('connection', (sock) => {
            console.log(`[xmpp-proxy] TCP conn from ${sock.remoteAddress}:${sock.remotePort}`);
        });
        s.on('tlsClientError', (err, sock) => {
            console.log(`[xmpp-proxy] TLS handshake FAILED: ${err.message} (from ${sock?.remoteAddress || 'unknown'})`);
        });
        return s;
    }

    async start() {
        // Simple self-signed cert. Riot Client doesn't strictly verify
        // hostname/SAN on chat servers, so CN=localhost suffices. Adding
        // complex SAN extensions caused BoringSSL to reject the cert.
        this._pems = selfsigned.generate(
            [{ name: 'commonName', value: 'localhost' }],
            { days: 3650, keySize: 2048, algorithm: 'sha256' }
        );

        // Primary server on random port (for chat.port rewrite path).
        this.server = this._makeServer();
        await new Promise((resolve, reject) => {
            this.server.listen(0, '127.0.0.1', (err) => {
                if (err) return reject(err);
                this.port = this.server.address().port;
                console.log(`[xmpp-proxy] listening on 127.0.0.1:${this.port}`);
                resolve();
            });
        });

        // Also listen on the standard XMPP TLS port 5223 in case the Riot
        // Client ignores chat.port and uses its default. Best-effort — if
        // 5223 is already in use we just skip it.
        this.server5223 = this._makeServer();
        await new Promise((resolve) => {
            this.server5223.listen(5223, '127.0.0.1', (err) => {
                if (err) {
                    console.log(`[xmpp-proxy] could not bind :5223 (${err.message}) — skipping, proxy still active on ${this.port}`);
                    this.server5223 = null;
                } else {
                    console.log(`[xmpp-proxy] also listening on 127.0.0.1:5223 (default XMPP port)`);
                }
                resolve();
            });
            this.server5223.once('error', () => resolve());
        });
    }

    stop() {
        for (const s of [this.server, this.server5223]) {
            if (s) { try { s.close(); } catch {} }
        }
        this.server = null;
        this.server5223 = null;
    }

    setGlobalOffline(enabled) {
        this.globalOffline = !!enabled;
        console.log(`[xmpp-proxy] globalOffline=${this.globalOffline}`);
    }

    isAnyOffline() {
        return this.globalOffline;
    }

    _handleClient(clientSocket) {
        let upstreamSocket = null;
        let clientBuffer = '';
        let upstreamStarted = false;

        const startUpstream = (targetHost) => {
            console.log(`[xmpp-proxy] client → upstream ${targetHost}:5223`);
            upstreamSocket = tls.connect(5223, targetHost, {
                servername: targetHost,
                rejectUnauthorized: false,
            });
            upstreamSocket.on('secureConnect', () => {
                // Flush any buffered client data through the processor
                if (clientBuffer) {
                    const { rewritten, remaining } = processOutgoing(clientBuffer, this.isAnyOffline());
                    upstreamSocket.write(rewritten);
                    clientBuffer = remaining;
                }
            });
            upstreamSocket.on('data', (chunk) => {
                // Pass upstream traffic through unchanged
                try { clientSocket.write(chunk); } catch {}
            });
            upstreamSocket.on('close', () => { try { clientSocket.destroy(); } catch {} });
            upstreamSocket.on('error', (err) => {
                console.log(`[xmpp-proxy] upstream error: ${err.message}`);
                try { clientSocket.destroy(); } catch {}
            });
            upstreamStarted = true;
        };

        clientSocket.on('data', (chunk) => {
            const asStr = chunk.toString('utf-8');
            if (!upstreamStarted) {
                // Buffer until we see the stream-open header with to='...'
                clientBuffer += asStr;
                const m = clientBuffer.match(/to\s*=\s*['"]([^'"]+)['"]/);
                if (m) {
                    const targetDomain = m[1];
                    const targetHost = resolveChatHostForDomain(targetDomain);
                    if (!targetHost) {
                        console.log(`[xmpp-proxy] unknown domain ${targetDomain}, closing`);
                        try { clientSocket.destroy(); } catch {}
                        return;
                    }
                    startUpstream(targetHost);
                }
            } else if (upstreamSocket && upstreamSocket.writable) {
                clientBuffer += asStr;
                const { rewritten, remaining } = processOutgoing(clientBuffer, this.isAnyOffline());
                upstreamSocket.write(rewritten);
                clientBuffer = remaining;
            }
        });

        clientSocket.on('close', () => {
            if (upstreamSocket) { try { upstreamSocket.destroy(); } catch {} }
        });
        clientSocket.on('error', (err) => {
            console.log(`[xmpp-proxy] client error: ${err.message}`);
            if (upstreamSocket) { try { upstreamSocket.destroy(); } catch {} }
        });
    }
}

module.exports = { XmppProxy, processOutgoing, rewritePresenceStanza };
