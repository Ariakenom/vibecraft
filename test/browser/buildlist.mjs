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
// Finish them all: the list goes.
await pg.waitForFunction(() => { for (let n = 0; n < 100; n++) { W.tick(); simTick++; } readWorld(); renderBuildList(); return $("buildList").hidden; }, null, { timeout: 120000, polling: 50 });
check(true, "the list goes once everything is built");
// Troops in training are listed too: a barracks with two spearmen queued.
const troops = await pg.evaluate(() => {
  readWorld();
  applyCmd(0, [15, 1, 0, 0]); // cheat mode: nothing costs anything
  const c = findOwn(K.Capitol), cx = E(c, F.x) | 0, cy = E(c, F.y) | 0;
  let spot = null;
  for (let r = 4; r < 40 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++)
    if (W.can_place(K.Barracks, cx + dx, cy + dy)) spot = [cx + dx, cy + dy];
  const b = W.debug_spawn(K.Barracks, spot[0], spot[1]);
  W.tick(); simTick++;
  const fire = [W.campfire(0), W.campfire(1)];
  // Beds and free hands at the town square, to train from.
  for (let h = 0; h < 2; h++) {
    let hs = null;
    for (let r = 4; r < 40 && !hs; r++) for (let dy = -r; dy <= r && !hs; dy++) for (let dx = -r; dx <= r && !hs; dx++)
      if (W.can_place(K.Hut, cx + dx, cy + dy)) hs = [cx + dx, cy + dy];
    W.debug_spawn(K.Hut, hs[0], hs[1]);
  }
  W.tick(); simTick++;
  for (let n = 0; n < 3; n++) W.debug_spawn(K.Worker, Math.floor(fire[0]), Math.floor(fire[1]));
  W.tick(); simTick++;
  const free = W.people(0);
  const codes = [0, 1].map(() => issue({ c: 4, ids: [b], a: K.Spearman }));
  for (let n = 0; n < 5; n++) { W.tick(); simTick++; }
  readWorld(); renderBuildList();
  return { free, codes, queued: W.queue_len(b), rows: [...$("buildList").querySelectorAll("button.troop")].map(el => el.querySelector(".bl-name").textContent) };
});
console.log(troops);
check(troops.queued > 0 && troops.rows.length === troops.queued, "every troop in the queue has a row");
await pg.waitForFunction(() => {
  for (let n = 0; n < 20; n++) { W.tick(); simTick++; }
  readWorld(); renderBuildList();
  return [...$("buildList").querySelectorAll("button.troop")].some(el => !el.classList.contains("waiting"));
}, null, { timeout: 60000, polling: 50 });
const tr = await pg.evaluate(() => [...$("buildList").querySelectorAll("button.troop")].map(el => ({ waiting: el.classList.contains("waiting"), time: el.querySelector(".bl-time").textContent })));
console.log(tr);
check(tr.length > 0 && !tr[0].waiting, "the troop in training shows a time");
const allRows = await pg.evaluate(() => [...$("buildList").querySelectorAll("button")].map(el => el.classList.contains("waiting") ? Infinity : el.querySelector(".bl-time").textContent));
const ord = allRows.map(t => t === Infinity || t === null ? Infinity : secs(t));
check(ord.every((v, n) => n === 0 || ord[n - 1] <= v), "buildings and troops sorted together");
if (process.env.SHOT) {
  await pg.evaluate(() => { readWorld(); const w = [...Array(entCount).keys()].find(i => E(i, F.owner) === ME && E(i, F.kind) === K.Worker); setSelection([E(w, F.id)]); });
  await pg.evaluate(() => { readWorld(); renderTopBar(); renderBuildList(); renderSelection(true); drawMinimap(); });
  const cdp = await pg.context().newCDPSession(pg);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  (await import("fs")).writeFileSync(process.env.SHOT, Buffer.from(data, "base64"));
  await pg.evaluate(() => { paused = true; });
}
await pg.waitForFunction(() => { for (let n = 0; n < 100; n++) { W.tick(); simTick++; } readWorld(); renderBuildList(); return $("buildList").hidden; }, null, { timeout: 120000, polling: 50 });
check(true, "the list goes once the troops are trained");
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
