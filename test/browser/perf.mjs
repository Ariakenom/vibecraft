// The trace (F8) in single player: frame times and where they go, once a
// second, shown in the panel and in the copied trace.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: true });
await sleep(300);
await pg.click("#startBtn");
await pg.waitForFunction(() => running && W.game_time() > 0, null, { timeout: 60000 });
check(await pg.evaluate(() => !$("netBtn").hidden && $("netBtn").textContent === "Trace"), "the Trace button shows in single player");
await pg.waitForFunction(() => Trace.samples.length >= 2, null, { timeout: 30000 });
await pg.keyboard.press("F8");
await sleep(1500);
const r = await pg.evaluate(() => ({ shown: !$("netTrace").hidden, text: $("netTraceBody").textContent, dump: JSON.parse(Trace.dump()) }));
console.log(r.text);
const s = r.dump.samples[r.dump.samples.length - 1];
check(r.shown && /Frames \d+\/s/.test(r.text) && /graphics card/.test(r.text) && /draw calls/.test(r.text), "the panel shows frames, their work and the drawing");
check(r.dump.trace === 3 && r.dump.info.role === "single player" && r.dump.info.map[0] > 0 && r.dump.info.startMs > 0, "the copied trace says what game it was and how long it took to start");
check(s.fps > 0 && s.p50 > 0 && s.avgWork && s.avgWork.draw >= 0 && s.ents > 0 && s.drawCalls > 0 && s.gaps === undefined, "each second has frames, gaps, work by part and the scene");
check(s.game && s.game.tick && s.game.tick.n > 0 && s.game.units && s.page && s.page["graphics card"] >= 0 && /Game: .* ms\/s for \d+ ticks/.test(r.text), "the game's parts and the page's are timed");
// Online too: the parts ride along with the lockstep's numbers (checked in
// the network tests); here, timing a game changes nothing: same checksum
// with timing on or off.
const same = await pg.evaluate(() => {
  const go = on => { W.prof_enable(on); W.init(9, 1, 2); W.set_ai(1, 1); W.set_ai(2, 1); for (let i = 0; i < 2400; i++) { W.tick(); if (i % 20 === 0) W.take_events(); } return W.checksum(); };
  const a = go(0), b = go(1); W.prof_enable(1); return a === b;
});
check(same, "timing a game doesn't change it");
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
