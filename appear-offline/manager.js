// Lifecycle orchestrator for the appear-offline proxies.
//
// Owns the XMPP MITM proxy + the HTTP config proxy. Exposes a simple API:
//   - start() once at app startup so the proxy ports are ready before
//     Valorant launches.
//   - setAppearOffline(puuid, offline) toggles rewriting for a given account.
//     Takes effect for the Riot Client's CURRENT connection — if they're
//     already connected through our proxy, outgoing presences start getting
//     rewritten. If they haven't launched through our proxy yet, toggling
//     this won't affect anything until next launch.
//   - getConfigUrl() returns the URL to pass as --client-config-url on
//     Riot Client launch.

const { XmppProxy } = require('./xmpp-proxy');
const { ConfigProxy } = require('./config-proxy');

class AppearOfflineManager {
    constructor() {
        this.xmpp = new XmppProxy();
        this.config = new ConfigProxy();
        this.started = false;
    }

    async start() {
        if (this.started) return;
        await this.xmpp.start();
        await this.config.start(this.xmpp.port);
        this.started = true;
    }

    stop() {
        this.xmpp.stop();
        this.config.stop();
        this.started = false;
    }

    getConfigUrl() {
        if (!this.started) return null;
        return `http://127.0.0.1:${this.config.port}`;
    }

    // Global toggle — when true, any client that connects through our XMPP
    // proxy gets its outgoing presences rewritten to unavailable.
    setAppearOfflineGlobal(enabled) {
        this.xmpp.setGlobalOffline(!!enabled);
    }
}

const singleton = new AppearOfflineManager();
module.exports = singleton;
