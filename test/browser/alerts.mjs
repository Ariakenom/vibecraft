// Warnings on the minimap: where you were attacked shows as a red ring,
// pulsing at first, gone after 15 s; and Space still goes there.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: true });
await sleep(300);
await pg.click("#startBtn");
await pg.waitForFunction(() => running && W.game_time() > 0, null, { timeout: 60000 });
const red = () => pg.evaluate(() => {
  const s = mini.width / MW, m = alertMarks[0];
  if (!m) return 0;
  drawMinimap();
  const d = mctx.getImageData(Math.round(m.x * s) - 8, Math.round(m.y * s) - 8, 16, 16).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 110) n++;
  return n;
});
// An attack far from the camera, as the game reports one (EV.Alert).
await pg.evaluate(() => alertAt(MW * 0.7, MH * 0.3));
check(await red() > 10, "the place shows as a red ring on the minimap");
await pg.evaluate(() => alertAt(MW * 0.7 + 2, MH * 0.3 + 1));
check(await pg.evaluate(() => alertMarks.length) === 1, "a second alert at the same place restarts its ring, not a new one");
await pg.evaluate(() => alertAt(MW * 0.2, MH * 0.8));
check(await pg.evaluate(() => alertMarks.length) === 2, "an alert somewhere else gets its own ring");
await pg.keyboard.press(" ");
const at = await pg.evaluate(() => ({ cam: [cam.tx ?? cam.x, cam.tz ?? cam.y], last: [lastAlert.x, lastAlert.y] }));
console.log(at);
await pg.evaluate(() => { for (const m of alertMarks) m.t -= 16000; });
check(await red() === 0 && await pg.evaluate(() => alertMarks.length) === 0, "after 15 s the rings are gone");
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
