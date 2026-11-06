// Levelling the ground under a building reshades only the corners around it,
// and comes out the same as reshading the whole map; a building back out of
// the fog doesn't level its site again.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: true });
await sleep(300);
const r = await pg.evaluate(() => {
  newGame(7, 0, 2, 0); running = false;
  render3d(0, performance.now(), 0.016);
  const geo = R3.terrain.geometry, cw = MW + 1;
  // A hilly spot away from water.
  let sx = 0, sy = 0, best = -1;
  for (let y = 20; y < MH - 20; y += 7) for (let x = 20; x < MW - 20; x += 7) {
    let lo = 1e9, hi = -1e9, wet = false;
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) { const v = R3.heights[(y + j) * cw + x + i]; lo = Math.min(lo, v); hi = Math.max(hi, v); wet ||= R3.wet && R3.wet[(y + j) * cw + x + i]; }
    if (!wet && hi - lo > best) { best = hi - lo; sx = x; sy = y; }
  }
  geo.attributes.normal.updateRange.count = -1; // (as after the last frame drawn)
  const t0 = performance.now();
  const base = flattenUnder(sx + 2, sy + 2, 3);
  const ms = performance.now() - t0;
  const mine = geo.attributes.normal.array.slice();
  const range = { ...geo.attributes.normal.updateRange };
  geo.computeVertexNormals();
  const all = geo.attributes.normal.array;
  let worst = 0;
  for (let i = 0; i < all.length; i++) worst = Math.max(worst, Math.abs(all[i] - mine[i]));
  const h = R3.heights.slice();
  const again = flattenUnder(sx + 2, sy + 2, 3);
  let moved = 0; for (let i = 0; i < h.length; i++) if (h[i] !== R3.heights[i]) moved++;
  return { slope: best, ms, worst, range, total: all.length, base, again, moved };
});
console.log(r);
check(r.slope > 0.05, `a sloping site (${r.slope.toFixed(2)})`);
check(r.worst < 1e-5, `the same normals as reshading everything (worst ${r.worst.toExponential(1)})`);
check(r.range.count > 0 && r.range.count < r.total / 10, `only nearby rows sent (${r.range.count} of ${r.total})`);
check(r.again === r.base && r.moved === 0, "levelling the same site again changes nothing");
check(r.ms < 30, `quick (${r.ms.toFixed(1)} ms)`);
await b.close();
process.exit(failed() ? 1 : 0);
