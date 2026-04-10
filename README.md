# Nebula

A fast, secure Valorant account manager. Switch between accounts seamlessly.

> **Disclaimer:** This project interacts with unofficial Riot Games APIs and is subject to change. Use at your own risk. Not endorsed by Riot Games.

## Features

- **Account switching** — Switch accounts and launch Valorant automatically
- **Secure sessions** — Auth cookies encrypted with OS-level encryption (safeStorage/DPAPI)
- **Settings copy** — Copy all settings between accounts.
- **Import accounts** — Import from a running Riot Client session
- **Session health check** — Verify if account sessions are still valid
- **Nicknames & reorder** — Label accounts and drag to reorder
- **Auto-launch toggle** — Launch Valorant automatically or just open Riot Client
- **Auto-updater** — Seamless updates from GitHub Releases
- **Dark/Light/System themes** — Purple-accented UI built with React + shadcn/ui

## How It Works

Nebula uses a **snapshot & restore** approach for account switching:

1. When you add an account, Nebula captures the Riot Client's auth files
2. On launch, it restores those files and starts the Riot Client with `--launch-product=valorant`
3. If auto-launch doesn't trigger (common on account switches), the `product-launcher` local API kicks in as a fallback
4. Sessions are re-snapshotted after each successful Valorant launch to keep cookies fresh

Cloud settings are transferred via Riot's **SGP player-preferences API** (`player-preferences-{shard}.pp.sgp.pvp.net`), using the `riot-client` OAuth client for proper RBAC permissions.

## Install

Download the latest `.exe` from [Releases](https://github.com/v1niii/Nebula/releases).

## Build from Source

```bash
git clone https://github.com/v1niii/Nebula.git
cd Nebula
npm install
cd renderer && npm install && cd ..
npm run build:renderer
npm start
```

## Tech Stack

- **Electron 28** — Desktop app framework
- **React + Vite** — Frontend
- **Tailwind CSS + shadcn/ui** — Styling
- **safeStorage (DPAPI)** — Cookie encryption
- **electron-updater** — Auto-updates

## Credits

Originally based on [hybrid1ze/Nebula](https://github.com/hybrid1ze/Nebula). Rewritten and expanded by [v1niii](https://github.com/v1niii).

## License

MIT
