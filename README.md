<p align="center">
  <img src="https://xrctz.github.io/ai-game-lab/showcase/previews/deadtakeover.png" alt="DeadTakeover — zombie survival FPS" width="720" />
</p>

<h1 align="center">DeadTakeover</h1>

<p align="center">
  Browser-based open-world zombie survival FPS built with <strong>Three.js</strong> and <strong>Vite</strong>.
</p>

<p align="center">
  <a href="https://xrctz.github.io/ai-game-lab/play/?game=zombie"><strong>Play now</strong></a>
  &nbsp;·&nbsp;
  <a href="https://xrctz.github.io/ai-game-lab/">AI Game Lab hub</a>
  &nbsp;·&nbsp;
  <a href="Zombie%20Open%20World%20Game/README.md">Game README</a>
</p>

<p align="center">
  <a href="https://xrctz.github.io/ai-game-lab/play/?game=zombie"><img src="https://img.shields.io/badge/play-live-ff6eb4?style=for-the-badge&logo=githubpages&logoColor=white" alt="Play live" /></a>
  <a href="https://github.com/xrctz/ai-game-lab"><img src="https://img.shields.io/badge/hub-ai--game--lab-2a1228?style=for-the-badge&logo=github" alt="AI Game Lab" /></a>
  <img src="https://img.shields.io/badge/engine-Three.js-7dffb8?style=for-the-badge" alt="Three.js" />
  <img src="https://img.shields.io/badge/build-Vite-ffb7d5?style=for-the-badge" alt="Vite" />
</p>

---

## Overview

Fight through escalating hordes, scavenge materials, build barricades, and survive across hostile maps with AI teammates. DeadTakeover runs entirely in the browser — no install required.

## Live demo

**Hosted build (recommended):**  
https://xrctz.github.io/ai-game-lab/play/?game=zombie

The public hub ([AI Game Lab](https://github.com/xrctz/ai-game-lab)) embeds the production bundle from `games/zombie/` with Lab+ overlays, quality presets, and pointer-lock fixes.

## Gameplay highlights

| Feature | Details |
| --- | --- |
| **Maps** | Verdant Meadows, Dead Valley, Frost Expanse, Badlands, Ruined City, Outbreak City |
| **Combat** | Weapon switching, ADS, grenades, melee, floating damage numbers, kill streaks |
| **Survival** | Barricades (wood/metal), scavenging, perks, day/night and weather pressure |
| **Enemies** | Special infected: Spitter, Hunter, Charger, Crawler, Juggernaut, Boomer, Screamer |
| **Squad** | AI teammates that support combat and survival |

## Quick start (local)

Source lives in **`Zombie Open World Game/`**:

```bash
cd "Zombie Open World Game"
npm install
npm run dev
```

Open the Vite URL from your terminal (usually **http://localhost:5173**).

### Build for production

```bash
npm run build
npm run preview
```

Copy the `dist/` output into [ai-game-lab](https://github.com/xrctz/ai-game-lab) `games/zombie/` when publishing an updated hosted build.

## Controls (summary)

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Sprint / Crouch / Jump | `Shift` / `C` / `Space` |
| Shoot / ADS / Reload | `LMB` / `RMB` / `R` |
| Weapons | `Q` `E` · slots `1` `2` `3` |
| Grenade / Melee / Build | `G` / `F` / `B` |
| Pause / Mute | `P` / `M` |

Full control reference: [Zombie Open World Game/README.md](Zombie%20Open%20World%20Game/README.md)

## Repository layout

```text
DeadTakeover/
├── Zombie Open World Game/   # Vite + Three.js source
│   ├── src/                  # Game logic
│   ├── public/               # Static assets & inject scripts
│   └── dist/                 # Production build output
├── docs/                     # Additional documentation
└── index.html                # Legacy / redirect entry (if present)
```

## Tech stack

- [Three.js](https://threejs.org/) — WebGL rendering
- [Vite](https://vitejs.dev/) — Dev server and bundling
- Web Audio API · HTML5 canvas HUD

## Credits

Asset and audio attribution is documented in [Zombie Open World Game/README.md](Zombie%20Open%20World%20Game/README.md) (Kenney CC0 kits, Webaverse pistol, Kevin MacLeod music, and others).

## License

MIT — see [LICENSE](LICENSE). Third-party assets retain their original licenses.
