// The list at the top left of what's being built: yours only, soonest first,
// those waiting for builders last; it goes when everything is done, and a
// click selects that building.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: !!process.env.SHOT });
await pg.evaluate(() => { newGame(7, 0, 2); running = true; paused = true; $("startScreen").hidden = true; });
await sleep(300);
check(await pg.evaluate(() => { readWorld(); renderBuildList(); return $("buildList").hidden; }), "hidden while nothing is being built");
// Place a few foundations near the Capitol, with every worker sent to them.
const placed = await pg.evaluate(() => {
  readWorld();
  const c = findOwn(K.Capitol), cx = E(c, F.x) | 0, cy = E(c, F.y) | 0;
  const ws = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === K.Worker) ws.push(E(i, F.id));
  const kinds = [K.LumberCamp, K.Quarry, K.LumberCamp];
  const got = [];
  for (const k of kinds) {
    let spot = null;
    for (let r = 3; r < 30 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++)
      if (W.can_place(k, cx + dx, cy + dy)) spot = [cx + dx, cy + dy];
    if (!spot) continue;
    issue({ c: 6, ids: ws, x: spot[0], y: spot[1], a: k });
    W.tick(); got.push(k);
  }
  return got.length;
});
check(placed >= 2, `placed ${placed} foundations`);
// Run until at least one is rising.
await pg.waitForFunction(() => {
  for (let n = 0; n < 20; n++) { W.tick(); simTick++; }
  readWorld(); renderBuildList();
  return [...$("buildList").children].some(el => el.tagName === "BUTTON" && !el.classList.contains("waiting"));
}, null, { timeout: 60000, polling: 50 });
const rows = await pg.evaluate(() => [...$("buildList").querySelectorAll("button")].map(el => ({ waiting: el.classList.contains("waiting"), time: el.querySelector(".bl-time").textContent, name: el.querySelector(".bl-name").textContent })));
console.log(rows);
const secs = t => { const m = /^(\d+):(\d\d)$/.exec(t); return m ? +m[1] * 60 + +m[2] : Infinity; };
check(rows.length === placed, "every foundation is listed");
const order = rows.map(r => r.waiting ? Infinity : secs(r.time));
check(order.every((v, n) => n === 0 || order[n - 1] <= v), "sorted: soonest first, waiting ones last");
check(rows.filter(r => r.waiting).every(r => /builders/.test(r.time)), "waiting ones say how many builders are there");
// The rival's foundations aren't listed.
const theirs = await pg.evaluate(() => { readWorld(); let n = 0; for (let i = 0; i < entCount; i++) if ((E(i, F.flags) & 2) && E(i, F.owner) !== ME) n++; return n; });
console.log("rival foundations visible:", theirs);
// A click selects it.
const sel = await pg.evaluate(() => { $("buildList").querySelector("button").click(); readWorld(); const s = selection(); return s.length === 1 && (E(s[0], F.flags) & 2) !== 0; });
check(sel, "clicking a row selects that foundation");
if (process.env.SHOT) {
  await pg.evaluate(() => { paused = false; });
  await sleep(1500);
  await pg.evaluate(() => { readWorld(); renderTopBar(); renderBuildList(); renderSelection(true); drawMinimap(); });
  const cdp = await pg.context().newCDPSession(pg);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  (await import("fs")).writeFileSync(process.env.SHOT, Buffer.from(data, "base64"));
  await pg.evaluate(() => { paused = true; });
}
// Finish them all: the list goes.
await pg.waitForFunction(() => { for (let n = 0; n < 100; n++) { W.tick(); simTick++; } readWorld(); renderBuildList(); return $("buildList").hidden; }, null, { timeout: 120000, polling: 50 });
check(true, "the list goes once everything is built");
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
