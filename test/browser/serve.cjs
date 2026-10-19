// For the browser tests: serves dist/vibecraft.html at /vibecraft/ and
// forwards /vibecraft/relay to the relay on 8787, as nginx does on ginnu.
const http = require("http"), net = require("net"), fs = require("fs");
const page = process.argv[2];
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/vibecraft/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(fs.readFileSync(page)); }
  else { res.writeHead(404); res.end(); }
});
srv.on("upgrade", (req, sock, head) => {
  const up = net.connect(8787, "127.0.0.1", () => {
    let h = `GET / HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(h + "\r\n"); if (head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
srv.listen(8080, () => console.log("serving on 8080"));
