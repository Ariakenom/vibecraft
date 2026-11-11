// Seats in the host's menu during a game: a computer's skill changed from the
// row of computers, a player moved to the spectators and back, a player
// moved to the computer's seat, and a spectator dropped on a player's seat
// (who goes to the spectators). The games stay in step all the way.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();

const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
await host.evaluate(() => { seats = ["host", "open", "ai", "open"]; lobbyChanged(); });
const ann = await open(b, "#" + code);
await ann.evaluate(() => setMyName("Ann"));
const at = await ann.evaluate(() => myToken);
await host.waitForFunction(t => seats[1] === "f:" + t, at, { timeout: 20000 });
await host.evaluate(() => beginGame());
await ann.waitForFunction(() => mp && running && ME === 2, null, { timeout: 30000 });
const cy = await open(b, "#watch-" + code);
await cy.evaluate(() => setMyName("Cy"));
await cy.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 30000 });
await host.click("#menuBtn");
await host.waitForSelector("#gameSeats:not([hidden])");
const drag = async (from, to) => { await host.evaluate(() => renderGameSeats(true)); await host.dragAndDrop(from, to); };
const seat = p => `#gameSeatList li:nth-child(${p})`;
const chipOf = t => `#gameSeats .chip.movable[data-token="${t}"]`;

// 1. Hard from the row onto the computer's seat: only its skill changes.
await drag(chipOf("ai:2"), seat(3));
await ann.waitForFunction(() => W.player_difficulty(3) === 2, null, { timeout: 10000 });
check(await host.evaluate(() => W.player_difficulty(3) === 2 && W.is_ai(3) === 1), "a computer dragged from the row onto a computer's seat changes its skill, for everyone");

// 2. Ann to the spectators: the computer plays Red, she watches.
await drag(chipOf(at), "#gameSpecs");
await ann.waitForFunction(() => watcher && watcher.loaded && observe && observe.kind === "watch" && !mp, null, { timeout: 60000 });
check(await host.evaluate(() => W.is_ai(2) === 1), "a player dragged to the spectators: the computer takes over, and she watches");

// 3. ...and back onto her seat.
await host.waitForSelector(chipOf(at), { timeout: 30000 });
await drag(chipOf(at), seat(2));
await ann.waitForFunction(() => mp && ME === 2 && !watcher, null, { timeout: 30000 });
check(true, "dragged from the spectators onto her old seat, she plays it again");

// 4. Ann onto the computer's seat: she moves there, the computer takes Red.
await host.waitForFunction(t => mp.server.active.has(2) && !mp.server.joining.size, at, { timeout: 15000 });
await drag(chipOf(at), seat(3));
await ann.waitForFunction(() => mp && ME === 3 && !watcher, null, { timeout: 60000 });
check(await host.evaluate(() => W.is_ai(2) === 1 && W.is_ai(3) === 0 && W.player_difficulty(2) === 2), "dragged onto the computer's seat, a player moves there; the (Hard) computer takes hers");

// 5. Cy onto Ann's seat: Ann to the spectators, Cy plays Green.
await host.waitForFunction(() => mp.server.active.has(3) && !mp.server.joining.size, null, { timeout: 15000 });
const ct = await cy.evaluate(() => myToken);
await host.waitForSelector(chipOf(ct), { timeout: 30000 });
await drag(chipOf(ct), seat(3));
await cy.waitForFunction(() => mp && ME === 3 && !watcher, null, { timeout: 60000 });
await ann.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 60000 });
check(true, "a spectator dropped on a player's seat takes it; the player watches");

await sleep(4000);
const sums = await Promise.all([host, cy].map(pg => pg.evaluate(() => [...mp.sums])));
const common = sums[0].map(e => e[0]).filter(k => sums[1].some(e => e[0] === k));
const k = Math.max(...common);
check(common.length > 0 && sums[1].find(e => e[0] === k)[1] === sums[0].find(e => e[0] === k)[1], `the games agree (tick ${k})`);
check(await host.evaluate(() => mp.stats.desyncs === 0), "no drift");
for (const [pg, n] of [[host, "host"], [ann, "Ann"], [cy, "Cy"]]) check(pg.errors.length === 0, `no page errors (${n})`);
await b.close();
process.exit(failed() ? 1 : 0);
