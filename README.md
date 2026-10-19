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
| web/net.js      | Multiplayer: server, client (prediction), transports, trace      |
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

Up to four players, any mix of people and computer players. Every
computer runs the same deterministic simulation and only commands travel
(`Command` in `src/game.rs`, `issue()` in `web/main.js`).

Everyone follows one clock (20 ticks a second, kept by the host). A command
is stamped with the tick it was given on and applied at once by the player
who gave it, so your own units react instantly. Each computer keeps two
copies of the game (`mp_save` / `mp_swap` / `mp_restore` in `src/lib.rs`):
the **live** copy you play in, at "now", and the **confirmed** copy, a short
window behind, which only moves forward with commands in their final order.

- The **server** (`Server` in `web/net.js`, inside the host's tab) collects
  everyone's commands. When the confirmed time reaches a tick, it bundles
  the commands stamped for it and sends the bundle to every client. The
  window is sized from the measured ping so commands arrive in time; a late
  one goes into the next open tick.
- Every player, the host too, runs a **client** (`Client`). It steps its
  confirmed copy with each bundle and compares it with what the live copy
  did. Usually they match and nothing happens. When a friend's command was
  in the bundle, the live copy is replaced by the confirmed one and the
  ticks since are run again with your own unconfirmed commands (about a
  millisecond). Friends' actions show up one network trip late.

Checksums of the confirmed copy are compared every second; drift ends the
game for everyone. If a guest leaves, the host puts "the computer takes over"
into a bundle. No pausing or speed changes. The game steps on animation
frames and, in a background tab, on a Web Worker clock.

Press F8 (or Net) during a game for the network details: ping, window, how
often predictions were right (whole game, and your own things), corrections
and why, whether a correction ever changed your own things or your
selection, how late friends' commands show up, late commands, drift, stalls
and message rates. "Copy trace" copies a second-by-second recording as JSON.

The start screen is a lobby with four seats. Opening the page makes you the
host of your own lobby; the other seats each hold a computer player or are
left open. Friends join with an invite link (the page address plus `#CODE`)
and take an open seat, or a computer's if none is open. The host can give a
friend's seat back to the computer or remove them. Begin with no friends
seated is a single-player game. Each lobby is a room named after its code,
and the game runs in that same room; the host's presence there carries the
seat list (`openOwnLobby`, `joinLobby`, `beginGame` in `web/main.js`).

- On the published claude.ai page: links can't reach the page inside
  claude.ai, so everyone's lobby is listed instead ("Join game XXXXXX"), and
  invite links can be pasted. Friends must be signed in and invited to the
  artifact (Viewer is enough: everything travels as room *presence*, which
  anyone in the room may set). The small line under the lobby shows what
  claude.ai's room reports, for troubleshooting. Browser privacy features
  (Firefox tracking protection, ad blockers) can block it.
- From your own copy (`dist/vibecraft.html`): run `node server.js` (no
  dependencies) and enter its address under "Relay server", e.g.
  `ws://192.168.1.20:8787` for friends on your network. Friends with their
  own copy paste your invite link. You can test alone with several windows.
- From a web server: serve the page and proxy `./relay` next to it to
  `server.js`; the page then fills in that relay address by itself
  (`wss://<host>/<path>/relay`), so invite links just work.

The relay only accepts pages from its own site (`ALLOWED_ORIGINS`, default
`https://ginnu.freemyip.com`), local copies and home-network addresses,
limits connections (`MAX_CONNECTIONS`, `MAX_PER_IP`), message size (16 KB),
stored state (8 KB per connection) and message rate (60 a second, closing
connections that keep flooding), shrugs off malformed messages, and pings
every 30 s to drop connections that have gone quiet.

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
    scp server.js ginnu:/opt/vibecraft/ && ssh -t ginnu sudo systemctl restart vibecraft-relay
    # if deploy/nginx-vibecraft.conf changed:
    scp deploy/nginx-vibecraft.conf ginnu:/tmp/ && ssh -t ginnu 'sudo mv /tmp/nginx-vibecraft.conf /etc/nginx/snippets/vibecraft.conf && sudo nginx -t && sudo systemctl reload nginx'

## Players and maps

Two players get an 80×80 map with 180° symmetry; three or four get 96×96
with four-way symmetry, so every start is the same, just turned. Lose your
Capitol and you're out: everything you own falls with it. Last one standing
wins, or whoever finishes a Wonder first.
