const url = process.argv[2];
const a = new WebSocket(url), b = new WebSocket(url);
let n = 0;
const both = () => { if (++n < 2) return; a.send(JSON.stringify({join:"t"})); b.send(JSON.stringify({join:"t"})); setTimeout(() => a.send(JSON.stringify({topic:"x", data:"hello"})), 300); };
a.onopen = both; b.onopen = both;
b.onmessage = e => { const m = JSON.parse(e.data); if (m.topic) { console.log("relayed:", e.data); process.exit(0); } };
a.onerror = e => { console.log("error", e.message); process.exit(1); };
setTimeout(() => { console.log("timeout"); process.exit(1); }, 5000);
