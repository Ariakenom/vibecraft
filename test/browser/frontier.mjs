// Frontier on the page: the Mode choice and its preview, starting a game,
// barbarians in their own colour, drawing a frame of the big map, and a save
// that loads back as the same Frontier game. SHOT=file.png takes a picture.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: true });
await sleep(300);
await pg.evaluate(() => { try { localStorage.removeItem("vibecraft.mode"); } catch {} });

// The lobby: Mode, and a preview of the Frontier map with its sites.
check(await pg.evaluate(() => $("gameMode").value) === "skirmish", "Skirmish is the default mode");
await pg.selectOption("#mapMode", "pick");
await pg.fill("#mapSeed", "4242");
await sleep(100);
const small = await pg.evaluate(() => $("mapPreview").width);
await pg.selectOption("#gameMode", "frontier");
await sleep(300);
const big = await pg.evaluate(() => $("mapPreview").width);
check(big > small * 2.5, `the preview shows the Frontier map (${small} → ${big} px)`);
check(await pg.evaluate(() => localStorage.getItem("vibecraft.mode")) === "frontier", "the mode is remembered");

// Begin: a Frontier game, timed from the click to the first frame.
let t = Date.now();
await pg.click("#startBtn");
await pg.waitForFunction(() => running && W.game_time() > 0, null, { timeout: 60000 });
const startMs = Date.now() - t;
const g = await pg.evaluate(() => ({ mode: W.game_mode(), seed: W.game_seed(), n: W.n_players(), w: W.map_w(), barb: W.is_barbarian(3), col: PCOL[3], name: PNAME[3], seat: PCOL[2] }));
console.log(g);
check(g.mode === 1 && g.seed === 4242, "Begin plays the Frontier map picked");
check(g.barb === 1 && g.col === "#3a3a3a" && g.name === "Barbarians" && g.seat === "#d2452f", "barbarians in black, the seats in their own colours");
// (Software WebGL here: a Skirmish game takes ~20 s to start too.)
console.log(`started in ${(startMs / 1000).toFixed(1)} s`);
const tex = await pg.evaluate(() => ({ w: terrainCanvas.width, most: R3.renderer.capabilities.maxTextureSize }));
check(tex.w <= Math.min(8192, tex.most), `the ground texture fits the GPU (${tex.w} px, most ${tex.most})`);

// Play 6 minutes with the computer in my seat, then time drawing.
await pg.evaluate(() => { W.set_ai(ME, 1); for (let s = 0; s < 20 * 60 * 6; s++) { W.tick(); if (s % 20 === 0) W.take_events(); } });
const frames = await pg.evaluate(async () => {
  const times = [];
  const real = window.render3d;
  window.render3d = (...a) => { const t = performance.now(); const r = real(...a); times.push(performance.now() - t); return r; };
  await new Promise(r => setTimeout(r, 4000));
  window.render3d = real;
  const m = performance.now(); drawMinimap(); const mini = performance.now() - m;
  times.sort((x, y) => x - y);
  return { n: times.length, median: times[times.length >> 1], worst: times[times.length - 1], mini };
});
console.log("frames (software WebGL):", frames);
check(frames.n > 0, `frames drawn: ${frames.n} in 4 s, median ${frames.median.toFixed(0)} ms, minimap ${frames.mini.toFixed(1)} ms`);

if (process.env.SHOT) {
  const cdp = await pg.context().newCDPSession(pg);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  (await import("fs")).writeFileSync(process.env.SHOT, Buffer.from(data, "base64"));
}

// Save and load: the same Frontier game.
const r = await pg.evaluate(async () => {
  W.set_ai(ME, 0);
  const sum = W.checksum(), save = await makeSave();
  W.init(1, 1, 2); // something else meanwhile
  await loadSave(save);
  return { sum, after: W.checksum(), mode: W.game_mode(), col: PCOL[3], kb: Math.round(save.data.length * 0.75 / 1024) };
});
check(r.mode === 1 && r.sum === r.after && r.col === "#3a3a3a", `a save loads back as the same Frontier game (${r.kb} KB)`);
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
