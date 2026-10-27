// Spectating someone's single-player game: offered to a friend waiting in
// the lobby, matches the host's game, follows the host into the next game.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
// The host plays alone against the computer.
await host.evaluate(() => { beginGame(); });
check(await host.evaluate(() => running && !mp), "host plays single player");
await host.click("#menuBtn");
check(await host.evaluate(() => !$("watchLinkBtn").hidden && watchLink().endsWith("#watch-" + roomCode)), "the menu offers a watch link");
await host.click("#resumeBtn");
// A friend opens the invite link meanwhile: they can watch.
const friend = await open(b, "#" + code);
await friend.waitForSelector("#watchHostBtn:not([hidden])", { timeout: 30000 });
check(true, "a friend waiting in the lobby is offered \"Watch their game\"");
await friend.click("#watchHostBtn");
await friend.waitForFunction(() => watcher && watcher.loaded && observe.kind === "watch", null, { timeout: 20000 });
check(true, "...and is watching");
// Give some orders, then pause the host: the spectator catches up to the same tick and must match.
await host.evaluate(() => { readWorld(); const ids = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === 0) ids.push(E(i, F.id)); issue({ c: 1, ids, x: 30, y: 30 }); });
await sleep(3000);
await host.evaluate(() => { readWorld(); for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === K.Capitol) issue({ c: 4, ids: [E(i, F.id)], a: 0 }); });
await sleep(2000);
await host.evaluate(() => togglePause());
const [ht, hs] = await host.evaluate(() => [simTick, W.checksum()]);
await friend.waitForFunction(t => watcher.k === t, ht, { timeout: 15000 });
const fs2 = await friend.evaluate(() => W.checksum());
check(fs2 === hs, `the spectator's game is the host's game at tick ${ht}`);
await host.evaluate(() => togglePause());
// The host's game ends; then the host starts another one. The spectator follows.
const firstGame = await friend.evaluate(() => watcher.game);
await host.click("#menuBtn");
await host.click("#surrenderBtn"); await host.click("#surrenderBtn");
await host.waitForSelector("#endScreen:not([hidden])", { timeout: 10000 });
await friend.waitForSelector("#endScreen:not([hidden])", { timeout: 15000 });
check(await friend.evaluate(() => /Red won/.test($("endWhy").textContent) && /another game/.test($("endWhy").textContent) && !$("replayBtn").hidden), "the spectator sees the end, and that the next game will show");
await host.click("#againBtn"); // Main menu
await host.waitForSelector("#startScreen:not([hidden])", { timeout: 10000 });
await host.click("#startBtn"); // and a new game
await friend.waitForFunction(g => watcher && watcher.loaded && watcher.game !== g, firstGame, { timeout: 20000 });
check(await friend.evaluate(() => $("endScreen").hidden && observe.kind === "watch" && !observe.over), "the host goes to the menu and starts another game: the spectator is watching the new game");
// Stop watching: back to my own lobby.
await friend.click("#obsExit");
await friend.waitForFunction(() => !watcher && room && !guestOf && !$("startScreen").hidden && roomCode, null, { timeout: 10000 });
check(await friend.evaluate(() => !observe && !running), "Stop watching: back in my own lobby");
check(await friend.evaluate(() => readReplays().every(r => r.ticks >= 400)), "games under 20 s are not kept as replays");
for (const [pg, n] of [[host, "host"], [friend, "friend"]]) check(pg.errors.length === 0, `no page errors (${n})`);
await b.close();
process.exit(failed() ? 1 : 0);
