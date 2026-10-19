# VibeCraft

A small RTS in the spirit of Empire Earth. Game logic is Rust compiled to
WebAssembly; the 3D view is three.js, and the UI and input are plain JavaScript.

## Build

    rustup target add wasm32-unknown-unknown   # once
    ./build.sh                                   # writes dist/vibecraft.html

Open `dist/vibecraft.html` in a browser. No server or bundler needed:
the .wasm and our scripts are embedded in the page. three.js loads from
cdn.jsdelivr.net, so the page needs an internet connection.

## Code map

| File            | What it does                                                     |
|-----------------|------------------------------------------------------------------|
| src/defs.rs     | Unit/building stats, costs, rock-paper-scissors damage table     |
| src/map.rs      | Tile map, noise-based symmetric map generator                    |
| src/path.rs     | A* pathfinding                                                   |
| src/game.rs     | The simulation: orders, movement, gathering, combat, fog          |
| src/ai.rs       | The computer opponent                                            |
| src/save.rs     | Saving and loading: the whole game to bytes and back              |
| src/lib.rs      | The Rust/JavaScript boundary (exported functions, render buffers)|
| web/index.html  | Page layout and styles; lists the scripts below                  |
| web/main.js     | Game loop, camera, input, HUD, minimap                           |
| web/render3d.js | three.js scene: terrain, water, grass, models, fog of war, picking, icons |
| web/audio.js    | Synthesized sound effects (Web Audio)                            |
| web/net.js      | Multiplayer: lockstep, plus transports (claude.ai room / relay)  |
| server.js       | A tiny WebSocket relay for multiplayer from your own copy        |

The sim runs at a fixed 20 ticks/second (`Game::tick`). Each frame JS calls
`render()`, which writes every visible entity as 18 floats into a buffer, and
reads that buffer straight out of wasm memory.

## Rules worth knowing

- Win by destroying the enemy Capitol, or by finishing a Wonder. (The AI
  goes for a Wonder too, on Normal and Hard.)
- Progress comes from buildings, not research: each building unlocks others
  (`Kind::requires` in `src/defs.rs`) and gives a lasting bonus
  (`Bonuses::from_buildings`). Press K in game for the tech tree.
- There's no population cap. Every unit eats food each minute (see `upkeep`
  in `src/defs.rs`); if the granary empties, your units slowly lose health.
- One citizen per farm.

## Controls

WASD / arrows / screen edges move the camera, the wheel zooms, middle-drag
rotates and tilts. Build: Q farm, E settlement, R barracks, T granary,
Y sawmill, U range, I stonemason, O tower, F smithy, G stable, C market,
V temple, B wonder. Train: Q. K tech tree. Z attack-move, X stop, H home, `.` idle
citizen, Ctrl+1–9 groups, P pause, M sound, Ctrl+S save.

## Saving

Single player only. Menu → Save game (or Ctrl+S) stores the game in the
browser (localStorage, the newest 8); Menu → Load game, or "Load a saved
game" on the title screen, lists them. Download turns a save into a
`.vibecraft` file that "Load from a file…" reads back, on any computer.

`Game::save` in `src/save.rs` writes the complete simulation state as
little-endian bytes, floats bit for bit, so a loaded game carries on exactly
as the saved one would have (`cargo test` checks this). The page wraps those
bytes, gzipped, in a JSON envelope with the camera and control groups.
Change any saved struct and you must update `save`/`load` together and bump
`VERSION`; older saves are then refused rather than misread.

## Multiplayer

Up to four players, any mix of people and computer players. Lockstep:
every computer runs the same deterministic simulation and only commands
travel (`Command` in `src/game.rs`, `issue()` in `web/main.js`). The host
sequences them: guests send commands to the host, the host bundles each
turn's commands from everyone into a numbered frame and broadcasts it, and
everyone runs the frames in order (`HostSeq` / `ClientSeq` in `web/net.js`).
A checksum of the game state is compared every second to catch desyncs. If
a guest leaves, the host puts "the computer takes over" into the next frame.
No pausing or speed changes. In multiplayer the game steps on a Web Worker
clock rather than on animation frames, so a slow graphics card or a
background tab doesn't hold everyone else up.

- On the published claude.ai page: "Host a game" gives a 4-letter code;
  friends open the same page and join, then the host picks how many computer
  players to add and starts. Friends must be signed in and invited to the
  artifact (any access level, Viewer is enough: everything travels as
  room *presence*, which anyone in the room may set). The line under "Play
  with a friend" shows what claude.ai's room reports, for troubleshooting.
  Browser privacy features (Firefox tracking protection, ad blockers) can
  block it.
- From your own copy (`dist/vibecraft.html`): run `node server.js` (no
  dependencies), then everyone uses the relay address shown under "Play with
  a friend", e.g. `ws://192.168.1.20:8787` for friends on your network. You
  can test alone with several browser windows.
- From a web server: serve the page and proxy `./relay` next to it to
  `server.js`; the page then fills in that relay address by itself
  (`wss://<host>/<path>/relay`), so friends just open the URL.

## Deployment

The game runs at https://ginnu.freemyip.com/vibecraft/ (host `ginnu`, Ubuntu,
reached with `ssh ginnu`). The files in `deploy/` are the server config:

| On the server                                    | From                          |
|--------------------------------------------------|-------------------------------|
| `/var/www/vibecraft/index.html`                  | `dist/vibecraft.html`         |
| `/opt/vibecraft/server.js`                       | `server.js`                   |
| `/etc/systemd/system/vibecraft-relay.service`    | `deploy/vibecraft-relay.service` (Node 12 from apt, port 8787) |
| `/etc/nginx/snippets/vibecraft.conf`             | `deploy/nginx-vibecraft.conf`, included from the HTTPS server block in `/etc/nginx/conf.d/chatapp.conf` |

nginx serves the page at `/vibecraft/` and proxies the WebSocket at
`/vibecraft/relay` to the relay on 127.0.0.1:8787 (the firewall keeps 8787
closed). Only the freemyip name has a certificate; the Tailscale name
redirects to HTTPS and fails the certificate check.

To update:

    ./build.sh && scp dist/vibecraft.html ginnu:/var/www/vibecraft/index.html
    # if server.js changed:
    scp server.js ginnu:/opt/vibecraft/ && ssh ginnu systemctl restart vibecraft-relay

## Players and maps

Two players get an 80×80 map with 180° symmetry; three or four get 96×96
with four-way symmetry, so every start is the same, just turned. Lose your
Capitol and you're out: everything you own falls with it. Last one standing
wins, or whoever finishes a Wonder first.
