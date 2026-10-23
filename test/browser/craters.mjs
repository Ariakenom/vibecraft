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
check(page.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
