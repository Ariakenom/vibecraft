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
  PROTOCOL: 5,
  WINDOW: 4,      // ticks the confirmed copy runs behind now, to start with (200 ms)
  MIN_WINDOW: 2,
  MAX_WINDOW: 20,
  MAX_AHEAD: 60,  // the live copy may run at most 3 s ahead of the confirmed one
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
      emit: (t, d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ topic: t, data: d })); },
      on: (t, f) => (handlers[t] ||= []).push(f),
      presence: p => { if (ws.readyState === 1) ws.send(JSON.stringify({ presence: p })); },
      onPeers: f => peerFns.push(f),
      leave: () => ws.close(),
    };
    ws.onopen = () => { opened = true; ws.send(JSON.stringify({ join: name })); resolve(api); };
    ws.onerror = () => { if (!opened) reject(new Error(`Can't reach the relay server at ${url}`)); };
    ws.onclose = () => peerFns.forEach(f => f([]));
    ws.onmessage = ev => {
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
  msgOut(bytes) { if (this.cur) { this.cur.outMsgs++; this.cur.outBytes += bytes; } },
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
class Server {
  // `guests`: [[slot, token], ...] for the other human players. `local`: the
  // host's own Client, which gets every bundle directly instead of by network.
  constructor(transport, guests, local, onEnd) {
    this.t = transport;
    this.local = local;
    this.onEnd = onEnd;
    this.t0 = performance.now();          // tick 0; set again once the map is built
    this.window = NET.WINDOW;
    this.final = -1;                      // newest tick bundled
    this.inbox = [];                      // [stamp, player, seq, cmd] waiting for their tick
    this.sent = new Map();                // tick -> bundle (only ticks with commands), until every guest has it
    this.tokens = new Map(guests);        // slot -> token
    this.active = new Set(this.tokens.keys());
    this.lastSeq = new Map([[local.me, 0]]);
    this.ack = new Map();                 // slot -> they hold every bundle up to this tick
    this.heard = new Map();               // slot -> when we last heard them
    this.rtt = new Map();                 // slot -> { srtt, dev }, ms
    this.guestClock = new Map();          // slot -> [their clock, when it came]: echoed so they can time the trip
    this.started = new Set();             // guests who have started the game
    for (const s of this.active) { this.lastSeq.set(s, 0); this.ack.set(s, -1); this.heard.set(s, performance.now()); }
    this.late = {};                       // player -> commands that arrived after their tick was bundled
    this.lastSend = 0;
    transport.on("cmd", d => this.receive(d));
  }
  // Now, in ticks (with a fraction): the one clock everybody follows.
  now() { return (performance.now() - this.t0) / NET.TICK_MS; }
  // A command, from the host's own client or from a guest.
  submit(p, seq, stamp, cmd) {
    if (seq <= (this.lastSeq.get(p) || 0)) return; // seen it already
    this.lastSeq.set(p, seq);
    this.inbox.push([stamp, p, seq, cmd]);
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
      for (const e of due) if (e[0] < k && e[1] !== 0) {
        this.late[e[1]] = (this.late[e[1]] || 0) + 1;
        Trace.event("late", { player: e[1], ticks: k - e[0] });
      }
      const bundle = due.map(e => [e[1], e[2], ...e[3]]);
      if (bundle.length) this.sent.set(k, bundle);
      this.local.confirm(k, bundle);
      moved = true;
    }
    if (moved || performance.now() - this.lastSend > 250) this.send();
  }
  // Long enough for a command to reach us from the slowest guest, with room for wobble.
  updateWindow() {
    let need = 0;
    for (const s of this.active) { const r = this.rtt.get(s); if (r) need = Math.max(need, r.srtt / 2 + 2 * r.dev + 25); }
    const w = Math.max(NET.MIN_WINDOW, Math.min(NET.MAX_WINDOW, Math.ceil(need / NET.TICK_MS)));
    if (w !== this.window) Trace.event("window", { from: this.window, to: w, need: Math.round(need) });
    this.window = w;
  }
  // Someone left: from a tick from now, the computer plays their side.
  drop(slot) {
    if (!this.active.delete(slot)) return;
    Trace.event("drop", { slot });
    this.inbox.push([Math.ceil(this.now()), 0, 0, [7, slot, 0, 0]]);
    this.updateWindow();
  }
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
    const now = performance.now(), ge = {};
    for (const [s, [t, at]] of this.guestClock) ge[s] = [t, Math.round(now - at)];
    const acks = {};
    for (const [s, q] of this.lastSeq) if (s !== this.local.me) acks[s] = q;
    // `upTo`: every tick up to here is final; those not listed had no commands.
    const msg = { v: NET.PROTOCOL, upTo, ticks, now: Math.round(this.now() * 100) / 100, w: this.window, acks, sum: this.local.latestSum(), ge, late: this.late, end, t: Math.round(now) };
    this.t.emit("frame", msg);
    Trace.msgOut(JSON.stringify(msg).length);
    this.lastSend = now;
  }
  receive(d) {
    if (!d || d.v !== NET.PROTOCOL || !this.active.has(d.from) || this.tokens.get(d.from) !== d.token) return;
    const s = d.from, now = performance.now();
    this.heard.set(s, now);
    this.started.add(s);
    Trace.msgIn(JSON.stringify(d).length);
    if (typeof d.gt === "number") this.guestClock.set(s, [d.gt, now]);
    for (const e of Array.isArray(d.cmds) ? d.cmds : []) {
      if (!Array.isArray(e) || typeof e[0] !== "number" || typeof e[1] !== "number") continue;
      const cmd = cleanCmd(e[2]);
      if (cmd && cmd[0] !== 7) this.submit(s, e[0], Math.floor(e[1]), cmd);
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
  silent(ms) { return [...this.active].filter(s => performance.now() - this.heard.get(s) > ms); }
  waitingForStart() { return [...this.active].some(s => !this.started.has(s)); }
  snapshot() {
    const guests = {};
    for (const s of this.tokens.keys()) {
      const r = this.rtt.get(s);
      guests[s] = { active: this.active.has(s), rtt: r ? Math.round(r.srtt) : null, dev: r ? Math.round(r.dev) : null, behind: this.final - this.ack.get(s), heardAgo: Math.round(performance.now() - this.heard.get(s)), late: this.late[s] || 0 };
    }
    return { window: this.window, inbox: this.inbox.length, guests };
  }
}

// --- The client: the live copy, kept honest by the confirmed one ------------
// Every player runs one, the host too (its bundles come straight from its
// Server). `hooks` connects it to the game: apply(owner, cmd) runs a command
// without any sound or message; keep() and restore(kept) carry the player's
// selection over a correction; system(cmd) tells the player about a command
// from the host (someone left).
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
    this.mine = new Map();               // tick -> my commands the live copy applied on it, as bundle entries
    this.liveSums = new Map();           // tick -> [whole game, my things] checksums of the live copy after it
    this.sums = new Map();               // tick -> checksum of the confirmed copy (every SUM_EVERY ticks)
    this.hostSums = new Map();
    this.dirty = null;                   // why the live copy needs correcting, or null
    this.finalState = 0;                 // the confirmed copy's W.state()
    this.window = NET.WINDOW;
    this.offset = null;                  // guests: host clock minus ours, ms
    this.offsets = [];
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
      remote: 0, moved: 0, system: 0, behind: 0,
      unexplained: 0,  // bundle as predicted, yet the copies differ: should never happen
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
    return this.offset === null ? null : (performance.now() + this.offset) / NET.TICK_MS;
  }
  // How far between the previous live tick and the latest one to draw things.
  alpha() {
    const t = this.target();
    return t === null ? 1 : Math.max(0, Math.min(1, t - (this.live - 1)));
  }

  // One of my commands. The game has already applied it to the live copy.
  queue(cmd) {
    const stamp = this.live; // it takes effect before the next tick runs
    const seq = ++this.seq;
    this.pending.push([seq, stamp, cmd]);
    if (!this.mine.has(stamp)) this.mine.set(stamp, []);
    this.mine.get(stamp).push([this.me, seq, ...cmd]);
    if (this.server) this.server.submit(this.me, seq, stamp, cmd);
    else this.send();
  }

  // The host's own client: a bundle straight from the server.
  confirm(k, bundle) {
    if (bundle.length) this.bundles.set(k, bundle);
    this.got = k;
    this.window = this.server.window;
  }

  // A guest: bundles (and the clock) from the host.
  receive(d) {
    if (this.ended || !d || d.v !== NET.PROTOCOL) return;
    const now = performance.now();
    this.lastHeard = now;
    Trace.msgIn(JSON.stringify(d).length);
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
    // The clock: the host's time when it sent this, plus half a round trip.
    // Messages held up on the way would make us think the host is behind, so
    // trust the most hopeful of the recent ones, and move there gently.
    if (typeof d.now === "number") {
      this.offsets.push(d.now * NET.TICK_MS + (this.rtt || 0) / 2 - now);
      if (this.offsets.length > 40) this.offsets.shift();
      const best = Math.max(...this.offsets);
      if (this.offset === null || Math.abs(best - this.offset) > 1000) this.offset = best;
      else this.offset += (best - this.offset) * 0.1;
    }
    if (typeof d.w === "number") this.window = d.w;
    if (d.acks && typeof d.acks[this.me] === "number") this.taken = Math.max(this.taken, d.acks[this.me]);
    for (const e of Array.isArray(d.ticks) ? d.ticks : []) {
      if (Array.isArray(e) && typeof e[0] === "number" && e[0] > this.final && Array.isArray(e[1])) this.bundles.set(e[0], e[1]);
    }
    if (typeof d.upTo === "number" && d.upTo > this.got) this.got = d.upTo;
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
    const msg = { v: NET.PROTOCOL, from: this.me, token: this.token, cmds, ack: this.got, sum: this.latestSum(), echo, gt: Math.round(performance.now()) };
    this.t.emit("cmd", msg);
    Trace.msgOut(JSON.stringify(msg).length);
    this.lastSend = performance.now();
  }

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
      if (this.live - this.final > NET.MAX_AHEAD) { stalled = true; break; }
      this.stepLive();
      steps++;
    }
    if (this.t && performance.now() - this.lastSend > NET.TICK_MS) this.send();
    return { steps, stalled };
  }

  stepLive() {
    const k = this.live;
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
      const assumed = this.mine.get(k) || [];
      const same = bundle.length === assumed.length &&
        bundle.every((e, i) => e.length === assumed[i].length && e.every((v, j) => v === assumed[i][j]));
      if (!same && !this.dirty) {
        this.dirty = bundle.some(e => e[0] !== this.me && e[0] !== 0) ? "remote"
          : bundle.some(e => e[0] === 0) ? "system" : "moved";
      }
      for (const e of bundle) {
        if (e[0] === this.me) this.pending = this.pending.filter(p => p[0] !== e[1]);
        else if (e[0] !== 0) { this.stats.seenLate.push(this.live - k); if (this.stats.seenLate.length > 50) this.stats.seenLate.shift(); }
        else if (e[2] === 7) this.hooks.system(e.slice(2));
      }
      // Step the confirmed copy: swap it in, run the tick, swap it back.
      W.mp_swap();
      for (const e of bundle) { const c = cleanCmd(e.slice(2)); if (c) this.hooks.apply(e[0], c); }
      W.tick();
      W.take_events(); // the live copy already showed these (or will)
      const whole = W.checksum(), own = W.checksum_owner(this.me);
      this.finalState = W.state();
      W.mp_swap();
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
        if (same && ls[0] !== whole && !this.dirty) { this.stats.unexplained++; this.dirty = "unexplained"; Trace.event("unexplained", { tick: k }); }
      } else if (k >= this.live && !this.dirty) this.dirty = "behind"; // confirmed overtook live
      this.liveSums.delete(k);
      this.mine.delete(k);
    }
  }

  // Replace the live copy with the confirmed one and run the ticks since
  // again, with my commands the host hasn't confirmed yet.
  correct() {
    const why = this.dirty;
    this.dirty = null;
    const kept = this.hooks.keep();
    const from = this.final + 1;
    const ownBefore = this.live > from ? W.checksum_owner(this.me) : null;
    W.mp_restore();
    if (this.live < from) this.live = from; // we were behind: jump
    this.mine.clear();
    this.liveSums.clear();
    // Each of my commands goes in on its own tick, or, if that tick is
    // already final (it's on its way, late), on the first one still open.
    const due = k => this.pending.filter(p => Math.max(p[1], from) === k);
    for (let k = from; k <= this.live; k++) {
      for (const p of due(k)) {
        this.hooks.apply(this.me, p[2]);
        if (!this.mine.has(k)) this.mine.set(k, []);
        this.mine.get(k).push([this.me, p[0], ...p[2]]);
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
    if (this.hooks.restore(kept)) s.selChanged++;
    Trace.event("correct", { why, ticks: this.live - from });
  }

  snapshot() {
    const s = this.stats;
    const late = s.seenLate.length ? Math.round(s.seenLate.reduce((a, b) => a + b, 0) / s.seenLate.length * NET.TICK_MS) : null;
    const out = {
      role: this.server ? "host" : "guest", live: this.live, final: this.final, ahead: this.live - this.final, window: this.window,
      rtt: this.rtt === null ? null : Math.round(this.rtt), dev: Math.round(this.rttDev), pending: this.pending.length,
      clockErr: this.server || this.offset === null ? 0 : Math.round((this.target() - this.live) * NET.TICK_MS),
      heardAgo: Math.round(performance.now() - this.lastHeard), friendsSeenAfter: late,
      stats: Object.assign({}, s, { seenLate: undefined }),
    };
    if (this.server) out.server = this.server.snapshot();
    return out;
  }
}
