// Single player: surrender, watch the rest, and the replay reproduces the
// game exactly (forwards, and jumping back to a keyframe).
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const p = await open(b);
await p.waitForFunction(() => roomCode && room);
await p.evaluate(() => { setSeat(2, "ai"); beginGame(); });
check(await p.evaluate(() => running && W.n_players() === 3 && !mp), "single player game with two computer players started");
// Drive the game by hand so we know exactly what happened on which tick.
const sums = await p.evaluate(() => {
  paused = true;
  const own = kind => { readWorld(); const out = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === kind) out.push(E(i, F.id)); return out; };
  const sums = {};
  window.simTick0 = simTick;
  for (let t = 0; t < 900; t++) {
    if (t === 50) issue({ c: 1, ids: own(0), x: MW / 2, y: MH / 2 });
    if (t === 120) issue({ c: 4, ids: own(K.Capitol), a: 0 });
    if (t === 121) issue({ c: 4, ids: own(K.Capitol), a: 0 });
    if (t === 500) issue({ c: 1, ids: own(0).slice(0, 2), x: 10.5, y: 12.25 });
    W.tick(); simTick++; Rec.ticks = simTick; W.take_events();
    if ([200, 450, 600, 900].includes(simTick - window.simTick0)) sums[simTick] = W.checksum();
  }
  return sums;
});
const ticks = Object.keys(sums).map(Number);
check(await p.evaluate(() => Rec.keys.length === 4 && Rec.ticks === simTick), "the recording has the 4 commands and every tick");
// Surrender from the menu: two clicks.
await p.click("#menuBtn");
await p.click("#surrenderBtn");
check(await p.textContent("#surrenderBtn") === "Really surrender?", "surrender asks to be sure");
await p.click("#surrenderBtn");
await p.waitForSelector("#outScreen:not([hidden])", { timeout: 5000 });
check(await p.evaluate(() => W.defeated(1) === 1 && W.state_of(1) === 5 && W.player_units(1, 0) === 0), "surrendered: out, nothing left, the others play on");
check(await p.evaluate(() => $("outTitle").textContent === "You surrendered" && paused), "the out card says so, and the game waits");
await p.click("#outWatchBtn");
check(await p.evaluate(() => observe && observe.kind === "out" && W.view_reveal() === 1 && !$("scoreboard").hidden && !paused), "watching the rest: whole map, scoreboard, running again");
await p.click("#sbBody tr:nth-child(2) .sb-name");
check(await p.evaluate(() => observe.view === 2 && W.view_reveal() === 0 && W.local_player() === 2 && !$("res").hidden), "seeing as Red: Red's fog and numbers");
await p.click("#sbAll");
check(await p.evaluate(() => observe.view === 0 && W.view_reveal() === 1 && $("res").hidden), "back to the whole map");
check(await p.evaluate(() => issue({ c: 1, ids: [1], x: 5, y: 5 }) === 0 && Rec.cmds.size === Rec.keys.length && Rec.keys.length === 5), "no commands while watching (only the surrender was added)");
await sleep(1500);
check(await p.evaluate(() => W.state_of(1) === 5 && running), "the computers play on");
// Leave: end screen with the replay
await p.click("#obsExit");
await p.waitForSelector("#endScreen:not([hidden])");
check(await p.evaluate(() => $("endTitle").textContent === "Surrendered" && !$("replayBtn").hidden), "end screen: Surrendered, with Watch the replay");
await p.waitForFunction(() => readReplays().length === 1);
check(await p.evaluate(() => readReplays()[0].log.length === 5 && readReplays()[0].z === true), "the replay is kept in the browser, compressed");
await p.click("#replayBtn");
await p.waitForFunction(() => Replay.on && observe && observe.kind === "replay");
check(await p.evaluate(() => !$("obsBar").hidden && getComputedStyle(document.querySelector("#obsBar .rp-only")).display !== "none"), "the replay bar shows");
const at = async t => { await p.evaluate(t => { paused = true; Replay.seek(t); }, t); await p.waitForFunction(() => Replay.target === null); return p.evaluate(() => [Replay.k, W.checksum()]); };
for (const i of [0, 2, 3, 1]) {
  const t = ticks[i];
  const [k, sum] = await at(t);
  check(k === t && sum === sums[t], `replay at tick ${t} is identical to the game (${i === 1 ? "jumping back" : "forward"})`);
}
check(await p.evaluate(() => Replay.keyframes.size >= 1), "keyframes kept while playing");
await p.evaluate(() => { Replay.setSpeed(8); if (paused) togglePause(); });
await sleep(1500);
check(await p.evaluate(t => Replay.k > t + 20 * 1.5 * 5, ticks[1]), "plays at 8×");
await p.evaluate(() => Replay.seek(Replay.end));
await p.waitForFunction(() => Replay.target === null);
await sleep(300);
check(await p.evaluate(() => W.defeated(1) === 1 && Replay.finished && paused), "plays to the end: the surrender is in the replay");
await p.click("#obsExit");
check(await p.evaluate(() => !Replay.on && !observe && !$("startScreen").hidden), "Exit replay goes back to the lobby");
// The saved replay from the list
await p.click("#startLoadBtn");
check(await p.evaluate(() => document.querySelectorAll("#replayList li .go").length === 1), "the replay is in the list");
await p.click("#replayList li .go");
await p.waitForFunction(() => Replay.on);
const [k, s] = await at(ticks[2]);
check(s === sums[ticks[2]], "the stored replay plays the same game");
check(p.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
