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
// The host drags the first spectator in the menu onto seat `slot`.
async function give(host, slot) {
  if (await host.evaluate(() => $("menuScreen").hidden)) await host.click("#menuBtn");
  await host.waitForSelector("#gameSeats:not([hidden])");
  await host.waitForSelector("#gameSpecs .chip.movable", { timeout: 15000 });
  await host.dragAndDrop("#gameSpecs .chip.movable", `#gameSeatList li:nth-child(${slot})`);
  await host.evaluate(() => { $("menuScreen").hidden = true; });
}

// ---- 1. Single player: the spectator takes over Red ----
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
  check(true, "the spectator now plays Red");
  await host.waitForFunction(() => mp && mp.server && mp.server.active.has(2) && !mp.server.joining.size, null, { timeout: 10000 });
  check(await host.evaluate(() => W.is_ai(2) === 0 && !!mp.server && !$("pauseBtn").hidden && mp.pace() === 1), "the host's game is a multiplayer one now, Red a person's (the host can still pause it)");
  check(await spec.evaluate(() => W.is_ai(2) === 0 && W.is_ai(1) === 0), "...on the new player's copy too");
  for (let i = 0; i < 3; i++) { await orders(host); await orders(spec); await sleep(700); }
  await same([host, spec], "single player turned multiplayer");
  check(await host.evaluate(() => [...Rec.cmds.values()].some(l => l.some(e => e[0] === 2))), "Red's new player's orders reach the host");
  check(await spec.evaluate(() => mp.stats.desyncs === 0) && await host.evaluate(() => mp.stats.desyncs === 0), "no drift");
  for (const [pg, n] of [[host, "host"], [spec, "spectator"]]) check(pg.errors.length === 0, `no page errors (${n})`);
  await host.context().close(); await spec.context().close();
}

// ---- 2. Host, a friend and the computer: a spectator takes over Green ----
// Everyone has picked a name this time.
{
  const host = await open(b);
  await host.waitForFunction(() => roomCode && room);
  await host.fill("#nameInput", "Ada"); await host.press("#nameInput", "Enter");
  check(await host.evaluate(() => myName === "Ada" && localStorage.getItem(NAME_KEY) === "Ada" && /Ada \(you\)/.test($("seats").textContent)), "the host picks a name, kept in the browser");
  const again = await host.context().newPage();
  await again.goto(host.url().split("#")[0]);
  await again.waitForFunction(() => typeof myName !== "undefined");
  check(await again.evaluate(() => myName === "Ada" && $("nameInput").value === "Ada"), "...and still has it on the next visit");
  await again.close();
  const code = await host.evaluate(() => roomCode);
  await host.evaluate(() => { seats = ["host", "ai", "ai", "open"]; lobbyChanged(); });
  const friend = await open(b, "#" + code);
  await friend.evaluate(() => setMyName("  Bo<>b "));
  await host.waitForFunction(() => seats.some(isFriend), null, { timeout: 20000 });
  await host.waitForFunction(() => /Bob/.test($("seats").textContent), null, { timeout: 10000 });
  check(true, "the host's lobby shows the friend's name (cleaned up)");
  await friend.waitForFunction(() => /Ada/.test($("seats").textContent) && /Bob \(you\)/.test($("seats").textContent), null, { timeout: 10000 });
  check(true, "...and so does the friend's");
  await host.evaluate(() => beginGame());
  await friend.waitForFunction(() => mp && running, null, { timeout: 30000 });
  const fme = await friend.evaluate(() => ME);
  const aiSlot = await host.evaluate(f => [1, 2, 3].find(s => s !== 1 && s !== f), fme);
  check(await host.evaluate(s => W.is_ai(s) === 1, aiSlot), `three players: host, friend (${fme}), computer (${aiSlot})`);
  for (let i = 0; i < 2; i++) { await orders(host); await orders(friend); await sleep(500); }
  check(await friend.evaluate(() => pnames[1] === "Ada" && pnames[ME] === "Bob"), "names come with the game");
  const spec = await open(b, "#watch-" + code);
  await spec.evaluate(() => setMyName("Cy"));
  await spec.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 30000 });
  check(await spec.evaluate(() => pnames[1] === "Ada" && /Ada/.test($("sbBody").textContent)), "the spectator's scoreboard has the names");
  await host.click("#menuBtn");
  await host.waitForFunction(() => /Cy/.test($("gameSpecs").textContent), null, { timeout: 15000 });
  check(true, "the host's menu shows the spectator by name");
  // Click and click works too (no mouse dragging): pick Cy up, then the seat.
  await host.click("#gameSpecs .chip.movable");
  check(await host.evaluate(s => $("gameSeatList").children[s - 1].classList.contains("drop-ok") && !$("gameSeatList").children[0].classList.contains("drop-ok"), aiSlot), "picked up, the computer's seat shows it can take them (not the host's)");
  await host.click(`#gameSeatList li:nth-child(${aiSlot})`);
  await host.evaluate(() => { $("menuScreen").hidden = true; });
  await spec.waitForFunction(s => mp && ME === s && !watcher, aiSlot, { timeout: 20000 });
  check(true, "the spectator plays the computer's seat now");
  check(await friend.evaluate(s => W.is_ai(s) === 0, aiSlot), "the friend's game has it as a person's too");
  // (Seat code 13 reaches the page: playtest-style bug, the others were
  // never told and their records kept the seat as the computer's.)
  check(await friend.evaluate(s => Rec.meta && Rec.meta.who && Rec.meta.who[s] === "human" && /takes over/.test(document.body.textContent), aiSlot), "the friend is told someone took the seat, and their record says a person plays it");
  await friend.waitForFunction(s => pnames[s] === "Cy", aiSlot, { timeout: 10000 });
  check(true, "...played by Cy");
  await spec.evaluate(() => Chat.send("hello"));
  await friend.waitForFunction(() => Chat.log.some(m => m.name === "Cy" && m.text === "hello"), null, { timeout: 10000 });
  check(true, "chat goes by name");
  for (let i = 0; i < 4; i++) { await orders(host); await orders(friend); await orders(spec); await sleep(600); }
  await same([host, friend, spec], "three people");
  check(await friend.evaluate(s => [...Rec.cmds.values()].some(l => l.some(e => e[0] === s)), aiSlot), "the friend gets the new player's orders");
  // The new player leaves: the computer takes the seat back.
  await spec.context().close();
  await host.waitForFunction(s => W.is_ai(s) === 1 && !pnames[s], aiSlot, { timeout: 30000 });
  check(true, "the new player leaves: the computer takes over again");
  for (const [pg, n] of [[host, "host"], [friend, "friend"]]) check(pg.errors.length === 0, `no page errors (${n})`);
}
await b.close();
process.exit(failed() ? 1 : 0);
