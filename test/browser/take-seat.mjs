// Seats changing hands mid-game: the host hands a computer's seat to a
// spectator, who plays it from there. First from a single-player game (which
// becomes a multiplayer one), then in a game with a friend already in it.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();

// Give some orders as whoever this page plays.
const orders = pg => pg.evaluate(() => {
  readWorld();
  const ids = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === 0) ids.push(E(i, F.id));
  issue({ c: 1, ids: ids.slice(0, 3), x: 20 + Math.random() * 40, y: 20 + Math.random() * 40 });
});
// The confirmed copies agree, on a tick both have a checksum of.
async function same(pages, what) {
  await sleep(3000);
  const sums = await Promise.all(pages.map(pg => pg.evaluate(() => mp ? [...mp.sums] : [])));
  const common = sums[0].map(e => e[0]).filter(k => sums.every(s => s.some(e => e[0] === k)));
  const k = Math.max(...common);
  check(common.length > 0 && sums.every(s => s.find(e => e[0] === k)[1] === sums[0].find(e => e[0] === k)[1]), `${what}: the games agree at tick ${k}`);
}
// The host gives seat `slot` to the first spectator in the menu.
async function give(host, slot) {
  await host.click("#menuBtn");
  await host.waitForSelector("#gameSeats:not([hidden])");
  await host.waitForFunction(s => $("gameSeatList").children[s - 1].querySelector("select")?.options.length > 1, slot, { timeout: 15000 });
  const sel = await host.$(`#gameSeatList li:nth-child(${slot}) select`);
  const v = await sel.evaluate(s => s.options[1].value);
  await sel.selectOption(v);
  await host.evaluate(() => { $("menuScreen").hidden = true; });
}

// ---- 1. Single player: the spectator takes over Blue ----
{
  const host = await open(b);
  await host.waitForFunction(() => roomCode && room);
  const code = await host.evaluate(() => roomCode);
  await host.evaluate(() => { beginGame(); });
  check(await host.evaluate(() => running && !mp && W.is_ai(2) === 1), "host plays single player against the computer");
  const spec = await open(b, "#watch-" + code);
  await spec.waitForFunction(() => watcher && watcher.loaded && observe.kind === "watch" && watcher.n > 0, null, { timeout: 30000 });
  check(await spec.evaluate(() => /Spectator 1/.test($("obsLabel").textContent)), "the spectator knows their number");
  await orders(host);
  await give(host, 2);
  await spec.waitForFunction(() => mp && ME === 2 && !watcher && !observe, null, { timeout: 20000 });
  check(true, "the spectator now plays Blue");
  await host.waitForFunction(() => mp && mp.server && mp.server.active.has(2) && !mp.server.joining.size, null, { timeout: 10000 });
  check(await host.evaluate(() => W.is_ai(2) === 0 && !!mp.server && $("pauseBtn").hidden), "the host's game is a multiplayer one now, Blue a person's");
  check(await spec.evaluate(() => W.is_ai(2) === 0 && W.is_ai(1) === 0), "...on the new player's copy too");
  for (let i = 0; i < 3; i++) { await orders(host); await orders(spec); await sleep(700); }
  await same([host, spec], "single player turned multiplayer");
  check(await host.evaluate(() => [...Rec.cmds.values()].some(l => l.some(e => e[0] === 2))), "Blue's new player's orders reach the host");
  check(await spec.evaluate(() => mp.stats.desyncs === 0) && await host.evaluate(() => mp.stats.desyncs === 0), "no drift");
  for (const [pg, n] of [[host, "host"], [spec, "spectator"]]) check(pg.errors.length === 0, `no page errors (${n})`);
  await host.context().close(); await spec.context().close();
}

// ---- 2. Host, a friend and the computer: a spectator takes over Green ----
{
  const host = await open(b);
  await host.waitForFunction(() => roomCode && room);
  const code = await host.evaluate(() => roomCode);
  await host.evaluate(() => { seats = ["host", "ai", "ai", "open"]; lobbyChanged(); });
  const friend = await open(b, "#" + code);
  await host.waitForFunction(() => seats.some(isFriend), null, { timeout: 20000 });
  await host.evaluate(() => beginGame());
  await friend.waitForFunction(() => mp && running, null, { timeout: 30000 });
  const fme = await friend.evaluate(() => ME);
  const aiSlot = await host.evaluate(f => [1, 2, 3].find(s => s !== 1 && s !== f), fme);
  check(await host.evaluate(s => W.is_ai(s) === 1, aiSlot), `three players: host, friend (${fme}), computer (${aiSlot})`);
  for (let i = 0; i < 2; i++) { await orders(host); await orders(friend); await sleep(500); }
  const spec = await open(b, "#watch-" + code);
  await spec.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 30000 });
  await give(host, aiSlot);
  await spec.waitForFunction(s => mp && ME === s && !watcher, aiSlot, { timeout: 20000 });
  check(true, "the spectator plays the computer's seat now");
  check(await friend.evaluate(s => W.is_ai(s) === 0, aiSlot), "the friend's game has it as a person's too");
  for (let i = 0; i < 4; i++) { await orders(host); await orders(friend); await orders(spec); await sleep(600); }
  await same([host, friend, spec], "three people");
  check(await friend.evaluate(s => [...Rec.cmds.values()].some(l => l.some(e => e[0] === s)), aiSlot), "the friend gets the new player's orders");
  // The new player leaves: the computer takes the seat back.
  await spec.context().close();
  await host.waitForFunction(s => W.is_ai(s) === 1, aiSlot, { timeout: 30000 });
  check(true, "the new player leaves: the computer takes over again");
  for (const [pg, n] of [[host, "host"], [friend, "friend"]]) check(pg.errors.length === 0, `no page errors (${n})`);
}
await b.close();
process.exit(failed() ? 1 : 0);
