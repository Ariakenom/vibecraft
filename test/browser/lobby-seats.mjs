// The lobby's seats: the host drags people and computers between seats, the
// spectators and the row of computers. Friends take empty seats (not the
// computers'), a friend swaps with a computer, one goes to the spectators and
// stays there, someone with the watch link gets a seat (and becomes a
// guest), computers come from the row and go back to it, the host moves to
// another colour, and the game starts with everyone where the host put them.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();

const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
await host.evaluate(() => { seats = ["host", "ai", "open", "ai"]; seatDiff = [1, 2, 1, 0]; lobbyChanged(); });
const tok = pg => pg.evaluate(() => myToken);
const seatsNow = () => host.evaluate(() => seats.map(s => s.startsWith("f:") ? "f" : s).join(","));

const ann = await open(b, "#" + code);
await ann.evaluate(() => setMyName("Ann"));
const at = await tok(ann);
await host.waitForFunction(t => seats[2] === "f:" + t, at, { timeout: 20000 });
const bo = await open(b, "#" + code);
await bo.evaluate(() => setMyName("Bo"));
const bt = await tok(bo);
await host.waitForFunction(t => lobbySpectators().includes(t), bt, { timeout: 20000 });
check(await seatsNow() === "host,ai,f,ai", "a friend takes the empty seat; with none left the next waits with the spectators (the computers keep theirs)");
await bo.waitForFunction(() => /spectators/.test($("mpStatus").textContent) && /Bo \(you\)/.test($("lobbySpecs").textContent), null, { timeout: 10000 });
check(true, "...and his lobby says so");

// Ann onto the Hard computer's seat: they swap, and the computer keeps its skill.
await host.dragAndDrop("#seats li:nth-child(3) .chip.movable", "#seats li:nth-child(2)");
check(await host.evaluate(t => seats[1] === "f:" + t && seats[2] === "ai" && seatDiff[2] === 2, at), "dragged onto a computer's seat, a friend swaps with it (the computer keeps Hard)");
await ann.waitForFunction(() => guestOf.host && guestOf.host.seats[1] === "f:" + myToken, null, { timeout: 10000 });
check(true, "...and the friend's lobby shows it");

// The Easy computer back to the row of computers: its seat opens, and Bo gets it by himself.
await host.dragAndDrop("#seats li:nth-child(4) .chip.movable", "#lobbyAis");
await host.waitForFunction(t => seats[3] === "f:" + t, bt, { timeout: 10000 });
check(true, "a computer dragged back to the row leaves; the waiting friend takes the empty seat");

// Bo to the spectators: the seat opens, and he isn't seated again by himself.
await host.dragAndDrop("#seats li:nth-child(4) .chip.movable", "#lobbySpecs");
await sleep(2000);
check(await host.evaluate(t => seats[3] === "open" && benched.has(t) && /Bo/.test($("lobbySpecs").textContent), bt), "dragged to the spectators, a friend's seat opens and he stays there");

// A Hard computer from the row onto the empty seat.
await host.dragAndDrop('#lobbyAis .chip[data-token="ai:2"]', "#seats li:nth-child(4)");
check(await host.evaluate(() => seats[3] === "ai" && seatDiff[3] === 2), "a computer from the row (Hard) takes an empty seat");

// Someone with the watch link shows up with the spectators; seated, they become a guest.
const cy = await open(b, "#watch-" + code);
await cy.evaluate(() => setMyName("Cy"));
const ct = await tok(cy);
await host.waitForFunction(() => /Cy/.test($("lobbySpecs").textContent), null, { timeout: 20000 });
// (Click and click this time.)
await host.click(`#lobbySpecs .chip.movable[data-token="${ct}"]`);
check(await host.evaluate(() => !$("seats").children[0].classList.contains("drop-ok") && $("seats").children[3].classList.contains("drop-ok")), "picked up, the seats they can go to light up (not the host's)");
await host.click("#seats li:nth-child(4)");
await cy.waitForFunction(() => guestOf && !watcher && !$("startScreen").hidden, null, { timeout: 15000 });
check(true, "given a seat, the spectator joins the lobby as a guest");
await sleep(3000);
check(await host.evaluate(t => seats[3] === "f:" + t, ct), "...and keeps the seat");

// The host swaps with a computer, then Bo goes onto that computer.
await host.dragAndDrop(`#seats li:nth-child(1) .chip.movable`, "#seats li:nth-child(3)");
check(await seatsNow() === "ai,f,host,f", "the host swaps seats with a computer");
await host.dragAndDrop(`#lobbySpecs .chip.movable[data-token="${bt}"]`, "#seats li:nth-child(1)");
check(await host.evaluate(t => seats[0] === "f:" + t && !benched.has(t), bt), "a spectator dragged onto a computer's seat takes it");

await host.evaluate(() => beginGame());
const pages = [bo, ann, cy];
for (const pg of pages) await pg.waitForFunction(() => mp && running, null, { timeout: 30000 });
const mes = await Promise.all([host, ...pages].map(pg => pg.evaluate(() => ME)));
check(mes.join() === "3,1,2,4", `everyone plays the seat they were put in, the host too (${mes})`);
check(await host.evaluate(() => pnames[3] === myName && W.is_ai(1) === 0 && W.is_ai(3) === 0), "the host plays Green, by name");
await sleep(3000);
const sums = await Promise.all([host, ...pages].map(pg => pg.evaluate(() => [...mp.sums])));
const common = sums[0].map(e => e[0]).filter(k => sums.every(s => s.some(e => e[0] === k)));
const k = Math.max(...common);
check(common.length > 0 && sums.every(s => s.find(e => e[0] === k)[1] === sums[0].find(e => e[0] === k)[1]), `the games agree (tick ${k})`);
for (const [pg, n] of [[host, "host"], [ann, "Ann"], [bo, "Bo"], [cy, "Cy"]]) check(pg.errors.length === 0, `no page errors (${n})`);
// Single player from the second seat: the host plays Red, the computer Blue.
{
  const solo = await open(b);
  await solo.evaluate(() => { seats = ["ai", "host", "open", "open"]; seatDiff = [0, 1, 1, 1]; lobbyChanged(); beginGame(); });
  check(await solo.evaluate(() => running && !mp && ME === 2 && W.is_ai(1) === 1 && W.is_ai(2) === 0 && W.player_difficulty(1) === 0), "single player from the second seat: I play Red, an Easy computer Blue");
  await solo.evaluate(() => { $("restartBtn").click(); });
  check(await solo.evaluate(() => ME === 2 && W.is_ai(1) === 1), "...and still after Restart");
  check(solo.errors.length === 0, "no page errors (single player)");
}
await b.close();
process.exit(failed() ? 1 : 0);
