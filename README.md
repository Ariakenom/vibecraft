# VibeCraft

A small real-time strategy game in the spirit of Empire Earth, for up to four
players (people or computer). The game logic is Rust compiled to
WebAssembly; the 3D view is three.js; the interface, input and networking
are plain JavaScript. Everything ships as one HTML file.

Play it at https://ginnu.freemyip.com/vibecraft/ (see Deployment). A copy
also runs as a claude.ai artifact, but multiplayer there is unreliable
(claude.ai's room service), so treat that one as single player.

## Quick start

    rustup target add wasm32-unknown-unknown   # once
    ./build.sh                                   # writes dist/vibecraft.html

Open `dist/vibecraft.html` in a browser. No server or bundler is needed:
the .wasm and our scripts are embedded in the page. three.js loads from
cdn.jsdelivr.net, so the page needs an internet connection.

`build.sh` also works where the wasm target can't be installed: with
`BUILD_STD=1` it builds Rust's standard library from source
(`-Zbuild-std`), which needs the `rust-src` component.

For multiplayer from your own copy, run the relay too: `node server.js`
(no dependencies), and put its address under "Relay server" on the start
screen. Friends on your network use your computer's address, e.g.
`ws://192.168.1.20:8787`. You can test alone with several browser windows.

## Repository layout

| File                 | What it does                                                    |
|----------------------|-----------------------------------------------------------------|
| src/defs.rs          | Unit and building kinds, stats, costs, tech requirements, limits, damage table |
| src/econ.rs          | An economy calculator: the fewest buildings for each era and a silo (tests use it) |
| src/map.rs           | Tile map and the symmetric map generator                        |
| src/path.rs          | A* pathfinding                                                  |
| src/game.rs          | The simulation: orders, movement, slots, building, combat, fog, victory |
| src/ai.rs            | The computer opponent                                           |
| src/save.rs          | Saving and loading: the whole game to bytes and back            |
| src/lib.rs           | The Rust/JavaScript boundary: exported functions, render buffers, the two multiplayer copies |
| web/index.html       | Page layout and styles; lists the scripts below                 |
| web/main.js          | Game loop, camera, input, HUD, lobby, saving, multiplayer glue, the trace panel |
| web/render3d.js      | three.js scene: terrain, water, models, effects, fog of war, picking, icons, graphics setting |
| web/audio.js         | Synthesized sound effects (Web Audio), volume                   |
| web/net.js           | Multiplayer: transports, the trace, `Server` and `Client`       |
| web/watch.js         | Recording games, replays, spectators, and watching after you're out |
| web/chat.js          | Chat between everyone in the room (lobby and game)              |
| server.js            | The WebSocket relay that carries multiplayer messages           |
| assets/models.py     | Builds the 3D models in Blender and writes web/models.glb (see assets/README.md) |
| web/models.glb       | The models, embedded in the page by build.sh                    |
| deploy/              | nginx and relay config for the live site, applied by hand (see Deployment) |
| test/                | Tests that run with plain Node (see Testing)                    |
| dist/vibecraft.html  | The built game, checked in so it can be deployed as is          |

## How the pieces fit

**The simulation is Rust and owns all game state.** `Game::tick` advances
the world by one fixed step of 50 ms (20 ticks a second). Nothing in the
simulation looks at the clock, the screen or the network.

**JavaScript drives it through plain numeric exports** (`#[unsafe(no_mangle)]
pub extern "C" fn` in `src/lib.rs`). There's no binding generator: every
export takes and returns numbers. Larger data moves through buffers in wasm
memory. For example, each frame JS calls `render()`, which writes every
visible entity as 18 floats (`ENT_STRIDE`; field offsets are `F` in
`main.js`), and JS reads that straight out of `memory.buffer`. Lists going
the other way, like the ids in a command, go through `scratch_ptr()`.

**Every player action is a command:** a flat array of numbers
`[code, arg, x, y, ...ids]`, built in `issue()` in `main.js` and applied by
`command()` in `lib.rs`. Codes: 1 smart order (right-click), 2 attack-move,
3 stop, 4 train, 5 cancel, 6 place a building, 7 hand a player to the
computer (only the host sends this), 8 surrender. In single player, `issue()` applies it
at once. In multiplayer it's applied at once too, and sent to the host.

**Starting up** shows a loading screen (`#boot` in `index.html`) from the
first paint: the page then loads the wasm, sets up three.js and the models,
builds the title map and compiles the shaders, pausing a frame between
steps so the progress bar moves (`Boot` in `main.js`). Its clouds, banner
and shimmer move only while the page waits on the network; once the page
is busy they hold still, because on a machine without a fast graphics
card, animating meanwhile made the first frame several times slower.

**Drawing** (`render3d.js`) reads the render buffers each frame and
interpolates every unit between its previous and current tick position
(`px/py` to `x/y`), so motion is smooth at any frame rate. The models come
from `web/models.glb`, made in Blender by `assets/models.py`, with simpler
models built in code as a fallback.

## Rules that must not break

Multiplayer and saves rely on these. Break one and games drift apart, or
loaded games misbehave.

1. **The simulation is deterministic.** Same start plus same commands on
   the same ticks gives the same game on every computer. So in the
   simulation:
   - no randomness except seeded from the game (the map seed);
   - no clock, no `HashMap` iteration order, nothing that varies by machine;
   - floats only through operations that are exact in IEEE (they are, in wasm).
2. **All input goes through commands.** Anything that changes the game must
   be a command, so it can be sent, ordered and replayed. Selection and the
   camera aren't commands, since they don't change the game.
3. **Command arguments are exact.** `issue()` rounds x and y to 1/100 of a
   tile once; everyone then applies exactly those numbers. `cleanCmd()`
   checks the shape of anything that arrives from the network.
4. **Commands from JS are re-run.** Multiplayer re-applies commands when it
   corrects a prediction. `applyCmd()` therefore has no side effects
   (sounds, messages); those belong in the code that calls `issue()`.
5. **What a computer shows never changes the game.** `local` (whose eyes
   we look through), `reveal` (fog lifted), the fog itself, `seen` and the
   selection are view-only: no rule may read them. Spectators and replays
   look at the same game in different ways and must still run it
   identically (`the_view_never_changes_the_game` checks this).
6. **The whole game can be copied.** `Game` derives `Clone` (multiplayer
   keeps two copies). A new field must be `Clone` too. Scratch buffers that
   don't affect results can skip copying, like `Pathfinder` does.
7. **Saved structs and the save format change together.** Change a struct
   that `src/save.rs` writes, and update `save` and `load` together and bump
   `VERSION`. Older saves are then refused rather than misread.
8. **Network messages change with `NET.PROTOCOL`.** Bump it in `net.js`
   whenever a message's meaning changes; players on different versions then
   simply don't see each other's games.

## Common changes

**Tune a unit or building.** Stats, slot costs, what producers make, their
workers and the builders a foundation needs are the `static … Stats` lines
in `src/defs.rs`. Tech requirements are `Kind::requires`; a kind's era is
`Kind::era`. The population numbers (`growth_interval`, beds per good, goods
per house tier) are constants there too, and so is `UNSUPPLIED_DAMAGE`.
Units are kinds 0–63, buildings 64 and up.

**Add a building or unit kind.**
- Rust:
  - add it to `Kind` and `Kind::ALL` in `src/defs.rs` (`ALL`'s order is
    the tech tree's);
  - give it stats in `Kind::stats`, its requirements and era, and (for
    buildings) a place in `BUILDABLE`;
  - if the AI should build it, add it to `PLAN` in `src/ai.rs`.
- JS:
  - add it to `K`, `NAMES` and `DESC` in `main.js`, and for buildings to
    `BUILD_MENU` (hotkey). The tech tree builds itself from Rust's data;
  - give it a model: in `assets/models.py` (rebuild `web/models.glb`; see
    `assets/README.md`), and a fallback in `unitModel` or `buildingModel` in
    `render3d.js`.
- Saves store kinds as numbers, so a new kind doesn't need a new `VERSION`.

**Add a resource.** Add it to `Res` and `Res::ALL` in `src/defs.rs` with its
era (and `is_house_good` if houses want it), and its name to `RES_NAMES` and
an icon to `RES_ICON` in `main.js`. Players' slot arrays grow with `N_RES`.

**The economy, in one place.** `Game::resolve` (`src/game.rs`) recounts
everything each tick in the design's fixed order: crews (house goods'
producers first), supply, use, unsupplied units, house goods nearest the
Capitol first, residents who no longer fit. Only houses' residents and
goods are saved; `Game::recount` works out the rest after a load.

**Add a command.**
- Add a `Command` variant and its handling in `Game::apply` (`src/game.rs`),
  and a code in `command()` (`src/lib.rs`).
- Allow the code in `cleanCmd()` (`main.js`), and send it from the interface
  through `issue()`.
- Bump `NET.PROTOCOL`.

**Add simulation state.** Add the field. Make sure it's `Clone`. Write it in
`save`/`load` and bump the save `VERSION`. If it should catch drift between
players, include it in `Game::checksum`.

## Testing

    cargo test --release      # the simulation: saves, surrender, views, slots, people, a whole AI game
    ./build.sh
    node test/wasm.mjs        # two copies stay identical; copy/restore; timings
    node test/relay.cjs       # the relay: allowed pages, limits, heartbeat, bad messages
    test/browser/run.sh       # headless Chromium: replays, surrender, spectators, seats changing hands (see the script for setup)

To watch two computer players play, minute by minute:

    VC_SEED=7 VC_MINUTES=60 VC_EVERY=5 cargo test --release watch_the_ai -- --ignored --nocapture

(also `VC_DIFF` 0–2 and `VC_PLAYERS` 2–4). It prints what each has and its
people, beds and slots: the quickest way to see whether an economy change
still plays.

The fewest buildings each era step and an armed missile silo take, from
the tables in `src/defs.rs` (the test fails if any kind is needed more than
7 times):

    cargo test --release econ -- --nocapture

What happened in a downloaded replay (the end screen and the replay bar
have Download): eras, Capitols and players lost, nukes, deaths by town,
armies standing in someone else's town, refused orders:

    node test/replay-report.mjs game.vibecraft [dist/vibecraft.html]

The browser tests check the things that matter by checksum: a replay at
any tick is the game at that tick, and a spectator's copy is the players'
confirmed game, tick for tick.

For multiplayer, open the page in two browser windows: one hosts, the other
opens the invite link. Press F8 in a game for the network details (see
below).

## Multiplayer

### The idea

Every computer runs the same simulation, and only commands travel.

Everyone follows **one clock**: tick numbers kept by the host, 20 a second.
A command is stamped with the tick it was given on. The player who gave it
applies it at once, so their own units react instantly, host and guest
alike.

Each computer keeps **two copies** of the game (`mp_save`, `mp_swap`,
`mp_restore` in `src/lib.rs`):

- the **live** copy, which you see and play in, at "now";
- the **confirmed** copy, a short **window** behind now (100–200 ms
  usually), which only moves forward with commands in their final order.

The **server** (`Server` in `net.js`) runs in the host's tab and keeps no
game state. It collects commands. When confirmed time reaches a tick, it
puts that tick's commands into a **bundle** (ordered by player, then by the
order each gave them) and sends the bundle to everyone.

Every player, the host included, runs a **client** (`Client`). It steps its
confirmed copy with each bundle and compares the bundle with what its live
copy assumed for that tick. Almost always they match, and nothing happens.
When they don't, the live copy is replaced by the confirmed one and the ticks
since are run again, with every command not yet confirmed. That takes about
a millisecond. Units that moved slide to their new place over 150 ms instead
of jumping.

The server also passes every command on the moment it arrives (**early
news**), so the other players can put it into their live copy right away.
That costs one correction, but friends' actions show up a single network trip
after they were given, instead of a window later. Early news is only a hint;
bundles are what everyone agrees on.

### Timeline of one command

Guest B, with a 60 ms round trip to the host, gives an order on tick 100:

| When (host time) | What happens |
|---|---|
| tick 100 | B's live copy applies it at once; B's units move. B sends it, stamped 100. |
| about 30 ms later | The host's server receives it, passes it on as early news, and the host's live copy rewinds to put it in at tick 100. |
| about 60 ms later | Other guests receive the early news and do the same. |
| tick 102 | Confirmed time reaches tick 100 (window 2). The server bundles it and everyone's confirmed copy applies it, matching what their live copies did. |

### Edge cases

- **A late command**, one that reaches the server after its tick was already
  bundled, goes into the next tick still open. The giver's prediction then
  turns out wrong by a tick or two, and a correction moves their units
  slightly. The server also grows the window by one tick, so the next ones
  arrive in time.
- **The window** is sized from each guest's measured ping: half a round trip
  plus twice the wobble plus 25 ms. It grows at once, but shrinks only after
  5 calm seconds, one tick at a time, so a ping right on a boundary doesn't
  make it flap.
- **A guest's clock** is the host's tick count plus half the round trip,
  taken from the most hopeful recent message and adjusted gently. The host
  measures how far off each guest's clock is (shown in the trace).
- **Pause and speed.** The host can pause (P) and set the speed (1×, 1.5×,
  2×) for everyone. The simulation doesn't change: only how many ticks come
  a second. The server's clock runs at `rate` (0 while paused), the frames
  carry it, and guests' clocks follow it (a new rate restarts their
  estimate). Orders given while paused go in once it runs again. The
  window, counted in ticks, grows with the speed.
- **Slow computers and connections.** Nobody waits for them. Each guest
  says how many ticks it lags behind the clock (`lag`); after 3 s of more
  than 20 the host is told that player's computer can't keep up (and the
  player too), and after 3 s of silence that their connection is
  struggling. A lagging computer's commands arrive late and move to later
  ticks, but don't lengthen the window, and its slow round trips don't
  count towards it: the others keep playing as before.
- **Running ahead.** The live copy may run at most 3 s ahead of the
  confirmed copy. If confirmations stop, the game waits.
- **The end.** The game is over when the confirmed copy says so, not the
  live one, so the recording (and what spectators get) has the ending too.
- **Drift.** Checksums of the confirmed copy are compared every second.
  Drift ends the game for everyone; it means a determinism bug.
- **Someone leaving.** The host notices them gone from the room, or silent
  for 20 s, and puts "the computer takes over" (command 7) into a bundle.
  The frames also list who has left (`left`), so everyone is told at once,
  even while the game is paused and that bundle is still to come.
- **Seats changing hands.** In the menu during a game, the host can give a
  seat the computer plays (from the start, or since its player left) to a
  spectator (see Watching).
- **Lost messages.** Every message repeats what the other side hasn't
  acknowledged, so losing some only delays things.

### The trace (F8)

Press F8, or Net, during a game. It shows:
- ping, window and clock error;
- how often the live copy predicted the confirmed one exactly (the whole
  game, and your own things);
- corrections and their causes, and whether a correction ever changed your
  own things or your selection;
- how soon friends' commands showed up;
- late commands, drift, stalls and message rates;
- slow frames: for any frame that came more than 70 ms after the one
  before, how much of that time was our own work, split into the game,
  drawing, the graphics card and the HUD. The rest was spent outside the
  page: the browser cleaning up memory, another tab, or the computer. Where
  the browser reports it (Chrome, Edge), memory freed at that moment and
  long tasks are recorded too.

"Copy trace" copies a second-by-second recording as JSON, for debugging.

### Messages

Two topics carry the game itself. Every message carries
`v: NET.PROTOCOL`.

- `cmd`, guest to host: `{from, token, cmds: [[seq, stamp, cmd], …], ack,
  sum, echo, gt, est, lag}`. `cmds` lists unconfirmed commands, `ack` is the
  newest tick held, `sum` is a recent confirmed checksum, and `echo`, `gt`
  and `est` are for ping and clock.
- `frame`, host to everyone: `{upTo, ticks: [[tick, bundle], …], early,
  now, rate, w, acks, sum, ge, ce, late, end}`. Every tick up to `upTo` is final,
  and ticks not listed had no commands. `early` holds commands not yet
  bundled.
- `watch`, `feed` and `seat`: spectators (see Watching).
- `chat`: `{id, token, name, slot, text}`, to everyone (see Chat).

### Lobby and transports

- **The lobby.** The start screen has four seats. Opening the page makes
  you the host of your own lobby. Friends join with an invite link (the
  page address plus `#CODE`) and take an open seat, or a computer's if none
  is open. Begin with no friends seated is single player.
- **Rooms.** Each lobby is a room named after its code; the game runs in
  that room, and the host's presence there carries the seat list
  (`openOwnLobby`, `joinLobby`, `beginGame` in `main.js`).
- **Transports.** Rooms are either the relay (`server.js`, through
  `openSocket`) or, on claude.ai, its room service (`wrapClaudeRoom`).
  Both look the same to the rest of the code: `emit`, `on`, `presence`,
  `onPeers`, `leave`.

### The relay

`server.js` knows nothing about the game. It joins clients into named rooms
and forwards messages within a room. It:
- accepts only pages from its own site (`ALLOWED_ORIGINS`, default
  `https://ginnu.freemyip.com`), local copies and home-network addresses;
- limits connections (`MAX_CONNECTIONS`, `MAX_PER_IP`), message size
  (16 KB), stored presence (8 KB per connection) and rate (60 messages a
  second), closing connections that keep flooding;
- ignores malformed messages;
- pings every 30 s and drops connections that stay silent.

## Watching: replays and spectators

Three ways to watch a game share one **observer mode** (`web/watch.js`):
the fog lifted, a scoreboard of every player, no commands. Click a
player's name to see the game through their eyes (their fog and resource
bar; the fog starts from what they see at that moment, since only one
player's fog history is kept). The view is set with `set_view` in
`lib.rs` and never changes the game (rule 5).

- **After you're out.** Lose your Capitol, or surrender (Menu → Surrender,
  two clicks), while others play on: "Watch the rest" or leave. Single
  player can then run up to 8×.
- **Replays.** Every game is recorded (`Rec`): where it started, as save
  bytes, plus each tick's commands as `[player, seq, ...cmd]`. Single
  player records commands as they're given; multiplayer records the
  confirmed bundles. Playing back loads the start and applies each tick's
  commands before running it, which gives the very same game. Games over
  20 s are kept in the browser (the latest 6, `vibecraft.replays`), and can
  be downloaded as a file. Jumping back loads the nearest keyframe (a save
  taken every minute while playing) and runs forward from there.
- **Spectators.** A watch link (`#watch-CODE`, in the menu and the lobby)
  joins the host's room as a `watcher`. The host's page answers out of
  `Rec` (`Watchers`): first a snapshot of the game (a save, gzipped, in
  12 KB pieces because of the relay's message limit; made afresh when the
  last one is over 10 s old), then each tick's commands from there on. The
  watcher runs its own copy, a little behind the players, and catches up
  faster if it falls behind. The feed carries the game's speed (`rate`, 0
  while paused), and the watcher plays at that speed. Nothing waits for spectators, and there's a
  budget (12 messages a second, 6 spectators per game) so they can't slow
  the game. A friend waiting in the lobby while the host plays gets "Watch
  their game". Spectators follow the host into the next game, and keep a
  replay of what they watched. Players see "N watching" in the top bar.
  Spectating works over the relay, not claude.ai's room service.
- **Taking a seat.** The host's menu lists the seats during a game, and a
  seat the computer plays can be given to a spectator ("Spectator 3": the
  host numbers them as they arrive, and each sees their number). The
  server (`Server.claim`) picks a tick T a second ahead and puts "a person
  takes over" (command 13, the opposite of 7) into that tick's bundle, so
  every copy changes on the same tick. The spectator's copy stops right
  after tick T (it is fed the confirmed bundles, so it is then exactly the
  host's confirmed copy), becomes their confirmed copy, and goes on as a
  guest's `Client` from tick T+1; the server keeps every bundle after T for
  them. Their commands continue the seat's numbering (`seq0`). A
  single-player game turns into a multiplayer one first, there and then,
  with the host's page as the server. A seat not taken up within 30 s goes
  back to the computer, and so does the seat of a new player who leaves.

Spectator messages, both carrying `v` and the watcher's `token`:
- `watch`, watcher to host, twice a second: `{game, have, snap, parts}`:
  which game, how many ticks of it they hold (`-1`: no snapshot yet), and
  which snapshot pieces.
- `feed`, host to one watcher (`to`): `{game, snap: {id, T, i, n, z, data,
  meta}}` (a snapshot piece), or `{game, from, upTo, ticks, over}` (the
  commands of ticks `from` to `upTo - 1`), or `{game: null}` (no game on).
  Each carries `n`, the watcher's number.
- `seat`, host to everyone, every 0.5 s while seats are on their way:
  `{game, gameId, host, offers: [{to, slot, T, seq0}, …]}`.

## Names

Everyone can pick a name in the lobby ("Your name"); until then they get a
random one from history (Hannibal, Uppsala, Timbuktu…). It's kept in the
browser (`vibecraft.name`), at most 16 characters, without markup
characters. It travels in each page's presence (`name`); the host's start
message carries the game's names (`names`, slot to name), and during a game
the host's presence keeps them up to date (a spectator who takes a seat
brings theirs; a seat the computer takes back loses it). Seats without a
name go by their colour. Names are in the lobby, chat, toasts, the
scoreboard, the end screen, the host's seat menu, snapshots and replays.

## Chat

Everyone in the room can talk: players and spectators, in the lobby (a box
under the seats) and in the game (Enter or the Chat button opens the line,
Enter sends, Escape closes; lines fade after 12 s). It's not part of the
simulation and never in replays: messages go straight through the room on
the `chat` topic. Names are the one the sender picked, or else their colour,
"Spectator" or "Guest"; the colour of the line is their seat's. Text is
shown as text, at most 200 characters, and a page sends at most one message
every 0.4 s. Relay only, like spectating (claude.ai's room keeps only the
latest value, which would drop messages).

## Saving

Single player only:
- **Save:** Menu → Save game, or Ctrl+S, stores the game in the browser
  (localStorage, the newest 8).
- **Load:** Menu → Load game, or "Load a saved game" on the start screen,
  lists them.
- **Files:** Download turns a save into a `.vibecraft` file that "Load from
  a file…" reads back, on any computer. (Download doesn't work in the
  claude.ai copy.)

`Game::save` in `src/save.rs` writes the complete simulation state as
little-endian bytes, floats bit for bit, so a loaded game carries on exactly
as the saved one would have; `cargo test` checks this. The page wraps those
bytes, gzipped, in a JSON envelope with the camera and control groups.

## Deployment

The game runs at https://ginnu.freemyip.com/vibecraft/ on the host `ginnu`
(Ubuntu, reached with `ssh ginnu`). The server's own setup (systemd units,
nginx, the autodeploy script) is kept in the `Ariakenom/devops` repo under
`ginnu/`; that copy is what's live.

| On the server                                    | From                          | Updated |
|--------------------------------------------------|-------------------------------|---------|
| `/var/www/vibecraft/index.html`                  | `dist/vibecraft.html`         | automatically |
| `/opt/vibecraft/server.js`                       | `server.js`                   | automatically |
| `/etc/systemd/system/vibecraft-relay.service`    | `deploy/vibecraft-relay.service` (Node 12 from apt, port 8787) | by hand |
| `/etc/nginx/snippets/vibecraft.conf`             | `deploy/nginx-vibecraft.conf`, included from the HTTPS server block in `/etc/nginx/conf.d/chatapp.conf` | by hand |

nginx serves the page at `/vibecraft/` (gzipped: 2 MB becomes about 0.5 MB; `Cache-Control: no-cache`, so browsers reuse their copy after a quick check) and proxies the WebSocket at
`/vibecraft/relay` to the relay on 127.0.0.1:8787 (the firewall keeps 8787
closed). Only the freemyip name has a certificate; the Tailscale name
redirects to HTTPS and fails the certificate check.

**The page and the relay deploy themselves.** Every minute
`vibecraft-autodeploy.timer` on ginnu checks GitHub's `main`. When it has
moved, ginnu copies over the page and `server.js` if they changed and writes
the deployed commit to https://ginnu.freemyip.com/vibecraft/version.txt.
A changed `server.js` restarts the relay (`vibecraft-relay-restart.path`
watches the file). So pushing to `main` is deploying: commit the rebuilt
`dist/vibecraft.html` along with the source. Safeguards: a page without its
wasm is refused, `server.js` must pass `node --check`, and the previous files
are kept in `/opt/vibecraft/backup/`. See what happened with
`ssh ginnu journalctl -u vibecraft-autodeploy -n 30`.

**System config is not deployed from here.** The autodeploy runs as the
unprivileged user `vibecraft`, which can write only `/opt/vibecraft` and
`/var/www/vibecraft`; it never installs systemd units or nginx config, so a
push to `main` can't gain root on ginnu. When you change
`deploy/vibecraft-relay.service` or `deploy/nginx-vibecraft.conf`, apply it
by hand (below) and copy it into the devops repo. The deploy log notes these
files on every deploy as a reminder.

The autodeploy itself (script, units, setup) lives in the devops repo.

To update by hand:

    ./build.sh && scp dist/vibecraft.html ginnu:/var/www/vibecraft/index.html
    # if server.js changed:
    scp server.js ginnu:/tmp/ && ssh -t ginnu 'sudo install -o vibecraft -g vibecraft -m 644 /tmp/server.js /opt/vibecraft/server.js'   # the relay restarts itself
    # if deploy/vibecraft-relay.service changed:
    scp deploy/vibecraft-relay.service ginnu:/tmp/ && ssh -t ginnu 'sudo mv /tmp/vibecraft-relay.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart vibecraft-relay'
    # if deploy/nginx-vibecraft.conf changed:
    scp deploy/nginx-vibecraft.conf ginnu:/tmp/ && ssh -t ginnu 'sudo mv /tmp/nginx-vibecraft.conf /etc/nginx/snippets/vibecraft.conf && sudo nginx -t && sudo systemctl reload nginx'

Players must reload the page after an update: different `NET.PROTOCOL`
versions don't play together.

## The game

- **Winning:** destroy every rival Capitol. From the Medieval era a player
  can found as many as they like (8 wood, 8 stone, 6 brick, 4 builders; the
  first holds nothing). Losing one costs only that one; lose the last (a
  foundation doesn't count) and you're out. The campfire burns at your
  oldest Capitol.
- **The start:** a Capitol (2 wood, 1 stone, 1 grain and 1 fruit by itself,
  and 4 beds), nobody and no houses. Four newcomers arrive at the campfire
  over the first half minute to fill the Capitol's beds: they build the
  first lumber camp, and the first hut from the Capitol's wood and food. (There was a
  Wonder victory; it was removed in October 2026.)
- **Seven of a kind, as a target.** The numbers are tuned so a town
  needn't have more than 7 buildings of any one kind (`MAX_SAME`), apart
  from farms, houses and Capitols. It isn't a rule for players (the computer
  keeps to it). Later producers make far more: `src/econ.rs` works out the
  fewest buildings that get a player to an armed missile silo (61, at most
  4 of a kind).
- **Progress comes from buildings, not research.** Each building unlocks
  others. Press K for the tech tree. Six eras are planned (the design is
  `docs/design/economy-and-eras.md`, the work plan
  `docs/plan/economy-and-eras-plan.md`); all six are in: Ancient,
  Medieval, Gunpowder, Industrial, Modern and Atomic.
- **Resources are slots.** Nothing is gathered or stockpiled:
  producers make slots (a lumber camp by a forest makes 8 wood), and
  everything you have holds some while it exists, giving them back when
  it's gone. Lose a producer and you hold more than you make: your newest
  units that need it lose health until it fits again.
- **People are workers you can see.** A hut gets 2 beds for each
  different food it receives (up to 3 kinds); bigger houses get 3 for each
  good past the third (a tower block with 13 goods has 36). While there's a free bed, a
  newcomer appears at the campfire in front of the Capitol (faster as the
  town grows). Workers idle in the campfire circle are free; they walk off
  by themselves to build foundations, work producers and become soldiers.
  A producer works only while its workers stand at it, so raids that kill
  them hurt. Move its workers away to pause it.
- **Eras.** A full hut with three foods can be upgraded to a cottage
  (select it and press Upgrade, Z; a green arrow marks houses that are
  ready), if a wood and a stone are free. Houses never fall back: one that
  loses goods keeps its kind, with fewer beds. Ten cottages bring the Medieval era: iron
  mines, brickworks, sheep farms and the converters (a bakery turns grain
  into bread, a weaver wool into clothes, a brewery grain into beer), which
  hold their inputs while they stand; pastures and stables, horsemen,
  swordsmen, crossbowmen, knights and trebuchets. Counters go by class: spears and swords beat riders, riders
  beat bows and crossbows, they beat foot soldiers; trebuchets smash
  buildings.
  Ten townhouses (full cottages with five goods, grown with brick) bring
  the Gunpowder era: saltpeter works and powder mills, carpenters,
  printers and the circus; musketeers, dragoons and cannon.
  Ten tenements (full townhouses with seven goods, grown with more brick) bring
  the Industrial era: coal mines, steel mills, explosives works,
  canneries, coal yards, presses and factories; riflemen, machine gunners
  and field guns.
  Ten apartment blocks (full tenements with nine goods) bring the Modern
  era: oil wells, bauxite mines, power plants, radio factories, the
  Haber–Bosch plant (nitrate without saltpeter), tank works and airfields;
  infantry, tanks, fighters and bombers. **Aircraft** fly straight over
  water and buildings and only fighters, machine gunners, infantry, towers
  and the Capitol can hit them; bombers flatten buildings but need fighters
  to protect them.
  Ten tower blocks (full apartment blocks with eleven goods) bring the
  Atomic era: uranium mines, reactors, car and TV plants, rocket artillery,
  jets, and the **missile silo**. Everyone is told when a silo is built,
  when it starts arming and when the nuke is ready. A silo arms a nuke in
  two minutes (holding 2 uranium and 2 explosives); launched, it flies for
  20 seconds, with a red ring on the ground for everyone, then destroys
  everything within 15 tiles, its owner's things too, and leaves a crater
  nothing can cross or build on. An **Air Defense** (Modern) shoots at
  aircraft and shoots down a nuke falling within 10 tiles of it, then
  reloads for 90 seconds.
- **Production:** later producers make more: Medieval ones about twice
  what Ancient ones do, Industrial ones and later three to four times. The
  basics come in bulk later: a Sawmill (Medieval), a Stone Works and a Kiln
  (Gunpowder). Brickworks, sawmills and kilns need no wood, so a town using
  every slot of wood can always build its way out.
- **Area damage:** cannon, field guns, rocket artillery and bombers hurt
  everything hostile around where they hit (half their attack at the
  middle, less further out).
- **The computer** explores before it builds: it uses only deposits it has
  seen, so it sends its first soldier round the map (it doesn't stop to
  fight on the way). It gathers each attack wave before it goes, clears
  enemy soldiers out of its town, founds a second Capitol in the
  Gunpowder era, and tears down a spare building when it's at the limit for
  something it needs. Easy, Normal and Hard
  differ in how much of its people it puts under arms, how soon it attacks,
  and its supply (80%, 100%, 130%).
- **Maps:** two players get a 120×120 map with 180° symmetry; three or four
  get 144×144 with four-way symmetry, so every start is the same, just turned.
  The sea runs along every edge (fishing huts can stand on the coast), and a
  base's deposits lie 1.5 times as far out as on the first, 80-tile maps.
  More lie out on the map, the same for everyone: clay, iron, coal,
  saltpeter, sheep hills, oil and bauxite as well as the Ancient ones.
  A deposit that would sit in a lake moves to the nearest dry land, and
  slivers of land in water (and of water in land) are tidied away.
  The Capitol sees 16 tiles, enough for its own start.
- **Fights:** units go for what fights back first (soldiers, then towers and
  the Capitol), then workers, then other buildings, and turn from a worker
  to a soldier who shows up.
- **Builders** walk to a foundation and build it while they stand there; it
  shows up only once the first of them gets there (until then its owner sees
  a mark on the ground). As many come as will work there, and when it's
  done they become its crew at once; the rest go back to the campfire. A lumber camp takes one
  worker. The Capitol shows how soon the next newcomer comes, and the cap
  (beds).

**Controls.**
- **Camera:** WASD, arrows or the edges of the browser window move it; the wheel zooms;
  middle-drag rotates and tilts.
- **Hotkey order:** Q, E, R, T, F, G, C, V, B, Y, U, I, O, J, L, N: the left
  hand's keys first. Buildings, era pages and training all go by it.
- **Build:** the menu has a page per era (Shift+E Ancient, Shift+R
  Medieval, Shift+T Gunpowder, Shift+F Industrial, Shift+G Modern, Shift+C
  Atomic; or Tab for the next, Shift+Tab back), and each page's buildings
  take the hotkeys in order. Ancient: Q hut, E farm, R lumber camp, T
  quarry, F fishing hut, G hunting lodge, C orchard, V barracks, B range,
  Y tower. (Pastures, stables and horsemen come in the Medieval era.) Shift+Q or Del (twice) demolishes the
  selected buildings, or disbands the selected units.
- **Missile silo:** Z arms a nuke, then Z again and a click launches it
  (a ring shows the blast, and blue rings the cover of enemy air defenses).
- **Train:** Q, E, R, T, … for the units the selected buildings train,
  oldest first (with several kinds of building selected, every unit still
  gets a key).
- **Other keys:**
  - Z attack-move (every unit, workers too), X stop
  - H home, `.` free workers (at the campfire)
  - Z on a producer: pause or resume it
  - Ctrl+1–9 make a group, 1–9 recall it
  - K tech tree, P pause (online: the host, for everyone), M sound, Ctrl+S save, F8 network details
  - Enter: chat. Menu: surrender, save a replay (any game, online too), copy a watch link for spectators, and
    (the host) give a computer's seat to a spectator
