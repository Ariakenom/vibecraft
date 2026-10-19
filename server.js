// A tiny WebSocket relay for VibeCraft multiplayer, for when you run the game
// from your own copy (dist/vibecraft.html) instead of the published page.
//
//   node server.js            (listens on port 8787)
//   PORT=9000 node server.js
//
// Then in the game: "Play with a friend", relay address ws://<this computer>:8787.
// Friends on your network use your computer's LAN address, e.g. ws://192.168.1.20:8787.
//
// The server knows nothing about the game. Clients join a named room and the
// server forwards every message to the others in that room, plus a list of
// who's there. It's the same job the claude.ai `room` capability does for the
// published page. No dependencies: the WebSocket handshake and framing are
// done by hand below (RFC 6455), which is a nice look at how WebSockets work.
//
// Settings (environment variables):
//   ALLOWED_ORIGINS  pages allowed to connect, comma-separated (default
//                    https://ginnu.freemyip.com); local copies and pages on
//                    localhost or a home network are always allowed; "*" = anyone
//   MAX_CONNECTIONS  total open connections (default 200)
//   MAX_PER_IP       open connections from one address (default 8)

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const rooms = new Map(); // room name -> Set of clients
const clients = new Set(); // every open connection, for the heartbeat
const perIp = new Map(); // address -> open connections from it
let nextId = 1;

// Who may connect. Browsers send the address of the page that opened the
// connection (the Origin header), so this stops other websites from using the
// relay. A local copy opened as a file sends "null". ALLOWED_ORIGINS is a
// comma-separated list that replaces the site address below; "*" allows all.
const SITES = (process.env.ALLOWED_ORIGINS || "https://ginnu.freemyip.com").split(",").map(s => s.trim()).filter(Boolean);
const LOCAL = /^(null|https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)(:\d+)?)$/;
function originOk(origin) {
  if (SITES.indexOf("*") >= 0) return true;
  if (!origin) return false; // not a browser
  return SITES.indexOf(origin) >= 0 || LOCAL.test(origin);
}

const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 200;
const MAX_PER_IP = Number(process.env.MAX_PER_IP) || 8;
const MAX_PER_ROOM = 16;
const MAX_MESSAGE = 16 * 1024;  // bytes; the game's messages are a few KB at most
const MAX_PRESENCE = 8 * 1024;  // bytes of state one connection may keep here
const RATE = 60, BURST = 120;   // messages a second per connection (the game sends about 25)
const PING_EVERY = 30 * 1000; // ask each connection "are you there?" this often
const SILENT_LIMIT = 75 * 1000; // and drop it after this long without a word

// The visitor's address. Behind nginx every connection comes from 127.0.0.1,
// so then we trust the X-Real-IP header nginx adds (and only then).
function addressOf(req) {
  const direct = req.socket.remoteAddress || "";
  const local = direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
  const fwd = local && (req.headers["x-real-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim());
  return fwd || direct;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("VibeCraft relay is running. Connect from the game with ws://<this address>:" + PORT + "\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const ip = addressOf(req);
  const refuse = why => { socket.end("HTTP/1.1 " + why + "\r\nConnection: close\r\n\r\n"); };
  if (!originOk(req.headers.origin)) return refuse("403 Forbidden");
  if (clients.size >= MAX_CONNECTIONS || (perIp.get(ip) || 0) >= MAX_PER_IP) return refuse("503 Service Unavailable");
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { id: "p" + nextId++, socket, ip, room: null, presence: {}, buf: Buffer.alloc(0), heard: Date.now(), gone: false, tokens: BURST, filled: Date.now() };
  clients.add(client);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  socket.setNoDelay(true);
  socket.on("data", chunk => {
    client.heard = Date.now(); // any traffic, including a pong, means it's alive
    client.buf = Buffer.concat([client.buf, chunk]);
    let frame;
    while ((frame = readFrame(client))) {
      if (frame.op === 8) return socket.end(); // close
      if (frame.op === 9) { socket.write(makeFrame(frame.data, 10)); continue; } // ping -> pong
      if (frame.op !== 1) continue;
      if (!allowed(client)) continue; // over its rate: drop the message
      // Never let one bad message take the relay (and everyone's games) down.
      try { onMessage(client, frame.data.toString("utf8")); } catch (e) { console.error("bad message from", client.ip, e.message); }
    }
  });
  socket.on("end", () => socket.end()); // the other side hung up without a close frame
  socket.on("close", () => drop(client));
  socket.on("error", () => drop(client));
});

// Heartbeat. A player whose wifi died or laptop slept never says goodbye, and
// nginx would keep the connection open for a day, leaving a ghost in the room.
// So every 30 s we ping everyone (browsers answer pings by themselves) and
// close connections that have been silent too long.
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - c.heard > SILENT_LIMIT) { c.socket.destroy(); drop(c); }
    else if (!c.socket.destroyed) c.socket.write(makeFrame("", 9));
  }
}, PING_EVERY).unref();

// A token bucket: each message costs one token, tokens refill at RATE a second
// up to BURST. A connection that keeps flooding far past that is closed.
function allowed(c) {
  const now = Date.now();
  c.tokens = Math.min(BURST, c.tokens + (now - c.filled) * RATE / 1000);
  c.filled = now;
  if (c.tokens >= 1) { c.tokens--; return true; }
  if (c.tokens < -BURST) { c.socket.destroy(); return false; }
  c.tokens -= 0.1; // keeps sinking while it floods
  return false;
}

// Forget a connection (runs once, however it ended).
function drop(c) {
  if (c.gone) return;
  c.gone = true;
  clients.delete(c);
  const n = (perIp.get(c.ip) || 1) - 1;
  if (n > 0) perIp.set(c.ip, n); else perIp.delete(c.ip);
  leave(c);
}

// Parse one complete frame from the client's buffer, or return null if we need more bytes.
function readFrame(c) {
  const b = c.buf;
  if (b.length < 2) return null;
  const op = b[0] & 0x0f, masked = b[1] & 0x80;
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  if (len > MAX_MESSAGE) { c.socket.destroy(); return null; } // nobody needs messages this big
  const maskOff = off;
  if (masked) off += 4;
  if (b.length < off + len) return null;
  const data = Buffer.from(b.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) data[i] ^= b[maskOff + (i & 3)];
  c.buf = b.subarray(off + len);
  return { op, data };
}

function makeFrame(data, op = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  return Buffer.concat([head, payload]);
}

function send(c, obj) { if (!c.socket.destroyed) c.socket.write(makeFrame(JSON.stringify(obj))); }

function peersOf(room) { return [...(rooms.get(room) || [])].map(c => ({ id: c.id, presence: c.presence })); }
// Tell everyone in a room who else is there (each list leaves out the receiver).
function announce(room) {
  const all = peersOf(room);
  for (const c of rooms.get(room) || []) send(c, { peers: all.filter(p => p.id !== c.id) });
}

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== "object") return;
  if (typeof m.join === "string" && !c.room) {
    const name = m.join.slice(0, 64);
    if (rooms.has(name) && rooms.get(name).size >= MAX_PER_ROOM) return;
    c.room = name;
    if (!rooms.has(c.room)) rooms.set(c.room, new Set());
    rooms.get(c.room).add(c);
    announce(c.room);
  } else if (m.presence && typeof m.presence === "object" && !Array.isArray(m.presence) && c.room) {
    const next = { ...c.presence, ...m.presence };
    if (JSON.stringify(next).length > MAX_PRESENCE) return; // too much: keep the old state
    c.presence = next;
    announce(c.room);
  } else if (typeof m.topic === "string" && c.room) {
    for (const o of rooms.get(c.room)) if (o !== c) send(o, { topic: m.topic, data: m.data, from: c.id });
  }
}

function leave(c) {
  if (!c.room) return;
  const set = rooms.get(c.room);
  set.delete(c);
  if (set.size) announce(c.room); else rooms.delete(c.room);
  c.room = null;
}

server.listen(PORT, () => console.log(`VibeCraft relay listening on ws://localhost:${PORT}, accepting pages from ${SITES.join(", ")} and local addresses`));
