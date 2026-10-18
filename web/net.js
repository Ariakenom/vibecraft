// ===========================================================================
// Multiplayer.
//
// LOCKSTEP. Every computer runs the very same simulation. They never send
// unit positions; they send only the commands players give ("these 6 units,
// right-click at 41.2, 17.9"). Same start + same commands on the same ticks =
// the same game, because the Rust simulation is deterministic.
//
// HOST-SEQUENCED. Time is cut into turns of TURN_TICKS ticks. Players send
// their commands to the host. Entering turn T, the host bundles everything it
// has received into "frame" T + DELAY and broadcasts it; everyone (the host
// too) runs turn T once they hold frame T. One computer deciding the order
// makes it simple to drop a player who leaves: the host puts "the computer
// takes over player 3" into the next frame, and everyone applies it on the
// same tick.
//
// Messages can be lost, so every message repeats whatever the other side
// hasn't acknowledged yet. Every second we also compare a checksum of the
// game state, to catch the games drifting apart ("desync").

const NET = {
  TURN_TICKS: 2, // 2 ticks = 100 ms per turn
  DELAY: 3,      // commands run 3 turns (300 ms) after they're given
  PROTOCOL: 3,
  SUM_EVERY: 10, // compare checksums every 10 turns (1 s)
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

// --- Lockstep: the host side ---------------------------------------------------
class HostSeq {
  // `clients`: Map slot -> token, for the human guests in this game.
  constructor(transport, clients, onEnd) {
    this.t = transport;
    this.me = 1;
    this.tokens = new Map(clients);          // slot -> token
    this.active = new Set(this.tokens.keys());
    this.lastSeq = new Map();                // slot -> last command seq taken
    this.ack = new Map();                    // slot -> they have every frame up to this
    this.heard = new Map();                  // slot -> when we last heard them
    for (const s of this.active) { this.lastSeq.set(s, 0); this.ack.set(s, NET.DELAY - 1); this.heard.set(s, performance.now()); }
    this.inbox = [];                         // [player, cmd] waiting for the next frame
    this.frames = new Map();                 // frame number -> [[player, cmd], ...]
    this.sums = new Map();
    this.lastSend = 0;
    this.lastHeard = performance.now();      // the host never waits on itself
    this.onEnd = onEnd;
    transport.on("cmd", d => this.receive(d));
  }
  queue(cmd) { this.inbox.push([1, ...cmd]); }
  // Don't race ahead of a guest who's behind: wait if anyone is too far back.
  canRun(T) {
    for (const s of this.active) if (this.ack.get(s) < T - NET.DELAY - 4) return false;
    return true;
  }
  seal(T) {
    this.frames.set(T + NET.DELAY, this.inbox.splice(0));
    this.send();
  }
  runTurn(T, apply) {
    for (const e of this.frames.get(T) || []) apply(e[0], e.slice(1));
    // Keep frames until every guest has them (for resending).
    let min = Infinity; for (const s of this.active) min = Math.min(min, this.ack.get(s));
    for (const f of this.frames.keys()) if (f <= Math.min(T, min)) this.frames.delete(f);
  }
  afterTurn(T, sum) {
    if (T % NET.SUM_EVERY === 0) this.sums.set(T, sum);
    for (const t of this.sums.keys()) if (t < T - 300) this.sums.delete(t);
  }
  // Someone left: from the next frame on, the computer plays their side.
  drop(slot) {
    if (!this.active.delete(slot)) return;
    this.inbox.push([0, 7, slot, 0, 0]);
  }
  send(end) {
    let min = Infinity; for (const s of this.active) min = Math.min(min, this.ack.get(s));
    const frames = [];
    let size = 0;
    for (const [f, cmds] of [...this.frames].sort((a, b) => a[0] - b[0])) {
      if (f <= min) continue;
      size += JSON.stringify(cmds).length + 10;
      if (size > 2400 && frames.length) break;
      frames.push([f, cmds]);
    }
    let sum = null;
    if (this.sums.size) { const t = Math.max(...this.sums.keys()); sum = [t, this.sums.get(t)]; }
    this.t.emit("frame", { v: NET.PROTOCOL, frames, acks: Object.fromEntries(this.lastSeq), sum, end });
    this.lastSend = performance.now();
  }
  receive(d) {
    if (!d || d.v !== NET.PROTOCOL || !this.active.has(d.from) || this.tokens.get(d.from) !== d.token) return;
    const s = d.from;
    this.heard.set(s, performance.now());
    for (const [seq, cmd] of Array.isArray(d.cmds) ? d.cmds : []) {
      if (typeof seq === "number" && seq > this.lastSeq.get(s) && Array.isArray(cmd) && cmd[0] !== 7) { this.inbox.push([s, ...cmd]); this.lastSeq.set(s, seq); }
    }
    if (typeof d.ack === "number") this.ack.set(s, Math.max(this.ack.get(s), d.ack));
    if (Array.isArray(d.sum) && this.sums.has(d.sum[0]) && this.sums.get(d.sum[0]) !== d.sum[1]) {
      const why = `The games drifted apart at turn ${d.sum[0]}. That's a bug, sorry.`;
      this.send(why);
      this.onEnd(why);
    }
  }
  keepAlive() { if (performance.now() - this.lastSend > 250) this.send(); }
  // Guests we haven't heard from in a while (their tab closed, connection gone).
  silent(ms) { return [...this.active].filter(s => performance.now() - this.heard.get(s) > ms); }
}

// --- Lockstep: a guest's side ----------------------------------------------------
class ClientSeq {
  constructor(transport, me, token, onEnd) {
    this.t = transport;
    this.me = me;
    this.token = token;
    this.seq = 0;
    this.pending = [];                 // [seq, cmd] the host hasn't confirmed yet
    this.frames = new Map();
    this.gotUpTo = NET.DELAY - 1;      // we hold every frame up to this
    this.sums = new Map();
    this.hostSums = new Map();
    this.lastSend = 0;
    this.lastHeard = performance.now();
    this.onEnd = onEnd;
    transport.on("frame", d => this.receive(d));
  }
  queue(cmd) { this.pending.push([++this.seq, cmd]); this.send(); }
  canRun(T) { return T < NET.DELAY || this.frames.has(T); }
  seal(T) { this.send(); }
  runTurn(T, apply) {
    for (const e of this.frames.get(T) || []) if (Array.isArray(e)) apply(e[0], e.slice(1));
    this.frames.delete(T);
  }
  afterTurn(T, sum) {
    if (T % NET.SUM_EVERY !== 0) return;
    this.sums.set(T, sum);
    this.check(T);
    for (const t of this.sums.keys()) if (t < T - 300) this.sums.delete(t);
  }
  check(T) {
    if (this.sums.has(T) && this.hostSums.has(T) && this.sums.get(T) !== this.hostSums.get(T)) this.onEnd(`The games drifted apart at turn ${T}. That's a bug, sorry.`);
  }
  send() {
    let sum = null;
    if (this.sums.size) { const t = Math.max(...this.sums.keys()); sum = [t, this.sums.get(t)]; }
    // Unconfirmed commands, oldest first, kept well under the 4 KiB limit.
    const cmds = [];
    let size = 0;
    for (const e of this.pending) { size += JSON.stringify(e).length; if (size > 1500 && cmds.length) break; cmds.push(e); }
    this.t.emit("cmd", { v: NET.PROTOCOL, from: this.me, token: this.token, cmds, ack: this.gotUpTo, sum });
    this.lastSend = performance.now();
  }
  receive(d) {
    if (!d || d.v !== NET.PROTOCOL) return;
    this.lastHeard = performance.now();
    if (d.end) { this.onEnd(d.end); return; }
    for (const [f, cmds] of Array.isArray(d.frames) ? d.frames : []) {
      if (typeof f === "number" && f > this.gotUpTo && !this.frames.has(f) && Array.isArray(cmds)) this.frames.set(f, cmds);
    }
    while (this.frames.has(this.gotUpTo + 1)) this.gotUpTo++;
    const mine = d.acks && d.acks[this.me];
    if (typeof mine === "number") this.pending = this.pending.filter(([s]) => s > mine);
    if (Array.isArray(d.sum)) { this.hostSums.set(d.sum[0], d.sum[1]); this.check(d.sum[0]); }
  }
  keepAlive() { if (performance.now() - this.lastSend > 250) this.send(); }
}
