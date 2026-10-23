// Plays a downloaded replay (.vibecraft) through the game's own simulation
// and prints what happened: eras, Capitols and players lost, nukes, where
// the fighting was, and armies standing in someone else's town.
//
//   node test/replay-report.mjs path/to/game.vibecraft [dist/vibecraft.html]
//
// It uses the wasm built into the page (dist/vibecraft.html by default). A
// replay made by another version of the rules may play out differently:
// the report says so when the versions differ, and whether the winner
// still matches.
import fs from "fs";
import zlib from "zlib";
import { fileURLToPath } from "url";

const here = fileURLToPath(new URL("..", import.meta.url));
const [replayPath, pagePath = here + "dist/vibecraft.html"] = process.argv.slice(2);
if (!replayPath) { console.error("usage: node test/replay-report.mjs game.vibecraft [page.html]"); process.exit(2); }

// The wasm and the kind names, from the page and the game's own script.
const page = fs.readFileSync(pagePath, "utf8");
const wasmB64 = page.match(/AGFzbQ[A-Za-z0-9+/=]+/g).reduce((a, b) => (b.length > a.length ? b : a));
const mainJs = fs.readFileSync(here + "web/main.js", "utf8");
const K = eval("(" + mainJs.match(/const K = (\{[\s\S]*?\});/)[1] + ")");
const KN = Object.fromEntries(Object.entries(K).map(([n, v]) => [v, n]));
const ERA = ["Ancient", "Medieval", "Gunpowder", "Industrial", "Modern", "Atomic"];
const COLOUR = ["Nature", "Blue", "Red", "Green", "Gold"];

const { instance } = await WebAssembly.instantiate(Buffer.from(wasmB64, "base64"), {});
const W = instance.exports;
const r = JSON.parse(fs.readFileSync(replayPath, "utf8"));
if (r.kind !== "replay" || typeof r.data !== "string" || !Array.isArray(r.log)) throw new Error("not a VibeCraft replay");
let bytes = Buffer.from(r.data, "base64");
if (r.z) bytes = zlib.gunzipSync(bytes);
const at = W.load_buffer(bytes.length); // (may grow memory: take the buffer after)
new Uint8Array(W.memory.buffer, at, bytes.length).set(bytes);
if (!W.load_game(bytes.length)) throw new Error("this page's version can't read that replay (its save format differs)");
W.set_view(1, 1);

const NP = W.n_players();
const who = p => (r.names && r.names[p] ? `${r.names[p]} (${COLOUR[p]})` : COLOUR[p]) + (r.who && r.who[p] === "computer" ? " [computer]" : "");
const mmss = t => `${Math.floor(t / 1200)}:${String(Math.floor(t / 20) % 60).padStart(2, "0")}`;
// Commands, exactly as the replay player applies them (watch.js, main.js).
const cmds = new Map(r.log.map(e => [e[0], e[1]]));
const clean = a => {
  if (!Array.isArray(a) || a.length < 4 || a.length > 64 || !a.every(v => typeof v === "number" && Number.isFinite(v))) return null;
  const c = a[0] | 0;
  return c < 1 || c > 14 ? null : [c, a[1] >>> 0, a[2], a[3], ...a.slice(4).map(v => v >>> 0)];
};
const apply = (owner, a) => {
  if ((a[0] === 7 || a[0] === 13) && owner !== 0) return 0;
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(W.memory.buffer);
  a.slice(4).forEach((id, n) => { buf[p + n] = id; });
  return W.command(owner, a[0], a.length - 4, a[2], a[3], a[1]);
};
const ents = () => {
  const n = W.render(), f = new Float32Array(W.memory.buffer, W.ents_ptr(), n * 18), out = [];
  for (let i = 0; i < n; i++) out.push({ kind: f[i * 18 + 1], owner: f[i * 18 + 2], x: f[i * 18 + 3], y: f[i * 18 + 4] });
  return out;
};
// Where each player's town is: their Capitols (updated as they found more).
let caps = [];
const readCaps = () => { caps = ents().filter(e => e.kind === K.Capitol).map(e => [e.owner, e.x, e.y]); };
const townOf = (x, y) => { let best = 0, bd = 1e9; for (const [p, cx, cy] of caps) { const d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; best = p; } } return [best, bd]; };

const events = [], deaths = [], raids = [], refused = {}, made = {};
const MIN = 1200, WINDOW = 3;
for (let k = 0; k < r.ticks; k++) {
  if (k % 600 === 0) {
    readCaps();
    const here = {};
    for (const e of ents()) {
      if (e.kind < 1 || e.kind >= 64 || e.owner < 1) continue;
      const [p, d] = townOf(e.x, e.y);
      if (p !== e.owner && d < 24) { const key = `${e.owner}>${p}`; (here[key] ||= {})[KN[e.kind]] = (here[key][KN[e.kind]] || 0) + 1; }
    }
    raids.push([k, here]);
  }
  for (const e of cmds.get(k) || []) {
    const c = clean(e.slice(2));
    if (!c) continue;
    const res = apply(e[0] >>> 0, c);
    const what = c[0] === 4 || c[0] === 6 ? `${c[0] === 4 ? "train" : "build"} ${KN[c[1]]}` : { 8: "surrender", 9: "demolish/disband", 11: "arm a nuke", 12: "launch a nuke", 14: "upgrade houses" }[c[0]];
    if (what) {
      const key = `${e[0]}|${what}`;
      made[key] = (made[key] || 0) + 1;
      if (res) refused[`${key}|${res}`] = (refused[`${key}|${res}`] || 0) + 1;
    }
  }
  W.tick();
  const n = W.take_events();
  if (!n) continue;
  const ev = new Float32Array(W.memory.buffer, W.events_ptr(), n).slice();
  for (let i = 0; i < n; i += 4) {
    const [type, x, y, d] = ev.subarray(i, i + 4);
    if (type === 5) {
      const owner = Math.floor(d / 100), kind = Math.round(d - owner * 100);
      const slot = Math.floor(k / (MIN * WINDOW));
      deaths[slot] ||= { died: {}, at: {} };
      deaths[slot].died[owner] = (deaths[slot].died[owner] || 0) + 1;
      const [town] = townOf(x, y);
      deaths[slot].at[town] = (deaths[slot].at[town] || 0) + 1;
      void kind;
    } else {
      const text = {
        14: () => `${who(d)} is out`,
        17: () => `${who(d >> 4)} reaches the ${ERA[d & 15]} era`,
        19: () => `${who(d)} launches a nuke (lands near ${who(townOf(x, y)[0])}'s town, ${Math.round(townOf(x, y)[1])} tiles from a Capitol)`,
        20: () => `the nuke lands`,
        21: () => `${who(d)} loses a Capitol and the town around it`,
        22: () => `an air defense shoots down ${who(d)}'s nuke`,
        23: () => `${who(d)} builds a missile silo`,
        24: () => `${who(d)} starts arming a nuke`,
      }[type];
      if (text) events.push([k, text()]);
    }
  }
}

const out = [];
out.push(`${r.players} players, ${mmss(r.ticks)} long, ${r.mp ? "online" : "single player"}. Result recorded: ${r.result || "?"}.`);
const winner = W.winner_player();
out.push(winner ? `Played out here: ${who(winner)} wins.` : "Played out here: no winner yet.");
const sim = page.match(/"sim":\s*"([0-9a-f]+)"/);
if (r.version && sim && r.version.sim !== sim[1]) out.push(`(Made by another version, ${r.version.base || r.version.sim}: it may not play out as it went.)`);
out.push("", "Players:");
for (let p = 1; p <= NP; p++) out.push(`  ${who(p)}: era ${ERA[W.player_era(p)]}, trained ${W.player_stat(p, 0)}, lost ${W.player_stat(p, 1)}, built ${W.player_stat(p, 2)}${W.defeated(p) ? ", out" : ""}`);
out.push("", "Events:");
for (const [k, t] of events) out.push(`  ${mmss(k).padStart(5)}  ${t}`);
out.push("", `Deaths, every ${WINDOW} minutes (whose, and in whose town):`);
deaths.forEach((s, i) => {
  if (!s) return;
  const f = o => Object.entries(o).map(([p, n]) => `${COLOUR[p]} ${n}`).join(", ");
  out.push(`  ${String(i * WINDOW).padStart(3)}–${i * WINDOW + WINDOW} min: ${f(s.died)}  |  in the town of ${f(s.at)}`);
});
out.push("", "Soldiers standing in someone else's town (every 30 s, when any):");
for (const [k, here] of raids) {
  const parts = Object.entries(here).map(([key, kinds]) => {
    const [a, b] = key.split(">");
    return `${COLOUR[a]} in ${COLOUR[b]}'s: ${Object.entries(kinds).map(([n, c]) => `${c} ${n}`).join(", ")}`;
  });
  if (parts.length) out.push(`  ${mmss(k).padStart(5)}  ${parts.join("; ")}`);
}
const refusedList = Object.entries(refused);
if (refusedList.length) {
  out.push("", "Orders refused (player | order | reason code, how often):");
  for (const [key, n] of refusedList) out.push(`  ${key.split("|").map((v, i) => (i === 0 ? COLOUR[v] : v)).join(" | ")}: ${n}`);
}
console.log(out.join("\n"));
