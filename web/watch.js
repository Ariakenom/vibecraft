"use strict";
// ===========================================================================
// Watching games: replays, spectators, and players who are out.
//
// RECORDING. The simulation is deterministic, so a whole game is just where
// it started plus every command, stamped with the tick it ran on. `Rec`
// keeps that for the game being played: the start as save bytes (so a game
// loaded from a save, or joined halfway as a spectator, records fine too),
// and the commands in the same [player, seq, ...cmd] form multiplayer
// bundles use. Single player records each command as it's given; multiplayer
// records the confirmed bundles, the order everyone agreed on.
//
// A REPLAY is that recording played back: load the start, then before each
// tick apply that tick's commands. Going back means loading the nearest
// keyframe (a save taken every minute while playing) and running forward.
//
// SPECTATING. Someone with a watch link (#watch-CODE) joins the host's room
// as a "watcher". The host's page sends them a snapshot of the game (a save,
// in pieces small enough for the relay), then every tick's commands from
// there on, out of `Rec`. The watcher runs its own copy of the game, which
// stays identical for the same reason replays do. Watchers aren't players:
// nothing waits for them, and a slow one only falls behind itself.
//
// All three show the game in OBSERVER MODE: the fog lifted (or seen through
// one player's eyes), a scoreboard, and no commands.

// This build (filled in by build.sh; null when the page runs unbuilt), and
// the commit the server says it deployed (fetched at start, live site only).
const BUILD_INFO = /*BUILD_INFO*/null;
let deployedCommit = null;
// (Only where a server writes version.txt: the live site, over https.)
if (location.protocol === "https:" && !/claude\.ai|claudeusercontent/.test(location.hostname)) try { fetch("version.txt?t=" + Date.now(), { cache: "no-store" }).then(r => r.ok ? r.text() : "").then(t => { const c = t.trim().split(/\s+/)[0]; if (/^[0-9a-f]{7,40}$/.test(c)) deployedCommit = c; }).catch(() => {}); } catch { /* no fetch here */ }
// Which version of the game made a replay: compare with `git log` to tell
// whether today's game would play it the same (`sim` must match for that).
function versionInfo() {
  return Object.assign({ protocol: NET.PROTOCOL, replay: REPLAY_FORMAT, deployed: deployedCommit }, BUILD_INFO || { sim: null, base: null });
}
// (Format 2: the rules changed, builders stay on and maps are bigger. Since
// then replays say which version made them (`version`), and rule changes
// don't change the format: an old replay still opens, with a warning, so
// it can be looked at with the version that made it.)
const REPLAY_FORMAT = 2, REPLAY_KEY = "vibecraft.replays", REPLAY_MAX = 6;
const REPLAY_MIN_TICKS = 400;       // games shorter than 20 s aren't kept
const KEYFRAME_EVERY = 1200;        // ticks between replay keyframes (1 minute)
const WATCH = {
  CHUNK: 12000,       // characters of snapshot per message (the relay takes 16 KB)
  FEED_BYTES: 6000,   // commands per feed message, at most
  FEED_MS: 250,       // how often each watcher is sent news
  ASK_MS: 500,        // how often a watcher says what it has
  MAX: 6,             // watchers one game serves
  RATE: 12,           // messages a second, for all watchers together
  REFRESH: 200,       // ticks before a new snapshot is worth making (10 s)
};

// ---- bytes <-> text ----
async function packBytes(bytes) {
  if (window.CompressionStream) {
    try { return { z: true, data: toB64(await pipeBytes(bytes, new CompressionStream("gzip"))) }; } catch { /* keep it raw */ }
  }
  return { z: false, data: toB64(bytes) };
}
async function unpackBytes(data, z) {
  const bytes = fromB64(data);
  if (!z) return bytes;
  if (!window.DecompressionStream) throw new Error("This browser can't open compressed games.");
  return pipeBytes(bytes, new DecompressionStream("gzip"));
}
// Replace the game with saved bytes. True if they were a game we can read.
function loadBytes(bytes) {
  u8(W.load_buffer(bytes.length), bytes.length).set(bytes);
  return !!W.load_game(bytes.length);
}
function saveBytes() {
  const n = W.save_game();
  return u8(W.save_ptr(), n).slice();
}

// ===========================================================================
// The recording of the current game
const Rec = {
  id: null,           // this game, for spectators to tell games apart
  start: null,        // save bytes at tick `base`
  base: 0,            // the source's tick count at the start (spectators join late)
  cmds: new Map(),    // tick -> [[player, seq, ...cmd], ...] (ticks counted from the start)
  keys: [],           // the ticks in `cmds`, in order
  ticks: 0,           // ticks run so far, counted from the start
  seq: 0,
  meta: null,
  real: false,        // a game someone played (not the map behind the title screen)
  done: true,
  replay: null,       // a promise of the finished replay, once `finish` ran

  begin(meta = {}) {
    this.finish();
    this.start = saveBytes();
    this.id = randomCode() + Date.now().toString(36);
    this.base = meta.base || 0;
    this.cmds = new Map(); this.keys = []; this.ticks = 0; this.seq = 0;
    this.meta = Object.assign({ version: versionInfo(), players: W.n_players(), difficulty: W.game_difficulty(), startTime: W.game_time(), me: ME, who: {} }, meta);
    this.real = false; this.done = false; this.replay = null;
  },
  // A command on tick `k` (the source's count).
  add(k, entry) {
    if (this.done) return;
    k -= this.base;
    let list = this.cmds.get(k);
    if (!list) { list = []; this.cmds.set(k, list); this.keys.push(k); }
    list.push(entry);
  },
  // Single player: my command, before the next tick.
  mine(cmd) { this.add(simTick, [ME, ++this.seq, ...cmd]); },
  // Multiplayer: a tick's bundle, confirmed.
  bundle(k, bundle) {
    for (const e of bundle) this.add(k, e);
    if (!this.done) this.ticks = k + 1 - this.base;
  },
  // Commands for ticks from..to-1 (counted from the start), up to about
  // `maxBytes` of them. `upTo` is where the list stops.
  range(from, to, maxBytes) {
    const keys = this.keys, ticks = [];
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < from) lo = m + 1; else hi = m; }
    let size = 0;
    for (let i = lo; i < keys.length && keys[i] < to; i++) {
      const list = this.cmds.get(keys[i]), len = JSON.stringify(list).length + 8;
      if (size + len > maxBytes && ticks.length) return { ticks, upTo: keys[i] };
      size += len;
      ticks.push([keys[i], list]);
    }
    return { ticks, upTo: to };
  },
  // The game is over (or abandoned). Keeps it among the replays if it was
  // long enough; either way it can be watched now (`replay`).
  finish(result = "Not finished") {
    if (this.done) return this.replay;
    this.done = true;
    if (!this.real) return null;
    const r = this.object(String(result).replace(/\.$/, ""));
    this.replay = (async () => {
      Object.assign(r, await packBytes(this.start));
      if (r.ticks >= REPLAY_MIN_TICKS) storeReplay(r);
      return r;
    })().catch(() => null);
    return this.replay;
  },
  object(result) {
    return {
      format: REPLAY_FORMAT, kind: "replay", id: this.id, saved: Date.now(),
      players: this.meta.players, difficulty: this.meta.difficulty, me: this.meta.me, who: this.meta.who, names: this.meta.names || {},
      mp: !!this.meta.mp, watched: !!this.meta.watched, startTime: this.meta.startTime,
      ticks: this.ticks, result, version: this.meta.version || versionInfo(), log: this.keys.map(k => [k, this.cmds.get(k)]),
    };
  },
  // Keep the game so far among the replays (the menu's Save replay, in any
  // game, multiplayer too). The same game saved again, or finished, replaces
  // it. Returns whether it was kept.
  async saveNow() {
    if (this.done || !this.real || !this.start) return false;
    const r = this.object("Not finished (saved)");
    Object.assign(r, await packBytes(this.start));
    return storeReplay(r);
  },
  // The page is closing: keep the game as it stands, uncompressed (there's
  // no time to compress it).
  storeNow() {
    if (this.done || !this.real || this.ticks < REPLAY_MIN_TICKS) return;
    this.done = true;
    storeReplay(Object.assign(this.object("Not finished"), { z: false, data: toB64(this.start) }));
  },
};
window.addEventListener("pagehide", () => Rec.storeNow());

function readReplays() {
  try { const v = JSON.parse(localStorage.getItem(REPLAY_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
// Newest first. Out of room: drop the oldest until it fits.
function writeReplays(list) {
  for (let keep = list.length; keep >= 0; keep--) {
    try { localStorage.setItem(REPLAY_KEY, JSON.stringify(list.slice(0, keep))); return keep; }
    catch { /* quota, or storage blocked */ }
  }
  return 0;
}
// Keep `r` among the replays. If the browser has no room even for it
// alone, say so: it can still be downloaded from the end screen.
function storeReplay(r) {
  const kept = writeReplays([r, ...readReplays().filter(x => x.id !== r.id)].slice(0, REPLAY_MAX));
  if (kept === 0 && typeof toast === "function") toast("This replay is too big to keep in the browser. Download it from the end screen (or the replay bar) to keep it.", "bad");
  return kept > 0;
}

// Who the players were, for the scoreboard and the replay list.
function playersLine(r) {
  const n = r.players || 2, who = r.who || {};
  return [...Array(n)].map((_, i) => {
    const p = i + 1, w = who[p];
    const nm = r.names && cleanName(r.names[p]);
    return (nm ? `${nm} (${PNAME[p]})` : PNAME[p]) + (w === "human" ? (p === r.me && !r.watched ? " (you)" : nm ? "" : " (person)") : "");
  }).join(" · ");
}

// ===========================================================================
// Observer mode
let observe = null; // { kind: "out" | "watch" | "replay", view: 0 for the whole map, or a player, over }

function startObserving(kind) {
  observe = { kind, view: 0, over: false };
  placing = null; amode = false; updateCursor();
  W.clear_selection();
  document.body.classList.add("observing");
  document.body.dataset.observe = kind;
  setView(0);
  $("scoreboard").hidden = false;
  $("obsBar").hidden = false;
  $("obsLabel").textContent = kind === "out" ? "You're out of the game: watching" : kind === "watch" ? (watcher && watcher.n ? `Spectating (you're Spectator ${watcher.n})` : "Spectating") : "Replay";
  $("obsExit").textContent = kind === "replay" ? "Exit replay" : kind === "watch" ? "Stop watching" : "Leave game";
  // Pause and speed: in a replay they're on the bar; a live game can't be.
  $("pauseBtn").hidden = kind !== "out" || !!mp;
  $("speedBtn").hidden = kind !== "out" || !!mp;
  renderScoreboard(true);
  renderSelection(true);
}
function stopObserving() {
  observe = null;
  document.body.classList.remove("observing");
  delete document.body.dataset.observe;
  $("scoreboard").hidden = true;
  $("obsBar").hidden = true;
  selKey = "";
  try { renderSelection(true); } catch { /* no world yet */ }
}
// 0: the whole map. A player: through their eyes, with their numbers on top.
function setView(v) {
  if (!observe) return;
  observe.view = v;
  W.set_view(v || W.local_player(), v ? 0 : 1);
  refreshHud();
  // Go and look at their Capitol.
  if (v) for (let i = 0; i < entCount; i++) if (E(i, F.owner) === v && E(i, F.kind) === K.Capitol) { centerOn(E(i, F.x), E(i, F.y)); break; }
}
// Redraw what otherwise updates every few frames, after a jump or a new view.
function refreshHud() {
  updateFog(); readWorld();
  topBar = null; selKey = "";
  renderTopBar(); drawMinimap();
  renderScoreboard(true);
}
// After loading a save (replays, spectators), the view has to be set again.
function reapplyView() { if (observe) W.set_view(observe.view || W.local_player(), observe.view ? 0 : 1); }

let sbKey = "";
function renderScoreboard(force) {
  if (!observe) return;
  const n = W.n_players(), body = $("sbBody");
  const rows = [];
  for (let p = 1; p <= n; p++) {
    const out = W.defeated(p);
    rows.push([p, out, W.player_people(p, 4), W.player_units(p, 1), [R.wood, R.stone, R.grain, R.horses].map(r => W.player_supply(p, r))]);
  }
  const key = JSON.stringify(rows) + observe.view + JSON.stringify(pnames);
  if (!force && key === sbKey) return;
  sbKey = key;
  const who = (Rec.meta && Rec.meta.who) || {};
  body.replaceChildren();
  for (const [p, out, units, army, stock] of rows) {
    const tr = document.createElement("tr");
    tr.className = (out ? "out" : "") + (observe.view === p ? " viewing" : "");
    const name = document.createElement("td");
    const b = document.createElement("button");
    b.className = "sb-name"; b.style.color = PLIGHT[p];
    b.title = `See the game as ${pnc(p)} sees it`;
    b.setAttribute("aria-pressed", String(observe.view === p));
    b.innerHTML = `<i style="background:${PCOL[p]}"></i>`;
    b.append(pn(p)); // a name someone picked: text, never HTML
    const tag = p === ME && observe.kind === "out" ? "you" : out ? "out" : who[p] === "human" ? "" : who[p] === "computer" ? "AI" : "";
    if (tag) { const s = document.createElement("small"); s.textContent = tag; b.append(s); }
    b.onclick = () => setView(observe.view === p ? 0 : p);
    name.append(b);
    tr.append(name);
    for (const v of [units, army, ...stock]) { const td = document.createElement("td"); td.textContent = out ? "–" : v; tr.append(td); }
    body.append(tr);
  }
  $("sbAll").setAttribute("aria-pressed", String(observe.view === 0));
  $("sbTitle").textContent = observe.view ? `Seeing as ${pn(observe.view)}` : "Whole map";
}

// Called every frame in observer mode.
function syncObserverUi() {
  if (!observe) return;
  if (observe.kind === "replay") Replay.ui();
}

// The game is over, for someone watching (replays end on their own).
function observerOver() {
  if (!observe || observe.over) return;
  observe.over = true;
  const w = W.winner_player();
  const why = w ? `${pnc(w)} won.` : "The game is over.";
  if (observe.kind === "replay") { toast(why, "good"); return; }
  Rec.finish(why);
  $("endTitle").textContent = "Game over";
  $("endWhy").textContent = why + (observe.kind === "watch" ? " If the host starts another game, you'll see it here." : "");
  showEndStats({ watching: true });
}

// ===========================================================================
// Replays
const Replay = {
  on: false, data: null, cmds: new Map(), end: 0, k: 0, speed: 1,
  keyframes: new Map(), target: null, finished: false, lastUi: "",

  async open(data) {
    if (!data || data.kind !== "replay" || data.format !== REPLAY_FORMAT || typeof data.data !== "string" || !Array.isArray(data.log)) throw new Error("not a replay");
    const start = await unpackBytes(data.data, data.z);
    leaveWatching();
    finishMultiplayer(); lastWasMultiplayer = false;
    if (guestOf) openOwnLobby(); // we were waiting in someone's lobby
    Rec.finish();
    if (!loadBytes(start)) throw new Error("damaged");
    this.cmds = new Map();
    for (const e of data.log) if (Array.isArray(e) && Number.isInteger(e[0]) && Array.isArray(e[1])) this.cmds.set(e[0], e[1]);
    this.data = data; this.end = Math.max(0, data.ticks | 0); this.k = 0; this.speed = 1; this.target = null; this.finished = false;
    this.keyframes = new Map([[0, start]]);
    this.on = true;
    enterWorld(0);
    setNames(data.names);
    Rec.done = true; // watching a replay doesn't record one
    ME = 0;
    startObserving("replay");
    cam.x = MW / 2; cam.y = MH / 2; cam.dist = 40; clampCam();
    for (const id of ["loadScreen", "menuScreen", "startScreen", "endScreen", "outScreen"]) $(id).hidden = true;
    paused = false; acc = 0;
    running = true;
    publishLobby();
    this.ui(true);
    // Made by another version of the rules: it may play out differently.
    const v = data.version, now = BUILD_INFO && BUILD_INFO.sim;
    if (now && (!v || v.sim !== now)) toast(`This replay was made by ${v && v.base ? `an older version (built on ${v.base})` : "an older version"}: it may not play out as it went.`, "bad");
  },
  close() { this.on = false; this.data = null; this.cmds = new Map(); this.keyframes = new Map(); },

  // One tick: that tick's commands, then the tick.
  step() {
    const list = this.cmds.get(this.k);
    if (list) for (const e of list) {
      if (!Array.isArray(e) || typeof e[0] !== "number") continue;
      const c = cleanCmd(e.slice(2));
      if (c) applyCmd(e[0] >>> 0, c);
    }
    W.tick();
    this.k++;
    if (this.k % KEYFRAME_EVERY === 0 && !this.keyframes.has(this.k)) this.keyframes.set(this.k, saveBytes());
  },
  // Every frame. Returns how many ticks ran (for sounds).
  pump(dt) {
    if (this.target !== null) {
      // Seeking: run as many ticks as fit in a frame, quietly.
      const t0 = performance.now();
      while (this.k < this.target && performance.now() - t0 < 25) this.step();
      W.take_events();
      if (this.k >= this.target) { this.target = null; refreshHud(); this.atEnd(); }
      acc = 0;
      return 0;
    }
    if (paused || this.k >= this.end) return 0;
    acc += dt * 1000 * this.speed;
    let steps = 0;
    while (acc >= SIM_MS && steps < 4 * this.speed) {
      if (this.k >= this.end) { acc = 0; break; }
      this.step(); acc -= SIM_MS; steps++;
    }
    if (steps >= 4 * this.speed) acc = 0;
    this.atEnd();
    return steps;
  },
  // Reached the end: stop there and say how it ended.
  atEnd() {
    if (this.k < this.end || this.finished) return;
    this.finished = true;
    if (!paused) togglePause();
    const r = this.data.result;
    toast(r && r !== "Not finished" ? `End of the replay. ${r}.` : "End of the replay.", "good");
  },
  seek(t) {
    t = Math.max(0, Math.min(this.end, Math.round(t)));
    let best = 0;
    for (const k of this.keyframes.keys()) if (k <= t && k > best) best = k;
    // Back in time, or a keyframe closer than where we are: load it.
    if (t < this.k || best > this.k) {
      loadBytes(this.keyframes.get(best));
      this.k = best;
      reapplyView(); W.clear_selection();
    }
    if (t < this.end) this.finished = false;
    this.target = t;
  },
  setSpeed(s) { this.speed = s; this.ui(true); },
  // The replay bar.
  ui(force) {
    const seek = $("rpSeek");
    const key = `${this.k}|${paused}|${this.speed}|${this.target}`;
    if (!force && key === this.lastUi) return;
    this.lastUi = key;
    seek.max = String(this.end);
    if (document.activeElement !== seek || force) seek.value = String(this.target ?? this.k);
    const t0 = this.data ? this.data.startTime || 0 : 0;
    $("rpTime").textContent = `${fmtTime(t0 + (this.target ?? this.k) * SIM_MS / 1000)} / ${fmtTime(t0 + this.end * SIM_MS / 1000)}`;
    $("rpPlay").textContent = paused ? "Play" : "Pause";
    $("rpPlay").setAttribute("aria-pressed", String(!paused));
    for (const b of $("rpSpeed").children) b.setAttribute("aria-pressed", String(+b.dataset.s === this.speed));
  },
};

// ===========================================================================
// Spectating: the host's side. Answers watchers out of `Rec`.
const Watchers = {
  list: new Map(),    // token -> { have, game, parts: Set, snap, heard, sent }
  snap: null,         // { id, game, T, z, parts: [text...], meta } for the current game
  making: false,
  tokens: WATCH.RATE, filled: 0,
  count: 0,           // spectators numbered as they arrive ("Spectator 3"), so the host can tell them apart

  attach(r) {
    this.list.clear(); this.snap = null;
    r.on("watch", d => this.hear(d));
  },
  hear(d) {
    if (!d || d.v !== NET.PROTOCOL || !okToken(d.token) || d.token === myToken) return;
    let e = this.list.get(d.token);
    if (!e) {
      if (this.list.size >= WATCH.MAX) return;
      e = { have: -1, game: null, parts: new Set(), snap: null, heard: 0, sent: 0, n: ++this.count, name: "" };
      this.list.set(d.token, e);
    }
    e.heard = performance.now();
    e.name = cleanName(d.name);
    e.game = typeof d.game === "string" ? d.game : null;
    e.have = e.game === Rec.id && Number.isInteger(d.have) && d.have >= 0 ? d.have : -1;
    e.snap = typeof d.snap === "string" ? d.snap : null;
    e.parts = new Set(Array.isArray(d.parts) ? d.parts.filter(Number.isInteger) : []);
  },
  // Spectators who have the game running, who could take a seat: [[token, n]].
  ready() { return [...this.list].filter(([, e]) => e.game === Rec.id && e.have >= 0).map(([t, e]) => [t, e.n, e.name]); },
  number(token) { const e = this.list.get(token); return e ? e.n : 0; },
  nameOf(token) { const e = this.list.get(token); return e ? e.name : ""; },
  // How fast the game runs here (0: paused), so spectators play it back at that pace.
  rate() { return Rec.done ? 1 : mp ? mp.pace() : paused ? 0 : speed; },
  // Is there a game here to watch?
  serving() { return !!room && !guestOf && Rec.real && !!Rec.id; },
  spend() {
    const now = performance.now();
    this.tokens = Math.min(WATCH.RATE, this.tokens + (now - this.filled) * WATCH.RATE / 1000);
    this.filled = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  },
  // Called from the game loop (and the multiplayer clock).
  pump(now) {
    if (!this.list.size) return;
    for (const [t, e] of this.list) if (now - e.heard > 20000) this.list.delete(t);
    if (!this.serving()) {
      for (const [t, e] of this.list) if (now - e.sent > 1000 && this.spend()) { e.sent = now; room.emit("feed", { v: NET.PROTOCOL, to: t, game: null }); }
      return;
    }
    for (const [t, e] of this.list) {
      if (now - e.sent < WATCH.FEED_MS) continue;
      if (e.have < 0) { if (!Rec.done || this.snap) this.sendSnap(t, e, now); }
      else if (this.spend()) {
        e.sent = now;
        const { ticks, upTo } = Rec.range(e.have, Rec.ticks, WATCH.FEED_BYTES);
        room.emit("feed", { v: NET.PROTOCOL, to: t, game: Rec.id, from: e.have, upTo, ticks, over: Rec.done, n: e.n, rate: this.rate() });
      }
    }
  },
  sendSnap(t, e, now) {
    const s = this.snap;
    // A snapshot can be reused for as long as the game lasts (Rec keeps every
    // command since), but a fresher one saves the watcher catching up.
    const downloading = [...this.list.values()].some(x => s && x.have < 0 && x.snap === s.id && x.parts.size);
    // (Being made takes a moment: the next round sends it.)
    if (!s || s.game !== Rec.id || (!Rec.done && Rec.ticks - s.T > WATCH.REFRESH && !downloading)) { this.make(); return; }
    const snap = this.snap;
    const missing = [];
    for (let i = 0; i < snap.parts.length; i++) if (e.snap !== snap.id || !e.parts.has(i)) missing.push(i);
    e.sent = now;
    for (const i of missing.slice(0, 3)) {
      if (!this.spend()) break;
      room.emit("feed", { v: NET.PROTOCOL, to: t, game: Rec.id, snap: { id: snap.id, T: snap.T, i, n: snap.parts.length, z: snap.z, data: snap.parts[i], meta: snap.meta } });
    }
  },
  // A save of the game as it stands at Rec.ticks, with no command of that
  // tick applied yet (they come in the feed).
  make() {
    if (this.making) return;
    let bytes;
    if (mp) {
      // Multiplayer: the confirmed copy, which is exactly at Rec.ticks.
      if (mp.final + 1 !== Rec.ticks) return;
      W.mp_swap(); bytes = saveBytes(); W.mp_swap();
    } else {
      // Single player: right after a tick, before any command for the next.
      if (Rec.cmds.has(Rec.ticks) || simTick !== Rec.ticks) return;
      bytes = saveBytes();
    }
    const T = Rec.ticks, game = Rec.id, meta = { who: Rec.meta.who, names: pnames, players: Rec.meta.players, difficulty: Rec.meta.difficulty };
    this.making = true;
    packBytes(bytes).then(({ z, data }) => {
      const parts = [];
      for (let i = 0; i < data.length; i += WATCH.CHUNK) parts.push(data.slice(i, i + WATCH.CHUNK));
      if (game === Rec.id) this.snap = { id: randomCode(), game, T, z, parts, meta };
    }).finally(() => { this.making = false; });
  },
};

// ===========================================================================
// Spectating: the watcher's side.
let watcher = null;
const watchIn = text => { const m = String(text || "").trim().match(/#watch-([A-Za-z0-9]{6})$/); return m ? m[1].toUpperCase() : null; };
function watchLink() {
  const code = guestOf ? guestOf.code : roomCode;
  if (!room || !code || Net.room) return null; // on claude.ai there are no links
  return location.href.split("#")[0] + "#watch-" + code;
}

class Watcher {
  constructor(code, r) {
    this.code = code; this.room = r;
    this.game = null; this.snapId = null; this.parts = []; this.loading = false;
    this.loaded = false; this.k = 0; this.avail = 0; this.cmds = new Map();
    this.host = null; this.hostSeen = performance.now(); this.lastHeard = performance.now();
    this.ended = null;
    this.n = 0;          // which spectator I am, as the host counts us
    this.seat = null;    // { slot, T, seq0, gameId, host }: the host is handing me a seat
    this.rate = 1;       // how fast the host's game runs (0: paused), from the feed
    r.on("feed", d => this.receive(d));
    r.on("seat", d => this.offered(d));
    r.onPeers(p => this.peers(p));
    r.presence({ role: "watcher", v: NET.PROTOCOL, token: myToken, name: myName });
    this.timer = setInterval(() => this.ask(), WATCH.ASK_MS);
    this.ask();
  }
  // Tell the host what we have.
  ask() {
    const msg = { v: NET.PROTOCOL, token: myToken, name: myName, game: this.game, have: this.loaded ? this.avail : -1, snap: this.snapId, parts: this.parts.map((p, i) => p === undefined ? -1 : i).filter(i => i >= 0) };
    this.room.emit("watch", msg);
    this.status();
  }
  peers(peers) {
    if (!this.room) return; // not watching any more (maybe playing now)
    Chat.setOthers(peers.length);
    const host = peers.map(p => p.presence || {}).find(pr => pr.role === "host" && pr.v === NET.PROTOCOL && okToken(pr.token));
    if (host) { this.host = host; this.hostSeen = performance.now(); if (this.loaded && host.names && typeof host.names === "object") setNames(host.names); }
    else this.host = null;
    this.status();
  }
  // What the waiting card says, and giving up on a host that's gone.
  status() {
    const now = performance.now();
    if (!this.host && now - this.hostSeen > 10000) {
      if (this.loaded) { if (!this.ended) { this.ended = "The host has left."; toast("The host has left the game.", "bad"); } }
      else return stopWatching("That game isn't open any more.");
    }
    if (this.loaded) { this.showWait(); return; }
    const h = $("watchWait");
    h.hidden = false;
    $("watchWaitText").textContent = !this.host ? "Looking for the game…"
      : this.parts.length ? `Fetching the game… ${Math.round(100 * this.parts.filter(p => p !== undefined).length / this.parts.length)}%`
      : this.game === null && this.host && !this.host.playing ? "The host isn't in a game right now. You'll see the next one."
      : "Joining as a spectator…";
  }
  receive(d) {
    if (!this.room || !d || d.v !== NET.PROTOCOL || d.to !== myToken) return;
    this.lastHeard = performance.now();
    if (typeof d.rate === "number" && d.rate >= 0 && d.rate <= 16 && d.rate !== this.rate) {
      this.rate = d.rate;
      if (this.loaded) { paceChanged(d.rate); this.showWait(); }
    }
    if (Number.isInteger(d.n) && d.n > 0 && d.n !== this.n) { this.n = d.n; if (observe && observe.kind === "watch") $("obsLabel").textContent = `Spectating (you're Spectator ${d.n})`; }
    if (d.game === null) { if (!this.loaded) this.status(); return; }
    if (typeof d.game !== "string") return;
    if (d.game !== this.game) {
      // A different game (the host started a new one): start over.
      this.game = d.game; this.snapId = null; this.parts = [];
      if (this.loaded) { this.loaded = false; toast("A new game is starting. Fetching it…"); }
      this.cmds = new Map(); this.avail = 0;
    }
    const s = d.snap;
    if (s && !this.loaded && !this.loading && typeof s.id === "string" && Number.isInteger(s.i) && Number.isInteger(s.n) && s.n > 0 && s.n <= 200 && s.i >= 0 && s.i < s.n && typeof s.data === "string" && Number.isInteger(s.T) && s.T >= 0) {
      if (s.id !== this.snapId) { this.snapId = s.id; this.parts = new Array(s.n); }
      this.parts[s.i] = s.data;
      // (Count them: every() would skip the pieces not here yet.)
      if (this.parts.filter(p => typeof p === "string").length === s.n) this.load(s);
    }
    if (this.loaded && Number.isInteger(d.from) && Number.isInteger(d.upTo) && d.from <= this.avail && Array.isArray(d.ticks)) {
      for (const e of d.ticks) if (Array.isArray(e) && Number.isInteger(e[0]) && e[0] >= this.k && Array.isArray(e[1])) this.cmds.set(e[0], e[1]);
      this.avail = Math.max(this.avail, d.upTo);
    }
  }
  // The card in the middle: paused, or not hearing from the host.
  showWait() {
    const h = $("netWait");
    const lost = performance.now() - this.lastHeard > 4000, pausedHere = this.rate === 0 && this.k >= this.avail;
    h.hidden = !observe || observe.over || !(lost || pausedHere);
    if (!h.hidden) h.textContent = lost ? "Waiting for the game…" : `Paused by ${pnames[1] || "the host"}.`;
  }
  // The host is handing me a seat: run my copy up to the tick it changes
  // hands on, then play from there (takeSeat, in main.js).
  offered(d) {
    if (!this.room || !this.loaded || this.seat || !d || d.v !== NET.PROTOCOL || d.game !== this.game || !Array.isArray(d.offers)) return;
    const o = d.offers.find(o => o && o.to === myToken);
    if (!o || !Number.isInteger(o.slot) || o.slot < 2 || o.slot > W.n_players() || !Number.isInteger(o.T) || !Number.isInteger(o.seq0) || typeof d.gameId !== "string" || !okToken(d.host)) return;
    if (this.k > o.T + 1) return; // too late: we're past it (the host gives it back to the computer)
    this.seat = { slot: o.slot, T: o.T, seq0: o.seq0, gameId: d.gameId, host: d.host };
    toast(`The host is giving you ${PNAME[o.slot]}. Get ready…`, "good");
  }
  async load(s) {
    this.loading = true;
    try {
      const bytes = await unpackBytes(this.parts.join(""), s.z);
      if (!this.room || watcher !== this) return;
      if (!loadBytes(bytes)) return stopWatching("The game couldn't be read. Are you both on the latest version? Reload the page.");
      this.k = this.avail = s.T; this.loaded = true; this.ended = null;
      this.parts = [];
      enterWorld(0);
      const meta = s.meta && typeof s.meta === "object" ? s.meta : {};
      setNames(meta.names);
      Rec.begin({ base: s.T, watched: true, mp: true, who: meta.who && typeof meta.who === "object" ? meta.who : {}, names: pnames });
      Rec.real = true;
      ME = 0;
      startObserving("watch");
      lastPace = this.rate;
      if (this.rate !== 1 && this.rate !== 0) toast(`The game runs at ${this.rate}×.`);
      cam.x = MW / 2; cam.y = MH / 2; cam.dist = 40; clampCam();
      for (const id of ["startScreen", "endScreen", "watchWait", "loadScreen"]) $(id).hidden = true;
      acc = 0;
      running = true;
      toast("You're watching. Click a player's name to see what they see.", "good");
    } catch (e) {
      console.error("Couldn't start watching:", e);
      stopWatching("The game couldn't be read.");
    } finally { this.loading = false; }
  }
  // Many times a second (animation frames, and the worker clock when the tab
  // is hidden): run the ticks we have, at the game's own pace. Time is
  // measured here, not taken from the frame, so slow frames lose nothing.
  // Fall behind (a slow connection, a hidden tab) and it catches up faster.
  pump() {
    const now = performance.now();
    const dt = Math.min(1, (now - (this.lastPump || now)) / 1000);
    this.lastPump = now;
    if (!this.loaded) return 0;
    // Being handed a seat: stop right after the tick it changes hands on.
    const avail = this.seat ? Math.min(this.avail, this.seat.T + 1) : this.avail;
    const behind = avail - this.k;
    // Keep a small buffer (a few ticks) so play is smooth; anything beyond
    // that is drained a little faster than real time.
    // At the host's speed (paused: just finish what's here), and faster to catch up.
    const pace = this.rate || (behind > 0 ? 1 : 0);
    acc += dt * 1000 * pace * (behind > 600 * pace ? 16 : behind > 200 * pace ? 8 : behind > 40 * pace ? 2 : behind > 5 * pace ? 1.25 : 1);
    let steps = 0;
    while (acc >= SIM_MS && this.k < avail && steps < 60) { this.step(); acc -= SIM_MS; steps++; }
    if (this.k >= avail) acc = Math.min(acc, SIM_MS);
    if (this.seat && this.k === this.seat.T + 1) takeSeat(this);
    return steps;
  }
  step() {
    const k = this.k, list = this.cmds.get(k);
    if (list) for (const e of list) {
      if (!Array.isArray(e) || typeof e[0] !== "number") continue;
      const c = cleanCmd(e.slice(2));
      if (c) { applyCmd(e[0] >>> 0, c); Rec.add(k, e); }
    }
    this.cmds.delete(k);
    W.tick();
    this.k++;
    if (!Rec.done) Rec.ticks = this.k - Rec.base;
  }
  leave() {
    clearInterval(this.timer);
    this.room = null;
  }
}

async function startWatching(code) {
  if (!code) return;
  const gen = ++lobbyGen;
  closeRoom();
  guestOf = null;
  leaveWatching();
  Replay.close();
  $("startScreen").hidden = true;
  $("watchWait").hidden = false;
  $("watchWaitText").textContent = "Looking for the game…";
  if (!netOk) return stopWatching("This page can't go online, so it can't watch games.");
  try {
    const r = await Net.game(code);
    if (gen !== lobbyGen) { r.leave(); return; }
    room = r;
    Chat.attach(r);
    watcher = new Watcher(code, r);
  } catch (e) {
    if (gen === lobbyGen) stopWatching(`Couldn't reach that game: ${e.message || e}`);
  }
}
// Stop watching, quietly (we're going somewhere else).
function leaveWatching() {
  if (!watcher) return;
  watcher.leave();
  watcher = null;
  $("watchWait").hidden = true;
  $("netWait").hidden = true;
}
// Stop watching and go back to my own lobby.
function stopWatching(note = "", bad = !!note) {
  const was = !!watcher;
  leaveWatching();
  if (observe && observe.kind === "watch") Rec.finish();
  stopObserving();
  running = false; titleSpin = true;
  for (const id of ["endScreen", "menuScreen", "watchWait"]) $(id).hidden = true;
  $("startScreen").hidden = false;
  if (was || !room) openOwnLobby(note, bad);
}

// Players see how many people are watching.
function setWatchCount(n) {
  const el = $("watchCount");
  el.hidden = !n;
  if (n) el.textContent = `${n} watching`;
}
const countWatchers = peers => peers.filter(p => p.presence && p.presence.role === "watcher" && p.presence.v === NET.PROTOCOL).length;

// ===========================================================================
// The buttons that belong to watching. Called once at start-up.
function initWatchUi() {
  $("sbAll").onclick = () => setView(0);
  $("rpPlay").onclick = () => { if (Replay.finished && paused) Replay.seek(0); togglePause(); Replay.ui(true); };
  $("rpRestart").onclick = () => { Replay.seek(0); Replay.ui(true); };
  $("rpSpeed").addEventListener("click", e => { const b = e.target.closest("button"); if (b) Replay.setSpeed(+b.dataset.s); });
  $("rpSeek").addEventListener("input", e => { Replay.seek(+e.target.value); Replay.ui(); });
  $("rpSeek").addEventListener("change", e => e.target.blur());
  $("obsExit").onclick = () => {
    if (!observe) return;
    if (observe.kind === "watch") stopWatching();
    else if (observe.kind === "replay") { Replay.close(); stopObserving(); toMenu(); }
    else leaveOut();
  };
  $("watchWaitCancel").onclick = () => stopWatching();
  $("watchLinkBtn").onclick = () => copyText(watchLink(), $("watchLinkBtn"), "Copy watch link");
  $("lobbyWatchLink").onclick = () => copyText(watchLink(), $("lobbyWatchLink"), "Copy watch link");
  $("watchHostBtn").onclick = () => { if (guestOf) startWatching(guestOf.code); };
  $("replayBtn").onclick = async () => {
    const r = await Rec.replay;
    if (!r) { toast("There's no replay of that game.", "bad"); return; }
    Replay.open(r).catch(() => toast("That replay couldn't be played.", "bad"));
  };
  $("replayDlBtn").onclick = async () => {
    const r = await Rec.replay;
    if (!r) { toast("There's no replay of that game.", "bad"); return; }
    downloadSave(r, "replay");
  };
  $("rpDownload").onclick = () => { if (Replay.data) downloadSave(Replay.data, "replay"); };
}
// Copy a link; where the clipboard is refused, show it to copy by hand.
function copyText(text, btn, label) {
  if (!text) return;
  const done = () => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = label; }, 1500); };
  const byHand = () => { window.prompt("Copy this link:", text); };
  try { navigator.clipboard.writeText(text).then(done, byHand); } catch { byHand(); }
}

function renderReplayList() {
  const ul = $("replayList"), list = readReplays();
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li"); li.className = "empty";
    li.textContent = "No replays yet. Every game you play or watch is kept here (the latest " + REPLAY_MAX + ").";
    ul.append(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement("li");
    const what = document.createElement("div"); what.className = "what";
    const title = document.createElement("b");
    title.textContent = new Date(r.saved).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) + (r.watched ? " · watched" : r.mp ? " · online" : "");
    const sub = document.createElement("small");
    sub.textContent = `${fmtTime((r.ticks || 0) * SIM_MS / 1000)} · ${playersLine(r)}${r.result ? " · " + r.result : ""}`;
    what.append(title, sub);
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.className = cls; b.textContent = label; b.onclick = fn; return b; };
    li.append(what,
      btn("Watch", "go", () => Replay.open(r).catch(() => toast("That replay couldn't be played.", "bad"))),
      btn("Download", "ghost", () => downloadSave(r, "replay")),
      btn("Delete", "ghost", e => {
        if (e.target.dataset.sure) { writeReplays(readReplays().filter(x => x.id !== r.id)); renderReplayList(); }
        else { e.target.dataset.sure = "1"; e.target.textContent = "Really delete?"; }
      }));
    ul.append(li);
  }
}
