// Pause and speed in multiplayer: the host sets them for everyone, the
// games stay the same, and a computer that can't keep up gets a warning
// without holding up the others.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
const guest = await open(b, "#" + code);
await host.waitForFunction(() => seats.some(isFriend), null, { timeout: 20000 });
const guest2 = await open(b, "#" + code);
await host.waitForFunction(() => seats.filter(isFriend).length === 2, null, { timeout: 20000 });
// Keep every message shown, to check them after they've faded.
for (const pg of [host, guest, guest2]) await pg.evaluate(() => { window.toastLog = []; const t = window.toast; window.toast = (m, k) => { toastLog.push(m); return t(m, k); }; });
const told = (pg, re) => pg.evaluate(s => toastLog.some(m => new RegExp(s).test(m)), re);
await host.evaluate(() => beginGame());
await guest.waitForFunction(() => mp && running && mp.offset !== null, null, { timeout: 30000 });
await guest2.waitForFunction(() => mp && running && mp.offset !== null, null, { timeout: 30000 });
// Screen edges: the top edge of the window (over the top bar) moves the view.
{
  const y0 = await host.evaluate(() => cam.y);
  await host.mouse.move(640, 2); await sleep(600);
  const y1 = await host.evaluate(() => cam.y);
  await host.mouse.move(640, 400); await sleep(300);
  const y2 = await host.evaluate(() => cam.y); await sleep(400);
  check(y1 !== y0 && await host.evaluate(y => cam.y === y, y2), "the pointer at the window's top edge (on the top bar) scrolls the view; away from it, it stops");
}
const spec = await open(b, "#watch-" + code);
await spec.evaluate(() => { window.toastLog = []; const t = window.toast; window.toast = (m, k) => { toastLog.push(m); return t(m, k); }; });
await spec.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 30000 });
check(await host.evaluate(() => !$("pauseBtn").hidden && !$("speedBox").hidden) && await guest.evaluate(() => $("pauseBtn").hidden && $("speedBox").hidden), "the host has pause and speed; the guest doesn't");
await guest.keyboard.press("p");
await sleep(500);
check(await host.evaluate(() => mp.pace() === 1) && await told(guest, "Only the host"), "a guest's P does nothing (and says so)");

// Ticks per second on a page, measured over `ms`.
const rateOf = async (pg, ms = 2000) => { const at = () => pg.evaluate(() => mp ? mp.live : watcher.k); const a = await at(); await sleep(ms); return (await at() - a) * 1000 / ms; };
const setSpeed = (pg, v) => pg.evaluate(v => { const s = $("speedSlider"); s.value = String(v); s.dispatchEvent(new Event("input")); }, v);
await setSpeed(host, 2);
await guest.waitForFunction(() => mp.pace() === 2, null, { timeout: 5000 });
check(await guest.evaluate(() => !$("speedBox").hidden && $("speedSlider").disabled && $("speedLabel").textContent === "2×") && await told(guest, "speed to 2×"), "the host sets 2×: the guest sees it");
check(await host.evaluate(() => $("speedSlider").max === "2"), "online the slider goes up to 2×");
await sleep(3000);
const [hr, gr, sr] = await Promise.all([rateOf(host), rateOf(guest), rateOf(spec, 4000)]);
check(hr > 34 && hr < 46 && gr > 34 && gr < 46, `both run at about 40 ticks a second (host ${hr.toFixed(1)}, guest ${gr.toFixed(1)})`);
check(sr > 34 && sr < 56 && await told(spec, "speed to 2×"), `the spectator follows at the same pace, or a little faster while it catches up (${sr.toFixed(1)}), and is told`);

await host.keyboard.press("p");
await guest.waitForFunction(() => mp.pace() === 0, null, { timeout: 5000 });
await sleep(800);
const [h0, g0] = [await host.evaluate(() => mp.live), await guest.evaluate(() => mp.live)];
await sleep(1500);
const [h1, g1] = [await host.evaluate(() => mp.live), await guest.evaluate(() => mp.live)];
check(h1 === h0 && g1 === g0, `paused: nobody's game moves (host ${h0}→${h1}, guest ${g0}→${g1})`);
await spec.waitForFunction(() => !$("netWait").hidden && /Paused by/.test($("netWait").textContent) && toastLog.some(m => /paused the game/.test(m)), null, { timeout: 8000 });
await sleep(500);
const s0 = await spec.evaluate(() => watcher.k); await sleep(1000);
const s1 = await spec.evaluate(() => watcher.k);
check(s1 - s0 <= 10 && await told(spec, "paused the game"), `the spectator's view stops too, saying it's paused (${s0}→${s1}: only what was already on its way)`);
// A player leaves while it's paused: everyone hears at once.
await guest2.context().close();
await host.waitForFunction(() => toastLog.some(m => / left\. The computer takes over .* when the game goes on/.test(m)), null, { timeout: 10000 });
await guest.waitForFunction(() => toastLog.some(m => / left\. The computer takes over/.test(m)), null, { timeout: 10000 });
check(true, "a player leaves while paused: the host and the others are told at once");
check(await guest.evaluate(() => !$("netWait").hidden && /Paused by/.test($("netWait").textContent)) && await host.evaluate(() => /Press P to resume/.test($("netWait").textContent) && $("pauseBtn").textContent === "Resume"), "both are told it's paused");
// Orders given while paused go through once it runs again.
await guest.evaluate(() => { readWorld(); const ids = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === 0) ids.push(E(i, F.id)); issue({ c: 1, ids: ids.slice(0, 2), x: 30, y: 30 }); });
await host.keyboard.press("p");
await guest.waitForFunction(() => mp.pace() === 2 && $("netWait").hidden, null, { timeout: 5000 });
await spec.waitForFunction(() => toastLog.some(m => /resumed the game/.test(m)), null, { timeout: 8000 });
check(await told(guest, "resumed the game at 2×"), "resumed, at the speed it was");
await sleep(3000);
const sums = await Promise.all([host, guest].map(pg => pg.evaluate(() => [...mp.sums])));
const k = Math.max(...sums[0].map(e => e[0]).filter(t => sums[1].some(e => e[0] === t)));
check(sums[0].find(e => e[0] === k)[1] === sums[1].find(e => e[0] === k)[1], `the games agree at tick ${k}, after speeding up and pausing`);
check(await host.evaluate(() => [...Rec.cmds.values()].some(l => l.some(e => e[0] !== 1 && e[0] !== 0))), "the order given while paused reached the host");

// Cheat mode: the host's switch reaches everyone; the guest has no switch.
await host.evaluate(() => { $("menuBtn").click(); $("cheatBtn").click(); $("menuScreen").hidden = true; });
await guest.waitForFunction(() => W.cheat() === 1, null, { timeout: 8000 });
const chk = [await host.evaluate(() => W.cheat()), await told(guest, "Cheat mode on"), await told(host, "Cheat mode on")];
check(chk[0] === 1 && chk[1] && chk[2], `the host turns cheat mode on: both can build anything, and are told (${chk})`);
check(await guest.evaluate(() => { $("menuBtn").click(); const h = $("cheatBtn").hidden; $("menuScreen").hidden = true; return h; }), "the guest has no cheat switch");
await sleep(1500);
const sums2 = await Promise.all([host, guest].map(pg => pg.evaluate(() => [...mp.sums])));
const k2 = Math.max(...sums2[0].map(e => e[0]).filter(t => sums2[1].some(e => e[0] === t)));
check(sums2[0].find(e => e[0] === k2)[1] === sums2[1].find(e => e[0] === k2)[1], `the games agree at tick ${k2}, with cheats on`);

// Save replay works online too.
await guest.evaluate(() => { $("menuBtn").click(); });
check(await guest.evaluate(() => !$("saveReplayBtn").hidden), "the menu has Save replay online");
await guest.evaluate(() => $("saveReplayBtn").click());
await guest.waitForFunction(() => readReplays().some(r => r.id === Rec.id && r.mp), null, { timeout: 5000 });
check(true, "...and it keeps the game so far among the replays");
await guest.evaluate(() => { $("menuScreen").hidden = true; });
// The guest's computer gets slow: it can't do 40 ticks a second any more.
const win0 = await host.evaluate(() => mp.server.window);
await guest.evaluate(() => { const step = mp.stepLive.bind(mp); mp.stepLive = () => { const t = performance.now(); while (performance.now() - t < 30); step(); }; });
await host.waitForFunction(() => toastLog.some(m => /can't keep up at 2×/.test(m)), null, { timeout: 15000 });
check(true, "the host is told the guest can't keep up at 2×");
for (let i = 0; i < 4; i++) {
  await guest.evaluate(() => { readWorld(); const ids = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === 0) ids.push(E(i, F.id)); issue({ c: 1, ids: ids.slice(0, 2), x: 20 + Math.random() * 20, y: 30 }); });
  await sleep(500);
}
const hr2 = await rateOf(host);
check(hr2 > 34, `the host plays on at full speed meanwhile (${hr2.toFixed(1)} ticks a second)`);
check(await host.evaluate(w => mp.server.window <= w + 1, win0), "the slow guest's late orders don't make everyone's window longer");
check(await told(guest, "can't keep up"), "the guest is told too");
await setSpeed(host, 1); // 2× -> 1×
await guest.waitForFunction(() => mp.pace() === 1, null, { timeout: 15000 });
check(true, "the host goes back to 1×");
check(await host.evaluate(() => toastLog.filter(m => / left\./.test(m)).length === 1), "...and only once (not again when the computer takes over)");
for (const [pg, n] of [[host, "host"], [guest, "guest"], [spec, "spectator"]]) check(pg.errors.length === 0, `no page errors (${n})`);
await b.close();
process.exit(failed() ? 1 : 0);
