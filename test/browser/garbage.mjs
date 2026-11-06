// What the page allocates per frame in a running game, by function: Chrome's
// sampling heap profiler, counting objects already collected too. Plays a
// few minutes of Frontier (small) with the computer in your seat, selects
// your army, puts the mouse over the map, then profiles some frames.
//   node garbage.mjs [frames=40] [mode=1]   (with the relay and serve.cjs running, as run.sh does)
import { browser, open, sleep } from "./lib.mjs";
const FRAMES = +(process.argv[2] || 40), MODE = +(process.argv[3] ?? 1);
const b = await browser();
const pg = await open(b, "", { draw: true });
await sleep(300);
await pg.evaluate(async m => {
  newGame(7, 0, 2, m); running = true;
  W.set_ai(ME, 1);
  for (let s = 0; s < 20 * 60 * 6; s++) { W.tick(); if (s % 20 === 0) W.take_events(); }
  W.set_ai(ME, 0);
  readWorld();
  // Select your units, look at your town, mouse over the map.
  const ids = [];
  for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && !isBld(E(i, F.kind)) && ids.length < 60) ids.push(E(i, F.id));
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(mem.buffer); ids.forEach((id, n) => { buf[p + n] = id; }); W.select_ids(ids.length);
  const c = findOwn(K.Capitol); if (c != null) centerOn(E(c, F.x), E(c, F.y));
  mouse.inside = true; mouse.x = view._w * 0.55; mouse.y = view._h * 0.45;
  window.__frames = 0;
  const count = () => { window.__frames++; requestAnimationFrame(count); }; requestAnimationFrame(count);
}, MODE);
await sleep(2000);
const cdp = await pg.context().newCDPSession(pg);
await cdp.send("HeapProfiler.enable");
const f0 = await pg.evaluate(() => window.__frames);
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await pg.waitForFunction(n => window.__frames >= n, f0 + FRAMES, { timeout: 600000, polling: 500 });
const { profile } = await cdp.send("HeapProfiler.stopSampling");
const frames = (await pg.evaluate(() => window.__frames)) - f0;
// Self bytes by function (file:line), and by the chain of the top few callers.
const self = new Map(), chain = new Map();
const walk = (node, stack) => {
  const cf = node.callFrame, name = `${cf.functionName || "(anon)"} ${(cf.url.split("/").pop() || "").slice(0, 20)}:${cf.lineNumber + 1}`;
  const st = [...stack, name];
  if (node.selfSize) {
    self.set(name, (self.get(name) || 0) + node.selfSize);
    const key = st.slice(-4).join(" < ".replace("<", "←"));
    chain.set(st.slice(-5).reverse().join("  ←  "), (chain.get(st.slice(-5).reverse().join("  ←  ")) || 0) + node.selfSize);
    void key;
  }
  for (const c of node.children || []) walk(c, st);
};
walk(profile.head, []);
const total = [...self.values()].reduce((a, b) => a + b, 0);
const kb = n => (n / frames / 1024).toFixed(1);
console.log(`${frames} frames, ${kb(total)} KB a frame (${(total / frames * 60 / 1048576).toFixed(1)} MB/s at 60 fps)`);
console.log("\nBy function (KB per frame):");
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${kb(v).padStart(7)}  ${k}`);
console.log("\nBy call chain:");
for (const [k, v] of [...chain].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${kb(v).padStart(7)}  ${k}`);
await b.close();
