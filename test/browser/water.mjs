// The water after a second map of another size. The water shader once had
// the map's size written into its text; three.js reused the first map's
// compiled shader for the second, which then read its heights at the wrong
// scale: lakes were drawn as dry sand ("dry lakes", 5 Nov 2026). This draws
// a lake on the second map and checks that it looks like water.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: true });
await pg.setViewportSize({ width: 800, height: 600 });
await pg.evaluate(() => { newGame(1, 0, 2); running = true; paused = true; $("startScreen").hidden = true; });
await sleep(3000);
await pg.evaluate(() => { newGame(650, 0, 3); running = true; paused = true; W.set_view(1, 1); centerOn(MW * 0.5, MH * 0.78); cam.dist = 48; clampCam(); });
await sleep(6000);
// Every tile of deep water in view (water all round it): is it drawn blue?
const r = await pg.evaluate(() => new Promise(res => requestAnimationFrame(() => {
  const c = R3.renderer.domElement, g = document.createElement("canvas"); g.width = c.width; g.height = c.height;
  const ctx = g.getContext("2d"); ctx.drawImage(c, 0, 0);
  const ter = new Uint8Array(W.memory.buffer, W.terrain_ptr(), MW * MH), sx = c.width / c.clientWidth;
  let n = 0, blue = 0;
  for (let y = 2; y < MH - 2; y++) for (let x = 2; x < MW - 2; x++) {
    let deep = true;
    for (let dy = -2; dy <= 2 && deep; dy++) for (let dx = -2; dx <= 2 && deep; dx++) if (ter[(y + dy) * MW + x + dx] !== 1) deep = false;
    if (!deep) continue;
    const p = worldToScreen(x + 0.5, y + 0.5, WATER_Y);
    const px = Math.round(p.x * sx), py = Math.round(p.y * sx);
    if (px < 0 || py < 0 || px >= c.width || py >= c.height * 0.85) continue;
    const d = ctx.getImageData(px, py, 1, 1).data;
    n++; if (d[2] > d[0] + 40) blue++;
  }
  res({ n, blue });
})));
console.log(r);
check(r.n > 50 && r.blue >= r.n * 0.95, `deep water on the second map is drawn as water (${r.blue} of ${r.n} tiles)`);
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
