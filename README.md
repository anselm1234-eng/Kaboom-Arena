## 👤 Author

**Anselm Wrenna**
- GitHub: [@anselm1234-eng](https://github.com/anselm1234-eng)

# Kaboom Arena

A free multiplayer bomb-arena browser game. Authoritative Node.js
WebSocket server, canvas client with snapshot interpolation, quick-match
matchmaking and private password-protected lobbies.

## Stack

- **`packages/shared`** — game constants, 15×13 map generation, zod-validated
  message protocol (discriminated unions, validated on both ends).
- **`packages/server`** — Node.js + TypeScript + `ws`. Fully authoritative:
  clients send only inputs; the server simulates at 20 Hz and broadcasts
  snapshots. Also serves the built client in production. Persistence is
  SQLite (better-sqlite3) through Drizzle ORM — `src/db/schema.ts` is the
  single source of truth for tables, row types and generated migrations.
- **`packages/client`** — Vite + TypeScript canvas client. Renders at 60 fps,
  interpolating player positions ~100 ms behind server time.

## Visuals

8-bit pixel-art renderer: a 272×240 internal canvas (16×16 tiles + arena
border) upscaled with the largest integer factor that fits the viewport
(`image-rendering: pixelated`, no anti-aliasing, whole-pixel coordinates).
Everything uses the PICO-8 16-color palette — sprites are generated at
startup from 2D palette-index arrays (`src/sprites.ts`), so PNG spritesheets
could replace them later without touching the renderer. Includes 2-frame walk
cycles with 4 palette-swapped characters, spin-pop-ghost death animation,
4-frame cross explosions, crate crumble, powerup bob/sparkle, screen shake,
pixel particles, a 3×5 bitmap font for in-canvas text, and a Press Start 2P
DOM UI.

Visual verification (headless Chrome + palette purity check):

```bash
node packages/client/scripts/shots.mjs       # screenshots demo scenes to /tmp/kaboom-arena-shots
Demo scenes also run standalone in a browser: /?demo=lobby|start|game|explosion|win
(&bare=1 hides the HUD, &perf=1 runs a max-load render benchmark).

Gameplay
15×13 grid: fixed pillar pattern, ~70% randomized crates, 4 cleared spawn corners.

Move with WASD / arrows, drop bombs with Space (1 concurrent, range 2 by default).

Bombs: 3 s fuse, cross-shaped blast stopped by pillars, destroys crates,
chain-detonates other bombs, kills players.

Powerups drop from crates (30%): 💣 +bomb, 🔥 +range, 👟 +speed.

Last player alive wins the round; 5 s later a fresh round starts on a new map.

Multiplayer
Quick match: enter a nickname, hit Play — you join a public room with
a free slot (or a new one is created). Public rooms are hostless: each
device gets a big Ready button (it covers all of its local players) and
the match starts (3 s countdown) as soon as all present players are ready
(2+ participants). Readying up arms a 60 s
anti-stall timer; when it expires the match launches with every connected
player, ready or not, auto-filling with bots up to 4 participants if
needed. Anyone can add or remove
bots (rate-limited), and a human joining a full lobby displaces a bot.
Mid-round joiners spectate and play from the next round; matchmaking
backfills rooms that drop below 4 players.

Private lobbies: create one, share the /room/:id link (optional
password). The first player is the host (crown icon) and starts the game
manually once 2+ players are in; the host alone manages bots, and if the
host leaves, the room migrates to the next player.

Disconnects kill your character but the room survives; reconnecting within
10 s rejoins you as a spectator for the next round.

Accounts (optional)
Playing never requires an account: every player silently gets an anonymous
account (httpOnly cookie session) on their first PLAY, so progression can
accumulate from the very first match. Signing up with email + password
(under ACCOUNT on the landing page) upgrades that same account in place —
guest progress carries over. Verification and password-reset emails go
through Resend (RESEND_API_KEY; without it, emails
are logged to the server console, which is handy in development). Passwords
are scrypt-hashed; session and email tokens are stored only as SHA-256
hashes.

Development
bash
pnpm install
pnpm dev        # server on :8080 (tsx watch) + client on :5173 (vite)
Open http://localhost:5173 in two browser tabs, hit Play in both, then
Ready up in both — you will be matched into the same room and the round
starts after the countdown.
For private lobbies: Create private lobby in one tab, copy the invite
link into the other.

bash
pnpm test       # vitest: map gen, protocol, game sim, rooms, matchmaking
pnpm build      # typecheck + bundle server (esbuild) + build client (vite)
node packages/server/scripts/smoke.mjs   # end-to-end check against the built server