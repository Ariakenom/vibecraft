// ===========================================================================
// Multiplayer.
//
// Every computer runs the very same simulation. They never send unit
// positions, only the commands players give ("these 6 units, right-click at
// 41.2, 17.9"). Same start + same commands on the same ticks = the same game,
// because the Rust simulation is deterministic.
//
// ONE CLOCK, TWO COPIES. Everyone counts the same ticks (20 a second, set by
// the host). A command is stamped with the tick it was given on, and the
// player who gave it applies it at once, so their own units react instantly.
//
// Each computer keeps two copies of the game (see `mp_save` in lib.rs):
// - LIVE: what you see and play in. It runs at "now".
// - CONFIRMED: runs a short WINDOW behind now, and only with commands the
//   host has put in their final order.
//
// The SERVER (inside the host's tab) collects everyone's commands. When the
// confirmed time reaches a tick, it bundles the commands stamped for that tick
// and sends the bundle to everyone, the host's own client included. The window
// is just long enough for commands to reach the host in time, so nearly every
// command lands on exactly the tick it was stamped with.
//
// Each CLIENT steps its confirmed copy with each bundle and compares it with
// what the live copy did on that tick. Usually they match (nobody else gave a
// command) and nothing happens. When a friend's command was in the bundle,
// the live copy is replaced with the confirmed one and the ticks since are run
// again, with your own not-yet-confirmed commands, in about a millisecond. Your
// friend's units then hop forward a little: you see their action one network
// trip late.
//
// Messages can be lost, so every message repeats whatever the other side
// hasn't acknowledged yet. Checksums of the confirmed copy are compared every
// second to catch real drift ("desync"), and the trace (F8) counts how often
// predictions were right, to check the idea that commands rarely conflict.

const NET = {
  TICK_MS: 50,
  PROTOCOL: 20,   // 20: pause and speed; 19: names; 18: seats change hands mid-game; 17: the Atomic era, nukes; 16 Modern, no Wonder; 15 Industrial; 14 ponds; 13 Gunpowder; 12 Medieval; 11 people are units; 10 the Phase 3 AI
  WINDOW: 4,      // ticks the confirmed copy runs behind now, to start with (200 ms)
  MIN_WINDOW: 2,
  MAX_WINDOW: 20,
  MAX_AHEAD: 60,  // the live copy may run at most 3 s ahead of the confirmed one (ticks, at 1x)
  SPEEDS: [1, 1.5, 2], // what the host can set
  BEHIND: 20,     // ticks a computer may lag behind the clock before it counts as not keeping up
  SUM_EVERY: 20,  // compare checksums every 20 ticks (1 s)
};

// --- Transports -------------------------------------------------------------
// Two ways to talk, behind one small interface:
//   emit(topic, data)   on(topic, fn(data, from))   presence(obj)
//   onPeers(fn([{id, presence}]))   leave()
// 1. The claude.ai `room` capability, when the page runs as a published artifact.
// 2. A WebSocket relay (server.js), for a copy you run yourself.

// On claude.ai, everything travels as PRESENCE: each player's own small
// state object, which the room shares with everyone. Anyone in the room may
// set presence, whatever their access level (sending events needs Editor).
// Presence keeps only the latest value, which suits us: every message we
// send repeats everything not yet acknowledged, so a newer one always
// contains what an overwritten one said.
// Every open room's "look at everyone's presence" function, so the game can
// check for news on its own clock when the tab is in the background.
const roomLookers = new Set();
function wrapClaudeRoom(r) {
  const handlers = {}, peerFns = [];
  const seen = new Map(); // "peer|topic" -> the last value we passed on
  const others = snap => snap.filter(p => !p.sameTab); // not ourselves (our other tab counts as someone else)
  const deliver = (p, t) => {
    const d = p.presence && p.presence[t];
    const key = p.peer + "|" + t;
    if (d === undefined || d === null || seen.get(key) === d) return; // unchanged: same frozen object
    seen.set(key, d);
    for (const f of handlers[t] || []) f(d, p.peer);
  };
  // Look at everyone's presence. Called on every change notification, and
  // also on a timer as a safety net in case a notification goes missing.
  let last = null;
  const process = snap => {
    if (snap === last) return; // the room hands out the same snapshot until something changes
    last = snap;
    const os = others(snap);
    for (const p of os) for (const t in handlers) deliver(p, t);
    const list = os.map(p => ({ id: p.peer, presence: p.presence || {} }));
    for (const f of peerFns) f(list);
  };
  r.onPeers(ch => process(ch.peers), e => Net.note(`room listener: ${e.code}`));
  if (r.onConnection) r.onConnection(c => { Net.diag.connected = c; }, e => Net.note(`connection: ${e.code}`));
  const look = () => { try { process(r.peers()); } catch { /* room gone */ } };
  const poll = setInterval(look, 500);
  roomLookers.add(look);
  return {
    kind: "room",
    emit: (t, d) => r.presence({ [t]: d }).catch(e => Net.note(`sending: ${e && e.code}`)),
    on: (t, f) => {
      (handlers[t] ||= []).push(f);
      for (const p of others(r.peers())) deliver(p, t); // whatever is already there
    },
    presence: p => r.presence(p).catch(e => Net.note(`presence: ${e && e.code}`)),
    onPeers: f => {
      peerFns.push(f);
      last = null; // make the next look report everyone to the newcomer
      setTimeout(() => process(r.peers()), 0);
    },
    count: () => others(r.peers()).length,
    leave: () => {
      clearInterval(poll);
      roomLookers.delete(look);
      return r.leave ? r.leave().catch(() => {}) : r.presence({ start: null, frame: null, cmd: null, role: null }).catch(() => {});
    },
  };
}

function openSocket(url, name) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
    const handlers = {}, peerFns = [];
    let opened = false;
    const api = {
      kind: "socket",
      // Returns the message's size, for the trace.
      emit: (t, d) => { if (ws.readyState !== 1) return 0; const s = JSON.stringify({ topic: t, data: d }); ws.send(s); return s.length; },
      on: (t, f) => (handlers[t] ||= []).push(f),
      presence: p => { if (ws.readyState === 1) ws.send(JSON.stringify({ presence: p })); },
      onPeers: f => peerFns.push(f),
      leave: () => ws.close(),
    };
    ws.onopen = () => { opened = true; ws.send(JSON.stringify({ join: name })); resolve(api); };
    ws.onerror = () => { if (!opened) reject(new Error(`Can't reach the relay server at ${url}`)); };
    ws.onclose = () => peerFns.forEach(f => f([]));
    ws.onmessage = ev => {
      Trace.inBytes = ev.data.length; // for the trace: the size, without serialising it again
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.peers) peerFns.forEach(f => f(m.peers));
      else if (m.topic) (handlers[m.topic] || []).forEach(f => f(m.data, m.from));
    };
  });
}

// Open the lobby (where hosts advertise games) and, later, a game's own room.
const Net = {
  room: null,       // the claude.ai room namespace, if available
  relayUrl: null,
  // What we know about the connection, for the status line under "Play with a friend".
  diag: { onClaude: false, room: "not asked", connected: null, errors: [], askedMs: 0 },
  note(msg) {
    const e = this.diag.errors;
    if (e[e.length - 1] !== msg) e.push(msg);
    if (e.length > 5) e.shift();
  },
  initPromise: null,
  init(relayUrl) {
    this.relayUrl = relayUrl;
    if (!this.initPromise) this.initPromise = (async () => {
      this.diag.onClaude = !!(window.claude && window.claude.use);
      if (!this.diag.onClaude) { this.diag.room = "not on claude.ai"; return false; }
      this.diag.room = "asking claude.ai…";
      const t0 = performance.now();
      try { this.room = await window.claude.use("room"); } catch (e) { this.room = null; this.note(`use(room) threw: ${e && (e.code || e.message)}`); }
      this.diag.askedMs = Math.round(performance.now() - t0);
      // `use` answers null after 10 s when claude.ai never replies: that's a
      // blocked connection between this page and claude.ai, not a refusal.
      this.diag.room = this.room ? "available" : this.diag.askedMs > 9000 ? "no answer from claude.ai" : "not available to you here";
      if (this.room && this.room.connected) this.diag.connected = this.room.connected();
      return !!this.room;
    })();
    return this.initPromise;
  },
  async lobby() {
    if (this.room) return wrapClaudeRoom(this.room);
    return openSocket(this.relayUrl, "lobby");
  },
  async game(code) {
    const name = "vibecraft-" + code.toLowerCase();
    if (this.room) {
      try { return wrapClaudeRoom(await this.room.join(name)); }
      catch (e) { this.note(`joining the game room: ${e && e.code}`); throw new Error(`Couldn't join the game room (${e && e.code || "error"}).`); }
    }
    return openSocket(this.relayUrl, name);
  },
};

// --- Trace ---------------------------------------------------------------------
// A recording of what multiplayer is doing, for finding out why a game feels
// slow: one sample a second plus notable events. F8 shows it during a game,
// and "Copy trace" puts the whole recording on the clipboard as JSON.
const Trace = {
  t0: 0, samples: [], events: [], issued: [], cur: null, curAt: 0, info: {},
  inBytes: 0, // size of the message being handled (0 where the transport can't tell)
  start(info) {
    this.t0 = this.curAt = performance.now();
    this.samples = []; this.events = []; this.issued = [];
    this.cur = this.blank();
    this.info = info;
    this.event("start", info);
  },
  blank() { return { ticks: 0, stallMs: 0, inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, maxInGap: 0, maxClockGap: 0, maxFrameGap: 0 }; },
  ts() { return Math.round(performance.now() - this.t0); },
  event(kind, data) {
    this.events.push(Object.assign({ t: this.ts(), kind }, data));
    if (this.events.length > 500) this.events.shift();
  },
  lastIn: 0,
  msgIn(bytes) {
    if (!this.cur) return;
    const now = performance.now();
    if (this.lastIn) this.cur.maxInGap = Math.max(this.cur.maxInGap, Math.round(now - this.lastIn));
    this.lastIn = now;
    this.cur.inMsgs++; this.cur.inBytes += bytes;
  },
  msgOut(bytes) { if (this.cur) { this.cur.outMsgs++; this.cur.outBytes += typeof bytes === "number" ? bytes : 0; } },
  // Once a second: close this second's numbers, with a snapshot of the lockstep.
  roll(now, snapshot) {
    if (!this.cur || now - this.curAt < 1000) return false;
    const c = this.cur;
    const sample = Object.assign({ t: this.ts() }, snapshot, c, { secs: Math.round(now - this.curAt) });
    this.samples.push(sample);
    if (this.samples.length > 1200) this.samples.shift();
    this.cur = this.blank(); this.curAt = now;
    return true;
  },
  dump() { return JSON.stringify({ trace: 2, protocol: NET.PROTOCOL, tickMs: NET.TICK_MS, ua: navigator.userAgent, info: this.info, samples: this.samples, events: this.events }); },
};


// --- The server: puts everyone's commands in order --------------------------
// It runs inside the host's tab and keeps no game state of its own: it only
// keeps the clock, collects commands, and hands out one bundle per tick.
//
// Commands also go out as "early news" the moment they arrive, so the other
// players can show them right away instead of a window later. Early news is
// only a hint; the bundles are what everyone agrees on.
class Server {
  // `guests`: [[slot, token], ...] for the other human players. `local`: the
  // host's own Client, which gets every bundle directly instead of by network.
  constructor(transport, guests, local, onEnd) {
    this.t = transport;
    this.local = local;
    this.onEnd = onEnd;
    // The clock: tick `c0` at `r0` (performance.now()), running at `rate`
    // ticks per tick-length of real time (0 while paused). Set by the host.
    this.c0 = 0; this.r0 = performance.now(); this.rate = 1;
    this.lag = new Map();                 // slot -> how many ticks behind the clock they say they are
    this.window = NET.WINDOW;
    this.lowSince = 0;                    // since when the window could have been smaller
    this.final = -1;                      // newest tick bundled
    this.inbox = [];                      // [stamp, player, seq, cmd] waiting for their tick
    this.fresh = false;                   // new commands to pass on as early news
    this.sent = new Map();                // tick -> bundle (only ticks with commands), until every guest has it
    this.tokens = new Map(guests);        // slot -> token
    this.active = new Set(this.tokens.keys());
    this.lastSeq = new Map([[local.me, 0]]);
    this.ack = new Map();                 // slot -> they hold every bundle up to this tick
    this.heard = new Map();               // slot -> when we last heard them
    this.rtt = new Map();                 // slot -> { srtt, dev }, ms
    this.clockErr = new Map();            // slot -> how far their idea of "now" is off ours, ms (+ = ahead)
    this.guestClock = new Map();          // slot -> [their clock, when it came]: echoed so they can time the trip
    this.started = new Set();             // guests who have started the game
    for (const s of this.active) { this.lastSeq.set(s, 0); this.ack.set(s, -1); this.heard.set(s, performance.now()); }
    this.left = new Set();                // slots whose player left (the computer has them, or soon will)
    this.joining = new Map();             // slot -> { token, T, seq0, at }: seats handed to spectators, not taken up yet
    this.late = {};                       // player -> commands that arrived after their tick was bundled
    this.lastSend = 0;
    transport.on("cmd", d => this.receive(d));
  }
  // Now, in ticks (with a fraction): the one clock everybody follows.
  now() { return this.c0 + (performance.now() - this.r0) * this.rate / NET.TICK_MS; }
  // The clock reads `tick` now (at the start, once the map is built).
  setClock(tick) { this.c0 = tick; this.r0 = performance.now(); }
  // Pause (0) or change the speed. Only the host does; the frames tell
  // everyone (`rate`), and their clocks follow. The game itself runs the
  // same either way: only how many ticks come per second changes.
  setRate(r) {
    if (r === this.rate) return;
    this.c0 = this.now(); this.r0 = performance.now();
    Trace.event("rate", { from: this.rate, to: r });
    this.rate = r;
    this.updateWindow();
    this.send();
  }
  // A command, from the host's own client or from a guest.
  submit(p, seq, stamp, cmd) {
    if (seq <= (this.lastSeq.get(p) || 0)) return; // seen it already
    this.lastSeq.set(p, seq);
    this.inbox.push([stamp, p, seq, cmd]);
    this.fresh = true;
    if (p !== this.local.me) this.local.early(p, seq, stamp, cmd); // the host's own screen, at once
  }
  // Bundle every tick that is now a window old.
  pump() {
    const target = Math.floor(this.now()) - this.window;
    let moved = false;
    while (this.final < target) {
      const k = ++this.final;
      const due = [], wait = [];
      for (const e of this.inbox) (e[0] <= k ? due : wait).push(e);
      this.inbox = wait;
      // A fixed order inside a tick: by player, then in the order they gave them.
      due.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
      for (const e of due) if (e[0] < k && e[1] !== 0 && e[1] !== this.local.me && (this.lag.get(e[1]) || 0) > NET.BEHIND) {
        // Late because their computer lags behind the clock, not because of
        // the network: a longer window wouldn't help, so the others keep theirs.
        this.late[e[1]] = (this.late[e[1]] || 0) + 1;
      } else if (e[0] < k && e[1] !== 0) {
        // Too late for its own tick: it goes into this one instead. Give the
        // next ones more time.
        this.late[e[1]] = (this.late[e[1]] || 0) + 1;
        Trace.event("late", { player: e[1], ticks: k - e[0] });
        this.grow(this.window + 1, "late command");
      }
      const bundle = due.map(e => [e[1], e[2], ...e[3]]);
      if (bundle.length) this.sent.set(k, bundle);
      this.local.confirm(k, bundle);
      moved = true;
    }
    if (moved || this.fresh || performance.now() - this.lastSend > 250) this.send();
  }
  grow(w, why) {
    w = Math.min(NET.MAX_WINDOW, w);
    if (w > this.window) { Trace.event("window", { from: this.window, to: w, why }); this.window = w; }
    this.lowSince = 0;
  }
  // Long enough for a command to reach us from the slowest guest, with room
  // for wobble. It grows at once but shrinks only after five calm seconds,
  // one tick at a time, so a ping right on a boundary doesn't make it flap.
  updateWindow() {
    let need = 0;
    // (Not counting a computer that lags behind the clock: its round trips
    // are slow from its own work, and it would only make everyone wait longer.)
    for (const s of this.active) { const r = this.rtt.get(s); if (r && (this.lag.get(s) || 0) <= 3) need = Math.max(need, r.srtt / 2 + 2 * r.dev + 25); }
    // In ticks, which come faster at a higher speed.
    const w = Math.max(NET.MIN_WINDOW, Math.min(NET.MAX_WINDOW, Math.ceil(need * Math.max(1, this.rate) / NET.TICK_MS)));
    const now = performance.now();
    if (w > this.window) this.grow(w, `ping needs ${Math.round(need)} ms`);
    else if (w === this.window) this.lowSince = 0;
    else if (!this.lowSince) this.lowSince = now;
    else if (now - this.lowSince > 5000) {
      Trace.event("window", { from: this.window, to: this.window - 1, why: "calm" });
      this.window--;
      this.lowSince = now;
    }
  }
  // Someone left: from a tick from now, the computer plays their side.
  drop(slot) {
    this.joining.delete(slot);
    if (!this.active.delete(slot)) return;
    Trace.event("drop", { slot });
    this.left.add(slot);
    if (this.local.hooks.left) this.local.hooks.left(slot);
    this.inbox.push([Math.ceil(this.now()), 0, 0, [7, slot, 0, 0]]);
    this.updateWindow();
  }
  // Hand a seat the computer is playing to a spectator (`token`). On tick T
  // (a second from now) the seat goes back to a person for everyone; the
  // spectator's copy of the game, fed by the recording, stops right after
  // that tick and carries on as a player from there. Their commands
  // continue the seat's numbering (`seq0`), so nobody mistakes them for old
  // ones. Returns the offer, which the page passes on until they answer.
  claim(slot, token) {
    if (slot === this.local.me || this.active.has(slot) || this.joining.has(slot)) return null;
    for (const j of this.joining.values()) if (j.token === token) return null;
    const T = Math.ceil(this.now()) + 20;
    const offer = { slot, token, T, seq0: this.lastSeq.get(slot) || 0, at: performance.now() };
    this.joining.set(slot, offer);
    this.left.delete(slot);
    this.tokens.set(slot, token);
    this.active.add(slot);
    this.started.add(slot);
    this.lastSeq.set(slot, offer.seq0);
    this.ack.set(slot, T);            // keep every bundle after T until they have it
    this.heard.set(slot, performance.now());
    this.rtt.delete(slot); this.clockErr.delete(slot); this.guestClock.delete(slot);
    delete this.late[slot];
    this.inbox.push([T, 0, 0, [13, slot, 0, 0]]);
    Trace.event("claim", { slot, T });
    return offer;
  }
  // Seats handed out but not taken up within `ms`: the computer keeps them.
  stale(ms) {
    if (this.rate === 0) for (const j of this.joining.values()) j.at = performance.now(); // paused: T isn't coming yet
    return [...this.joining.values()].filter(j => performance.now() - j.at > ms).map(j => j.slot); }
  send(end) {
    let min = this.final;
    for (const s of this.active) min = Math.min(min, this.ack.get(s));
    for (const k of this.sent.keys()) if (k <= min) this.sent.delete(k);
    // Every bundle somebody might still be missing (they're in tick order).
    const ticks = [];
    let size = 0, upTo = this.final;
    for (const [k, b] of this.sent) {
      const len = JSON.stringify(b).length + 8;
      if (size + len > 2400 && ticks.length) { upTo = k - 1; break; }
      size += len;
      ticks.push([k, b]);
    }
    // Early news: every command not bundled yet, [player, seq, stamp, ...cmd].
    const early = [];
    size = 0;
    for (const e of this.inbox) {
      if (e[1] === 0) continue;
      const entry = [e[1], e[2], e[0], ...e[3]];
      size += JSON.stringify(entry).length;
      if (size > 1000) break;
      early.push(entry);
    }
    this.fresh = false;
    const now = performance.now(), ge = {}, ce = {};
    for (const [s, [t, at]] of this.guestClock) ge[s] = [t, Math.round(now - at)];
    for (const [s, e] of this.clockErr) ce[s] = Math.round(e);
    const acks = {};
    for (const [s, q] of this.lastSeq) if (s !== this.local.me) acks[s] = q;
    // `upTo`: every tick up to here is final; those not listed had no commands.
    const msg = { v: NET.PROTOCOL, upTo, ticks, early, now: Math.round(this.now() * 100) / 100, rate: this.rate, left: [...this.left], w: this.window, acks, sum: this.local.latestSum(), ge, ce, late: this.late, end, t: Math.round(now) };
    Trace.msgOut(this.t.emit("frame", msg));
    this.lastSend = now;
  }
  receive(d) {
    if (!d || d.v !== NET.PROTOCOL || !this.active.has(d.from) || this.tokens.get(d.from) !== d.token) return;
    const s = d.from, now = performance.now();
    this.heard.set(s, now);
    if (this.joining.delete(s)) Trace.event("joined", { slot: s });
    this.started.add(s);
    Trace.msgIn(Trace.inBytes);
    if (typeof d.gt === "number") this.guestClock.set(s, [d.gt, now]);
    if (typeof d.lag === "number") this.lag.set(s, d.lag);
    for (const e of Array.isArray(d.cmds) ? d.cmds : []) {
      if (!Array.isArray(e) || typeof e[0] !== "number" || typeof e[1] !== "number") continue;
      const cmd = cleanCmd(e[2]);
      if (cmd && cmd[0] !== 7 && cmd[0] !== 13) this.submit(s, e[0], Math.floor(e[1]), cmd);
    }
    if (typeof d.ack === "number") this.ack.set(s, Math.max(this.ack.get(s), d.ack));
    // The round trip: our clock when we sent, minus how long they held it.
    if (Array.isArray(d.echo) && typeof d.echo[0] === "number" && typeof d.echo[1] === "number") {
      const sample = now - d.echo[0] - d.echo[1];
      if (sample >= 0 && sample < 5000) {
        const r = this.rtt.get(s);
        if (!r) this.rtt.set(s, { srtt: sample, dev: sample / 2 });
        else { r.dev = 0.75 * r.dev + 0.25 * Math.abs(r.srtt - sample); r.srtt = 0.875 * r.srtt + 0.125 * sample; }
        this.updateWindow();
      }
    }
    // Their clock: what they thought "now" was when they sent this, against
    // what it was here, allowing for the trip.
    const r = this.rtt.get(s);
    if (typeof d.est === "number" && r) {
      const err = (d.est - this.now()) * NET.TICK_MS + r.srtt / 2;
      const old = this.clockErr.get(s);
      this.clockErr.set(s, old === undefined ? err : 0.9 * old + 0.1 * err);
    }
    // Their confirmed copy against ours (or they found a difference themselves).
    const drift = typeof d.desync === "number" ? d.desync
      : Array.isArray(d.sum) && this.local.sums.has(d.sum[0]) && this.local.sums.get(d.sum[0]) !== d.sum[1] ? d.sum[0] : null;
    if (drift !== null && !this.local.ended) {
      const why = `The games drifted apart at tick ${drift}. That's a bug, sorry.`;
      this.local.stats.desyncs++;
      Trace.event("desync", { tick: drift, player: s });
      this.send(why);
      this.local.onEnd(why);
    }
  }
  // Guests we haven't heard from in a while (their tab closed, connection gone).
  silent(ms) { return [...this.active].filter(s => !this.joining.has(s) && performance.now() - this.heard.get(s) > ms); }
  waitingForStart() { return [...this.active].some(s => !this.started.has(s)); }
  snapshot() {
    const guests = {};
    for (const s of this.tokens.keys()) {
      const r = this.rtt.get(s), ce = this.clockErr.get(s);
      guests[s] = { active: this.active.has(s), lag: this.lag.get(s) ?? null, rtt: r ? Math.round(r.srtt) : null, dev: r ? Math.round(r.dev) : null, clockErr: ce === undefined ? null : Math.round(ce), behind: this.final - this.ack.get(s), heardAgo: Math.round(performance.now() - this.heard.get(s)), late: this.late[s] || 0 };
    }
    return { window: this.window, rate: this.rate, inbox: this.inbox.length, guests };
  }
}

// --- The client: the live copy, kept honest by the confirmed one ------------
// Every player runs one, the host too (its bundles come straight from its
// Server). `hooks` connects it to the game: apply(owner, cmd) runs a command
// without any sound or message; keep() and restore(kept) carry the player's
// selection (and the units' drawn positions) over a correction; system(cmd)
// tells the player about a command from the host (someone left);
// confirmed(tick, bundle) records each tick's final commands (replays,
// spectators).
//
// The live copy assumes, for every tick, a list of commands: mine, plus any
// friend's that arrived as early news. Each bundle is compared with that.
const byPlayerThenSeq = (a, b) => a[0] - b[0] || a[1] - b[1];
class Client {
  constructor(me, transport, token, hooks, onEnd) {
    this.me = me;
    this.t = transport;                  // null for the host's own client
    this.token = token;
    this.hooks = hooks;
    this.ended = false;
    this.onEnd = why => { if (this.ended) return; this.ended = true; onEnd(why); };
    this.server = null;                  // set on the host
    this.live = 0;                       // ticks the live copy has run
    this.final = -1;                     // newest tick the confirmed copy has run
    this.got = -1;                       // we hold every bundle up to this tick
    this.bundles = new Map();            // tick -> bundle, received but not run yet
    this.seq = 0;
    this.pending = [];                   // [seq, stamp, cmd]: my commands not confirmed yet
    this.foreign = new Map();            // "player:seq" -> {p, seq, stamp, cmd, applied}: friends' early news, not confirmed yet
    this.doneSeq = new Map();            // player -> newest seq seen confirmed
    this.assumed = new Map();            // tick -> the commands the live copy applied on it, as bundle entries
    this.liveSums = new Map();           // tick -> [whole game, my things] checksums of the live copy after it
    this.sums = new Map();               // tick -> checksum of the confirmed copy (every SUM_EVERY ticks)
    this.hostSums = new Map();
    this.dirty = null;                   // why the live copy needs correcting, or null
    this.finalState = 0;                 // the confirmed copy's W.state_of(me)
    this.window = NET.WINDOW;
    this.offset = null;                  // guests: the host's tick at our time 0, as `rate` runs (ticks)
    this.rate = 1;                       // guests: the host's clock rate (0 paused), from the frames
    this.leftSeen = new Set();           // guests: players the host said have left
    this.offsets = [];
    this.clockErr = null;                // guests: how far off our clock is, as the host measures it
    this.rtt = null; this.rttDev = 0;
    this.echoT = null; this.echoAt = 0; this.lastEcho = 0; this.taken = 0;
    this.lastHeard = performance.now(); this.lastSend = 0;
    // Counted for the trace, to see whether the idea holds.
    this.stats = {
      confirmed: 0,    // ticks confirmed
      matched: 0,      // ...where the live copy had predicted the whole game exactly
      mineMatched: 0,  // ...where it had predicted my own things exactly
      compared: 0,     // ...that the live copy had run (so could be compared)
      corrections: 0, resimTicks: 0,
      // why: early (a friend's command came in, for a tick we'd run already),
      // remote (one reached us only in a bundle), moved (a command landed on
      // another tick than stamped), system, behind (confirmed overtook live),
      // unexplained (bundle as predicted, yet the copies differ)
      early: 0, remote: 0, moved: 0, system: 0, behind: 0, unexplained: 0,
      mineChanged: 0,  // corrections that changed my own things
      selChanged: 0,   // corrections after which my selection pointed at something else
      desyncs: 0,
      seenLate: [],    // ticks between a friend giving a command and us seeing it (recent)
    };
    if (transport) transport.on("frame", d => this.receive(d));
  }

  // Where "now" is, in ticks: the host's clock (guests: as best we know it).
  target() {
    if (this.server) return this.server.now();
    return this.offset === null ? null : this.offset + performance.now() * this.rate / NET.TICK_MS;
  }
  // How far between the previous live tick and the latest one to draw things.
  alpha() {
    const t = this.target();
    return t === null ? 1 : Math.max(0, Math.min(1, t - (this.live - 1)));
  }
  // The tick a not-yet-confirmed command goes on: its stamp, or the first
  // open tick if its own is final already (it's late).
  eff(stamp) { return Math.max(stamp, this.final + 1); }
  note(k, entry) {
    if (!this.assumed.has(k)) this.assumed.set(k, []);
    this.assumed.get(k).push(entry);
  }

  // One of my commands. The game has already applied it to the live copy.
  queue(cmd) {
    const stamp = this.live; // it takes effect before the next tick runs
    const seq = ++this.seq;
    this.pending.push([seq, stamp, cmd]);
    this.note(stamp, [this.me, seq, ...cmd]);
    if (this.server) this.server.submit(this.me, seq, stamp, cmd);
    else this.send();
  }

  // A friend's command, before it's confirmed.
  early(p, seq, stamp, cmd) {
    if (!cmd || p === this.me || p === 0) return;
    const key = p + ":" + seq;
    if (this.foreign.has(key) || seq <= (this.doneSeq.get(p) || 0)) return;
    this.foreign.set(key, { p, seq, stamp, cmd, applied: false });
    this.stats.seenLate.push(this.live - stamp);
    if (this.stats.seenLate.length > 50) this.stats.seenLate.shift();
    // Meant for a tick we've run already: go back and put it in.
    if (this.eff(stamp) < this.live && !this.dirty) this.dirty = "early";
  }

  // The host's own client: a bundle straight from the server.
  confirm(k, bundle) {
    if (bundle.length) this.bundles.set(k, bundle);
    this.got = k;
    this.window = this.server.window;
  }

  // A guest: bundles, early news and the clock, from the host.
  receive(d) {
    if (this.ended || !d || d.v !== NET.PROTOCOL) return;
    const now = performance.now();
    this.lastHeard = now;
    Trace.msgIn(Trace.inBytes);
    if (d.end) { this.onEnd(d.end); return; }
    if (typeof d.t === "number" && (this.echoT === null || d.t > this.echoT)) { this.echoT = d.t; this.echoAt = now; }
    const echo = d.ge && d.ge[this.me];
    if (Array.isArray(echo) && typeof echo[0] === "number" && typeof echo[1] === "number" && echo[0] > this.lastEcho) {
      this.lastEcho = echo[0];
      const sample = now - echo[0] - echo[1];
      if (sample >= 0 && sample < 10000) {
        if (this.rtt === null) { this.rtt = sample; this.rttDev = sample / 2; }
        else { this.rttDev = 0.75 * this.rttDev + 0.25 * Math.abs(this.rtt - sample); this.rtt = 0.875 * this.rtt + 0.125 * sample; }
      }
    }
    if (d.ce && typeof d.ce[this.me] === "number") this.clockErr = d.ce[this.me];
    // The clock: the host's time when it sent this, plus half a round trip.
    // Messages held up on the way would make us think the host is behind, so
    // trust the most hopeful of the recent ones, and move there gently.
    // At another speed (or paused) the clock runs at `rate`: a new rate
    // starts the estimate afresh.
    const rate = typeof d.rate === "number" && d.rate >= 0 && d.rate <= 4 ? d.rate : 1;
    if (rate !== this.rate) {
      this.rate = rate; this.offsets = []; this.offset = null;
      if (this.hooks.pace) this.hooks.pace(rate);
    }
    if (typeof d.now === "number") {
      this.offsets.push(d.now + ((this.rtt || 0) / 2 - now) * rate / NET.TICK_MS);
      if (this.offsets.length > 40) this.offsets.shift();
      const best = Math.max(...this.offsets);
      if (this.offset === null || Math.abs(best - this.offset) > 20 * Math.max(1, rate)) this.offset = best;
      else this.offset += (best - this.offset) * 0.1;
    }
    if (typeof d.w === "number") this.window = d.w;
    // Who has left: told at once, even while the game is paused.
    if (Array.isArray(d.left)) {
      for (const s of d.left) if (Number.isInteger(s) && !this.leftSeen.has(s)) { this.leftSeen.add(s); if (this.hooks.left) this.hooks.left(s); }
      for (const s of this.leftSeen) if (!d.left.includes(s)) this.leftSeen.delete(s);
    }
    if (d.acks && typeof d.acks[this.me] === "number") this.taken = Math.max(this.taken, d.acks[this.me]);
    for (const e of Array.isArray(d.ticks) ? d.ticks : []) {
      if (Array.isArray(e) && typeof e[0] === "number" && e[0] > this.final && Array.isArray(e[1])) this.bundles.set(e[0], e[1]);
    }
    if (typeof d.upTo === "number" && d.upTo > this.got) this.got = d.upTo;
    for (const e of Array.isArray(d.early) ? d.early : []) {
      if (Array.isArray(e) && e.length >= 7 && e.slice(0, 3).every(v => typeof v === "number")) this.early(e[0], e[1], Math.floor(e[2]), cleanCmd(e.slice(3)));
    }
    if (Array.isArray(d.sum)) { this.hostSums.set(d.sum[0], d.sum[1]); this.checkSum(d.sum[0]); }
  }

  send() {
    const cmds = [];
    let size = 0;
    for (const p of this.pending) {
      if (p[0] <= this.taken) continue; // the host has it
      size += JSON.stringify(p).length;
      if (size > 1500 && cmds.length) break;
      cmds.push(p);
    }
    const echo = this.echoT === null ? null : [this.echoT, Math.round(performance.now() - this.echoAt)];
    const est = this.target();
    const lag = this.behind();
    const msg = { v: NET.PROTOCOL, from: this.me, token: this.token, cmds, lag, ack: this.got, sum: this.latestSum(), echo, gt: Math.round(performance.now()), est: est === null ? null : Math.round(est * 100) / 100 };
    Trace.msgOut(this.t.emit("cmd", msg));
    this.lastSend = performance.now();
  }

  // The clock's rate, for everyone (the host's own client reads its server).
  pace() { return this.server ? this.server.rate : this.rate; }
  // How many ticks this computer is behind the clock (a slow computer, at speed).
  behind() { const t = this.target(); return t === null ? 0 : Math.max(0, Math.round(t - this.live)); }
  latestSum() {
    let best = null;
    for (const [k, v] of this.sums) if (!best || k > best[0]) best = [k, v];
    return best;
  }
  checkSum(k) {
    if (this.ended || !(this.sums.has(k) && this.hostSums.has(k) && this.sums.get(k) !== this.hostSums.get(k))) return;
    this.stats.desyncs++;
    Trace.event("desync", { tick: k });
    // Tell the host, so the game ends for everyone (a few times, in case one is lost).
    if (this.t) for (let i = 0; i < 3; i++) this.t.emit("cmd", { v: NET.PROTOCOL, from: this.me, token: this.token, cmds: [], desync: k });
    this.onEnd(`The games drifted apart at tick ${k}. That's a bug, sorry.`);
  }

  // Everything that happens on the clock: called many times a second.
  pump() {
    if (this.server) this.server.pump();
    this.advance();
    if (this.dirty) this.correct();
    const target = this.target();
    let steps = 0, stalled = false;
    if (target === null) stalled = true; // a guest that hasn't heard the clock yet
    else while (this.live < target && steps < 8) {
      if (this.live - this.final > NET.MAX_AHEAD * Math.max(1, this.pace())) { stalled = true; break; }
      this.stepLive();
      steps++;
    }
    if (this.t && performance.now() - this.lastSend > NET.TICK_MS) this.send();
    return { steps, stalled };
  }

  // Run one live tick, with friends' early commands that are due on it.
  stepLive() {
    const k = this.live;
    const due = [];
    for (const f of this.foreign.values()) if (!f.applied && this.eff(f.stamp) === k) due.push(f);
    due.sort((a, b) => a.p - b.p || a.seq - b.seq);
    for (const f of due) { this.hooks.apply(f.p, f.cmd); this.note(k, [f.p, f.seq, ...f.cmd]); f.applied = true; }
    W.tick();
    this.liveSums.set(k, [W.checksum(), W.checksum_owner(this.me)]);
    this.live++;
  }

  // Run the confirmed copy through every bundle we hold, in order, and note
  // whether the live copy had assumed the same.
  advance() {
    while (this.final < this.got) {
      const k = this.final + 1;
      const bundle = this.bundles.get(k) || [];
      this.bundles.delete(k);
      const assumed = (this.assumed.get(k) || []).slice().sort(byPlayerThenSeq);
      const same = bundle.length === assumed.length &&
        bundle.every((e, i) => e.length === assumed[i].length && e.every((v, j) => v === assumed[i][j]));
      if (!same && !this.dirty) {
        const has = (list, e) => list.some(a => a[0] === e[0] && a[1] === e[1]);
        this.dirty = bundle.some(e => e[0] === 0) ? "system"
          : bundle.some(e => e[0] !== this.me && !has(assumed, e)) ? "remote" : "moved";
      }
      for (const e of bundle) {
        if (e[0] === this.me) this.pending = this.pending.filter(p => p[0] !== e[1]);
        else if (e[0] !== 0) {
          const key = e[0] + ":" + e[1];
          if (!this.foreign.has(key)) { this.stats.seenLate.push(this.live - k); if (this.stats.seenLate.length > 50) this.stats.seenLate.shift(); }
          this.foreign.delete(key);
          this.doneSeq.set(e[0], Math.max(this.doneSeq.get(e[0]) || 0, e[1]));
        } else if (e[2] === 7) this.hooks.system(e.slice(2));
      }
      // Step the confirmed copy: swap it in, run the tick, swap it back.
      W.mp_swap();
      for (const e of bundle) { const c = cleanCmd(e.slice(2)); if (c) this.hooks.apply(e[0], c); }
      W.tick();
      W.take_events(); // the live copy already showed these (or will)
      const whole = W.checksum(), own = W.checksum_owner(this.me);
      this.finalState = W.state_of(this.me);
      W.mp_swap();
      if (this.hooks.confirmed) this.hooks.confirmed(k, bundle);
      this.final = k;
      this.stats.confirmed++;
      if (k % NET.SUM_EVERY === 0) {
        this.sums.set(k, whole);
        for (const t of this.sums.keys()) if (t < k - 600) this.sums.delete(t);
        this.checkSum(k);
      }
      const ls = this.liveSums.get(k);
      if (ls) {
        this.stats.compared++;
        if (ls[0] === whole) this.stats.matched++;
        if (ls[1] === own) this.stats.mineMatched++;
        if (same && ls[0] !== whole && !this.dirty) { this.dirty = "unexplained"; Trace.event("unexplained", { tick: k }); }
      } else if (k >= this.live && !this.dirty) this.dirty = "behind"; // confirmed overtook live
      this.liveSums.delete(k);
      this.assumed.delete(k);
    }
  }

  // Replace the live copy with the confirmed one and run the ticks since
  // again, with every command not confirmed yet: mine, and friends' early news.
  correct() {
    const t0 = performance.now();
    const why = this.dirty;
    this.dirty = null;
    const kept = this.hooks.keep();
    const from = this.final + 1;
    const ownBefore = this.live > from ? W.checksum_owner(this.me) : null;
    W.mp_restore();
    if (this.live < from) this.live = from; // we were behind: jump
    this.assumed.clear();
    this.liveSums.clear();
    const open = [];
    for (const p of this.pending) open.push({ p: this.me, seq: p[0], stamp: p[1], cmd: p[2] });
    for (const f of this.foreign.values()) { f.applied = false; open.push(f); }
    open.sort((a, b) => a.p - b.p || a.seq - b.seq);
    for (let k = from; k <= this.live; k++) {
      for (const c of open) if (this.eff(c.stamp) === k) {
        this.hooks.apply(c.p, c.cmd);
        this.note(k, [c.p, c.seq, ...c.cmd]);
        if (c.p !== this.me) c.applied = true;
      }
      if (k === this.live) break; // commands for the next tick are in; it hasn't run yet
      W.tick();
      W.take_events(); // these moments were shown already, the first time round
      this.liveSums.set(k, [W.checksum(), W.checksum_owner(this.me)]);
    }
    const s = this.stats;
    s.corrections++;
    s.resimTicks += this.live - from;
    s[why] = (s[why] || 0) + 1;
    if (ownBefore !== null && W.checksum_owner(this.me) !== ownBefore) s.mineChanged++;
    if (this.hooks.restore(kept, this.alpha())) s.selChanged++;
    Trace.event("correct", { why, ticks: this.live - from, ms: Math.round((performance.now() - t0) * 10) / 10 });
  }

  snapshot() {
    const s = this.stats;
    const late = s.seenLate.length ? Math.round(s.seenLate.reduce((a, b) => a + b, 0) / s.seenLate.length * NET.TICK_MS) : null;
    const out = {
      role: this.server ? "host" : "guest", rate: this.pace(), behind: this.behind(), live: this.live, final: this.final, ahead: this.live - this.final, window: this.window,
      rtt: this.rtt === null ? null : Math.round(this.rtt), dev: Math.round(this.rttDev), pending: this.pending.length, foreign: this.foreign.size,
      clockErr: this.server ? 0 : this.clockErr,
      heardAgo: Math.round(performance.now() - this.lastHeard), friendsSeenAfter: late,
      stats: Object.assign({}, s, { seenLate: undefined }),
    };
    if (this.server) out.server = this.server.snapshot();
    return out;
  }
}
