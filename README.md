# Nebula

A fast, secure Valorant account manager. Switch between accounts with one click.

> **Disclaimer:** This project interacts with unofficial Riot Games APIs and is subject to change. Use at your own risk. Not endorsed by Riot Games.

## Features

- **One-click account switching** — Launch Valorant logged into any saved account
- **Secure login** — Authenticate via Riot's official login page (webview), no credentials stored
- **Session management** — Cookies encrypted with OS-level encryption (safeStorage/DPAPI)
- **Import accounts** — Import from a running Riot Client (lockfile + YAML)
- **Session health check** — Verify if a session is still valid
- **Copy game settings** — Transfer crosshair, keybinds, and video settings between accounts
- **Nicknames & reorder** — Label accounts and drag to reorder
- **Auto-launch toggle** — Choose to launch Valorant automatically or just open Riot Client
- **Auto-updater** — Seamless updates from GitHub Releases
- **Dark/Light/System themes** — Purple-accented UI built with React + shadcn/ui

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

- **Electron** — Desktop app framework
- **React + Vite** — Frontend
- **Tailwind CSS + shadcn/ui** — Styling
- **safeStorage (DPAPI)** — Cookie encryption
- **electron-updater** — Auto-updates

## Credits

Originally based on [hybrid1ze/Nebula](https://github.com/hybrid1ze/Nebula). Rewritten and expanded by [v1niii](https://github.com/v1niii).

## License

MIT
