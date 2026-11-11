// The lobby's seats: the host drags people between seats and the spectators.
// Two friends join, one swaps with a computer, one goes to the spectators and
// stays there, someone with the watch link gets a seat (and becomes a guest),
// and the game starts with everyone where the host put them.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();

const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
await host.evaluate(() => { seats = ["host", "ai", "open", "open"]; seatDiff = [1, 2, 1, 1]; lobbyChanged(); });
const tok = pg => pg.evaluate(() => myToken);

const ann = await open(b, "#" + code);
await ann.evaluate(() => setMyName("Ann"));
const at = await tok(ann);
await host.waitForFunction(t => seats[2] === "f:" + t, at, { timeout: 20000 });
const bo = await open(b, "#" + code);
await bo.evaluate(() => setMyName("Bo"));
const bt = await tok(bo);
await host.waitForFunction(t => seats[3] === "f:" + t, bt, { timeout: 20000 });
check(true, "two friends take the open seats");

// Ann onto the computer's seat: they swap, and the computer keeps its skill.
await host.dragAndDrop("#seats li:nth-child(3) .chip.movable", "#seats li:nth-child(2)");
check(await host.evaluate(t => seats[1] === "f:" + t && seats[2] === "ai" && seatDiff[2] === 2, at), "dragged onto the computer's seat, a friend swaps with it (the computer keeps Hard)");
await ann.waitForFunction(() => guestOf.host && guestOf.host.seats[1] === "f:" + myToken, null, { timeout: 10000 });
check(true, "...and the friend's lobby shows it");

// Bo to the spectators: the seat opens, and he isn't seated again by himself.
await host.dragAndDrop("#seats li:nth-child(4) .chip.movable", "#lobbySpecs");
check(await host.evaluate(t => seats[3] === "open" && benched.has(t) && /Bo/.test($("lobbySpecs").textContent), bt), "dragged to the spectators, the friend's seat opens and he's listed there");
await sleep(2000);
check(await host.evaluate(t => !seats.includes("f:" + t), bt), "...and he stays there, though a seat is open");
await bo.waitForFunction(() => /spectators/.test($("mpStatus").textContent) && /Bo \(you\)/.test($("lobbySpecs").textContent), null, { timeout: 10000 });
check(true, "...and his lobby says so");

// Someone with the watch link shows up with the spectators; seated, they become a guest.
const cy = await open(b, "#watch-" + code);
await cy.evaluate(() => setMyName("Cy"));
const ct = await tok(cy);
await host.waitForFunction(() => /Cy/.test($("lobbySpecs").textContent), null, { timeout: 20000 });
check(true, "a spectator from the watch link is listed too");
// (Click and click this time.)
await host.click(`#lobbySpecs .chip.movable[data-token="${ct}"]`);
await host.click("#seats li:nth-child(4)");
await cy.waitForFunction(() => guestOf && !watcher && !$("startScreen").hidden, null, { timeout: 15000 });
check(true, "given a seat, the spectator joins the lobby as a guest");
await sleep(3000);
check(await host.evaluate(t => seats[3] === "f:" + t, ct), "...and keeps the seat");
await cy.waitForFunction(() => /Cy \(you\)/.test($("seats").textContent), null, { timeout: 10000 });
check(true, "...which their lobby shows");

// Bo onto the computer's seat: he takes it.
await host.dragAndDrop(`#lobbySpecs .chip.movable[data-token="${bt}"]`, "#seats li:nth-child(3)");
check(await host.evaluate(t => seats[2] === "f:" + t && !benched.has(t), bt), "dragged from the spectators onto the computer's seat, he takes it");
check(await host.evaluate(() => !$("seats").children[0].classList.contains("drop-ok")), "nobody can be put in the host's seat");

await host.evaluate(() => beginGame());
const pages = [ann, bo, cy];
for (const pg of pages) await pg.waitForFunction(() => mp && running, null, { timeout: 30000 });
const mes = await Promise.all(pages.map(pg => pg.evaluate(() => ME)));
check(mes.join() === "2,3,4", `everyone plays the seat they were put in (${mes})`);
for (const [pg, n] of [[host, "host"], [ann, "Ann"], [bo, "Bo"], [cy, "Cy"]]) check(pg.errors.length === 0, `no page errors (${n})`);
await b.close();
process.exit(failed() ? 1 : 0);
