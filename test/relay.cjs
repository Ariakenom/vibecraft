// Checks the relay (server.js): who may connect, the limits, the heartbeat,
// and that bad messages can't take it down. Starts its own copy on a spare
// port with a fast heartbeat:   node test/relay.cjs
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const PORT = 8799;
// A copy of server.js with a 1 s ping and 2.5 s silence limit, so the test is quick.
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")
  .replace(/30 \* 1000; \/\/ ask/, "1000; // ask").replace(/75 \* 1000; \/\/ and/, "2500; // and");
const file = path.join(os.tmpdir(), "vibecraft-relay-test.js");
fs.writeFileSync(file, src);
const relay = spawn(process.execPath, [file], { env: Object.assign({}, process.env, { PORT }), stdio: "ignore" });
let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
function connect(origin, extra = {}) {
  return new Promise(res => {
    const headers = Object.assign({ Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" }, extra);
    if (origin) headers.Origin = origin;
    const req = http.request({ port: PORT, headers });
    req.on("upgrade", (r, sock) => res({ ok: true, sock }));
    req.on("response", r => res({ ok: false, status: r.statusCode }));
    req.on("error", e => res({ ok: false, err: e.code }));
    req.end();
  });
}
// A masked client text frame.
function frame(text) {
  const p = Buffer.from(text), m = Buffer.from([1, 2, 3, 4]);
  const d = Buffer.from(p.map((b, i) => b ^ m[i & 3]));
  const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, m, d]);
}
(async () => {
  await wait(400);
  for (const [o, want] of [["https://ginnu.freemyip.com", true], ["null", true], ["http://localhost:8099", true], ["http://192.168.1.20", true], ["https://evil.example", false], [undefined, false]]) {
    const r = await connect(o); if (r.sock) r.sock.destroy();
    check(r.ok === want, `origin ${o}: ${want ? "accepted" : "refused"}`);
  }
  await wait(200);
  const socks = []; let refusedAt = -1;
  for (let i = 0; i < 10; i++) { const r = await connect("null"); if (r.ok) socks.push(r.sock); else if (refusedAt < 0) refusedAt = i; }
  check(socks.length === 8 && refusedAt === 8, "at most 8 connections from one address");
  socks.forEach(s => s.destroy()); await wait(200);
  // Two clients in a room: a silent one is dropped, one that answers pings stays.
  const live = (await connect("null")).sock, dead = (await connect("null")).sock;
  let deadClosed = false; dead.on("close", () => { deadClosed = true; }); dead.on("data", () => {});
  live.on("data", d => { for (let i = 0; i < d.length;) { const op = d[i] & 15, len = d[i + 1]; if (op === 9) live.write(Buffer.from([0x8A, 0x80, 0, 0, 0, 0])); i += 2 + len; } });
  live.write(frame('{"join":"t"}')); dead.write(frame('{"join":"t"}'));
  // Bad messages must not crash it.
  for (const bad of ["null", "5", '"s"', "[]", '{"presence":"str"}', '{"presence":[1,2]}', '{"topic":1}']) live.write(frame(bad));
  await wait(4500);
  check(deadClosed, "a connection that never answers pings is dropped");
  check(!live.destroyed, "a connection that answers pings stays");
  check(relay.exitCode === null, "malformed messages don't crash the relay");
  relay.kill(); fs.unlinkSync(file);
  process.exit(failed ? 1 : 0);
})();
