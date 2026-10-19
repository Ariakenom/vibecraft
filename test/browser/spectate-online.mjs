// An online game (host, guest, computer) with two spectators by link: their
// copies must match the players' confirmed game tick for tick, through a
// surrender and the end; then the replays of it must too.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
const guest = await open(b, "#" + code);
await host.waitForFunction(() => seats.some(isFriend), null, { timeout: 30000, polling: 200 });
await host.evaluate(() => { beginGame(); });
await guest.waitForFunction(() => running && mp, null, { timeout: 15000 });
check(await host.evaluate(() => running && mp && mp.server && W.n_players() === 3), "online game: host, guest and a computer player");

// Collect the host's confirmed checksums as they come (it keeps only the last 30 s).
const hsums = new Map();
const collect = async () => { for (const [k, v] of await host.evaluate(() => mp ? [...mp.sums] : [])) hsums.set(k, v); };
// Players give orders now and then.
const orders = async (pg, n) => pg.evaluate(n => {
  if (!mp || observe) return;
  readWorld(); const ids = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === 0) ids.push(E(i, F.id));
  if (ids.length) issue({ c: 1, ids: ids.slice(0, 3), x: 20 + (n * 7) % 40, y: 20 + (n * 13) % 40 });
}, n);
const watchSums = pg => pg.evaluate(() => {
  window.wsums = new Map();
  const step = Watcher.prototype.step;
  Watcher.prototype.step = function () { const k = this.k; step.call(this); if (k % NET.SUM_EVERY === 0) wsums.set(k, W.checksum()); };
});
const compare = async (pg, label) => {
  await collect();
  const ws = new Map(await pg.evaluate(() => [...wsums]));
  let same = 0, diff = 0;
  for (const [k, v] of ws) if (hsums.has(k)) { if (hsums.get(k) === v) same++; else diff++; }
  check(same > 0 && diff === 0, `${label}: ${same} checksums compared with the players' game, ${diff} different`);
};

const w1 = await open(b, "#watch-" + code);
await watchSums(w1);
await w1.waitForFunction(() => observe && observe.kind === "watch" && watcher && watcher.loaded, null, { timeout: 20000 }).catch(async e => {
  console.log("watcher:", await w1.evaluate(() => JSON.stringify({ w: watcher && { game: watcher.game, snap: watcher.snapId, parts: watcher.parts.map(p => !!p), loaded: watcher.loaded, host: !!watcher.host, heard: performance.now() - watcher.lastHeard }, text: $("watchWaitText").textContent })));
  console.log("host:", await host.evaluate(() => JSON.stringify({ list: [...Watchers.list].map(([t, e]) => [t, e.have, e.game, e.snap, [...e.parts]]), snap: Watchers.snap && { T: Watchers.snap.T, n: Watchers.snap.parts.length, game: Watchers.snap.game }, rec: Rec.id, real: Rec.real, done: Rec.done, ticks: Rec.ticks, final: mp && mp.final, serving: Watchers.serving(), tokens: Watchers.tokens })));
  throw e;
});
check(await w1.evaluate(() => running && W.view_reveal() === 1 && !$("scoreboard").hidden && ME === 0), "a spectator joined by link: whole map, scoreboard");
check(await w1.evaluate(() => document.querySelectorAll("#sbBody tr").length === 3), "the scoreboard lists the three players");
for (let n = 0; n < 12; n++) { await orders(host, n); await orders(guest, n + 50); await sleep(700); await collect(); }
await host.waitForFunction(() => $("watchCount").textContent === "1 watching");
check(true, "the players see \"1 watching\"");
check(await guest.evaluate(() => $("watchCount").textContent === "1 watching"), "...the guest too");
await compare(w1, "spectator");
check(await w1.evaluate(() => watcher.avail - watcher.k < 40), "the spectator keeps up (less than 2 s behind)");

// The guest surrenders, then watches the rest.
await guest.click("#menuBtn");
await guest.click("#surrenderBtn"); await guest.click("#surrenderBtn");
await guest.waitForSelector("#outScreen:not([hidden])", { timeout: 10000 });
check(await guest.evaluate(() => mp && W.state_of(ME) === 5), "guest surrendered: out, the game goes on");
await guest.click("#outWatchBtn");
check(await guest.evaluate(() => observe.kind === "out" && W.view_reveal() === 1), "the guest watches the rest with the whole map");
await host.waitForFunction(() => W.defeated(3) === 1, null, { timeout: 5000 });
check(true, "the host's game has the guest out too");
for (let n = 0; n < 6; n++) { await orders(host, n + 100); await sleep(700); await collect(); }
check(await host.evaluate(() => mp && mp.stats.desyncs === 0) && await guest.evaluate(() => mp && mp.stats.desyncs === 0), "no drift between the players' games");
await compare(w1, "spectator after the surrender");

// A second spectator, joining late.
const w2 = await open(b, "#watch-" + code);
await watchSums(w2);
await w2.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 20000 });
for (let n = 0; n < 5; n++) { await orders(host, n + 200); await sleep(700); await collect(); }
await compare(w2, "late spectator");
check(await host.evaluate(() => $("watchCount").textContent === "2 watching"), "\"2 watching\"");

// The host gives up too: the computer wins. Everyone sees the end.
await host.click("#menuBtn");
await host.click("#surrenderBtn"); await host.click("#surrenderBtn");
await collect();
await host.waitForSelector("#endScreen:not([hidden])", { timeout: 10000 });
check(await host.evaluate(() => $("endTitle").textContent === "Surrendered" && /You surrendered\. Red wins/.test($("endWhy").textContent)), "host surrendered too: end screen, the computer (Red) wins");
await guest.waitForSelector("#endScreen:not([hidden])", { timeout: 20000 });
check(await guest.evaluate(() => /Red/.test($("endWhy").textContent)), "the guest, watching, gets the end screen too");
await w1.waitForSelector("#endScreen:not([hidden])", { timeout: 20000 });
check(await w1.evaluate(() => observe.over && /Red won/.test($("endWhy").textContent) && !$("replayBtn").hidden && $("againBtn").hidden), "spectators: game over, Red won, with Watch the replay");

// Replays: the guest's (an online game) and the spectator's (joined halfway).
const replayCheck = async (pg, label, offset = 0) => {
  await pg.waitForFunction(() => Rec.replay, null, { timeout: 10000 });
  await pg.evaluate(async () => { const r = await Rec.replay; await Replay.open(r); paused = true; });
  const keys = [...hsums.keys()].filter(k => k > offset + 100).sort((a, b) => a - b);
  let same = 0, diff = 0;
  for (const k of keys.filter((_, i) => i % 7 === 0).slice(0, 8)) {
    const sum = await pg.evaluate(async t => { Replay.seek(t); while (Replay.target !== null) await new Promise(r => setTimeout(r, 30)); Replay.step(); return [Replay.k, W.checksum()]; }, k - offset);
    if (sum[1] === hsums.get(k)) same++; else diff++;
  }
  check(same > 0 && diff === 0, `${label}: ${same} points checked against the game, ${diff} different`);
};
await replayCheck(guest, "the guest's replay of the online game");
const base = await w1.evaluate(() => Rec.base);
console.log("     spectator joined at tick", base);
await replayCheck(w1, "the spectator's replay (from where they joined)", base);
check(await w1.evaluate(() => readReplays().length === 1 && readReplays()[0].watched), "the spectator keeps the replay too, marked watched");

for (const [pg, n] of [[host, "host"], [guest, "guest"], [w1, "spectator 1"], [w2, "spectator 2"]]) check(pg.errors.length === 0, `no page errors (${n})`);
await b.close();
process.exit(failed() ? 1 : 0);
