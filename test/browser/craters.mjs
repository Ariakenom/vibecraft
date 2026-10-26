// Crater marks follow the game: none left over when a replay starts or
// jumps back (playtest: a replay showed the nukes from the start).
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const page = await open(b, "", { draw: true, w: 800, h: 500 });
const r = await page.evaluate(async () => {
  newGame(5, 0, 2); running = true; Rec.begin({}); Rec.real = true;
  const start = saveBytes();
  W.debug_set_era(5);
  const silo = W.debug_spawn(K.MissileSilo, 3, 3); W.debug_set_nuke(silo, 2);
  issue({ c: 12, ids: [silo], x: 60, y: 60 });
  for (let i = 0; i < 20 * 22; i++) W.tick();
  readWorld(); render3d(1, performance.now(), 0.016);
  const during = R3.craterMeshes.length;
  loadBytes(start); readWorld(); render3d(1, performance.now(), 0.016);
  return [during, R3.craterMeshes.length, W.crater_count()];
});
check(r[0] === 1, `the nuke leaves a crater mark (${r[0]})`);
check(r[1] === 0 && r[2] === 0, `back at the start, no crater mark (${r[1]}, ${r[2]})`);
// A nuke in flight moves smoothly: between ticks too, and not up and down
// with the ground under it (playtest: it seemed to vibrate).
const steps = await page.evaluate(() => {
  newGame(5, 0, 2); running = true; Rec.real = true;
  W.debug_set_era(5);
  const silo = W.debug_spawn(K.MissileSilo, 3, 3); W.debug_set_nuke(silo, 2);
  issue({ c: 12, ids: [silo], x: 60, y: 60 });
  for (let i = 0; i < 20 * 5; i++) W.tick();
  const at = [];
  for (let t = 0; t < 12; t++) {
    W.tick(); readWorld();
    for (const a of [0, 0.25, 0.5, 0.75]) { render3d(a, performance.now(), 0.016); const p = R3.nukeMesh[0].position; at.push([p.x, p.y, p.z]); }
  }
  const d = at.slice(1).map((p, i) => Math.hypot(p[0] - at[i][0], p[1] - at[i][1], p[2] - at[i][2]));
  return [Math.min(...d), Math.max(...d)];
});
check(steps[0] > 0 && steps[1] < steps[0] * 1.5, `the nuke moves by even steps, frame to frame (${steps.map(v => v.toFixed(3))})`);
// Rocket artillery fires rockets, not stones.
const rk = await page.evaluate(() => {
  newGame(5, 0, 2); running = true; Rec.real = true;
  W.debug_set_era(5); W.set_view(1, 1); readWorld(); // the whole map: find their Capitol
  let foe = -1;
  for (let i = 0; i < entCount; i++) if (E(i, F.owner) === 2 && E(i, F.kind) === K.Capitol) foe = i;
  const fx = E(foe, F.x), fy = E(foe, F.y);
  const gun = W.debug_spawn(K.RocketArtillery, Math.round(fx - 10), Math.round(fy));
  readWorld(); issue({ c: 1, ids: [gun], x: fx, y: fy });
  let best = [0, 0];
  for (let t = 0; t < 20 * 30 && !best[0]; t++) { W.tick(); readWorld(); render3d(0.5, performance.now(), 0.016); best = [R3.rockets.count, R3.stones.count]; }
  return best;
});
check(rk[0] > 0 && rk[1] === 0, `rocket artillery fires rockets (${rk})`);
check(page.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
