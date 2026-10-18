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

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const rooms = new Map(); // room name -> Set of clients
let nextId = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("VibeCraft relay is running. Connect from the game with ws://<this address>:" + PORT + "\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { id: "p" + nextId++, socket, room: null, presence: {}, buf: Buffer.alloc(0) };
  socket.on("data", chunk => {
    client.buf = Buffer.concat([client.buf, chunk]);
    let frame;
    while ((frame = readFrame(client))) {
      if (frame.op === 8) return socket.end(); // close
      if (frame.op === 9) { socket.write(makeFrame(frame.data, 10)); continue; } // ping -> pong
      if (frame.op === 1) onMessage(client, frame.data.toString("utf8"));
    }
  });
  socket.on("close", () => leave(client));
  socket.on("error", () => leave(client));
});

// Parse one complete frame from the client's buffer, or return null if we need more bytes.
function readFrame(c) {
  const b = c.buf;
  if (b.length < 2) return null;
  const op = b[0] & 0x0f, masked = b[1] & 0x80;
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  if (len > 65536) { c.socket.destroy(); return null; } // nobody needs messages this big
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
  if (typeof m.join === "string" && !c.room) {
    c.room = m.join.slice(0, 64);
    if (!rooms.has(c.room)) rooms.set(c.room, new Set());
    rooms.get(c.room).add(c);
    announce(c.room);
  } else if (m.presence && c.room) {
    c.presence = { ...c.presence, ...m.presence };
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

server.listen(PORT, () => console.log(`VibeCraft relay listening on ws://localhost:${PORT}`));
