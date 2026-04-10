# Nebula

A fast, secure Valorant account manager. Switch between accounts seamlessly.

> **Disclaimer:** This project interacts with unofficial Riot Games APIs and is subject to change. Use at your own risk. Not endorsed by Riot Games.

## Features

- **Account switching** — Switch accounts and launch Valorant automatically
- **Secure sessions** — Auth cookies encrypted with OS-level encryption (safeStorage/DPAPI)
- **Settings copy** — Copy all settings between accounts.
- **Import accounts** — Import accounts from your Riot Client.
- **Session health check** — Verify if account sessions are still valid
- **Nicknames & reorder** — Label accounts and drag to reorder
- **Auto-launch toggle** — Launch Valorant automatically or just open Riot Client
- **Auto-updater** — Seamless updates from GitHub Releases
- **Dark/Light/System themes** — Purple-accented UI built with React + shadcn/ui

## Install

Download the latest `.exe` from [Releases](https://github.com/v1niii/Nebula/releases).

> **Windows SmartScreen warning?** When you run the installer, Windows may show a blue "Windows protected your PC" screen. This is **normal** for any unsigned app — Nebula is open source and I don't pay for an EV code-signing certificate (~$300/year). The warning doesn't mean the app is unsafe; it just means Microsoft hasn't built up reputation for this publisher yet.
>
> **To bypass it:** click **More info** → **Run anyway**. You can also verify the installer by checking out the source code in this repo and building it yourself.

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
