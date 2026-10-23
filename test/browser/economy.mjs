// Playtest fixes: a building only shows once a builder gets there, builders
// stay on as its crew, the Capitol shows the next newcomer and the cap,
// people come first in the top bar, every unit can attack-move, and the
// name box rerolls a random name every time it's emptied.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b);
await pg.evaluate(() => { newGame(7, 0, 2); running = true; Rec.real = true; $("startScreen").hidden = true; });
await sleep(300);
check(await pg.evaluate(() => $("res").firstElementChild.classList.contains("pop")), "people come first in the top bar");
// A lumber camp by the nearest forest, placed with one worker far away.
const camp = await pg.evaluate(() => {
  readWorld();
  const c = findOwn(K.Capitol), cx = E(c, F.x), cy = E(c, F.y);
  let best = null;
  for (let r = 3; r < 30 && !best; r++) for (let dy = -r; dy <= r && !best; dy++) for (let dx = -r; dx <= r && !best; dx++)
    if (W.can_place(K.LumberCamp, (cx | 0) + dx, (cy | 0) + dy)) best = [(cx | 0) + dx, (cy | 0) + dy];
  const ws = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === K.Worker) ws.push(E(i, F.id));
  issue({ c: 6, ids: ws.slice(0, 1), x: best[0], y: best[1], a: K.LumberCamp });
  W.tick(); readWorld();
  for (let i = 0; i < entCount; i++) if (E(i, F.kind) === K.LumberCamp) return E(i, F.id);
  return -1;
});
check(camp >= 0 && await pg.evaluate(id => (E(byId.get(id), F.flags) & 512) !== 0, camp), "placed: it isn't there yet (only marked for you)");
await pg.waitForFunction(id => { readWorld(); const i = byId.get(id); return i != null && !(E(i, F.flags) & 512); }, camp, { timeout: 30000 });
check(true, "a builder got there: now it's there");
await pg.waitForFunction(id => { readWorld(); const i = byId.get(id); return !(E(i, F.flags) & 2); }, camp, { timeout: 60000 });
check(await pg.evaluate(() => stat(K.LumberCamp, 7)) === 1, "a lumber camp takes one worker");
await pg.waitForFunction(id => { readWorld(); return E(byId.get(id), F.residents) === 1; }, camp, { timeout: 20000 });
check(true, "its builder stays on as its worker");
// The Capitol: the next newcomer and the cap.
const cap = await pg.evaluate(() => { readWorld(); const i = findOwn(K.Capitol); setSelection([E(i, F.id)]); renderSelection(true); return $("sel").textContent; });
check(/People \d+ of \d+ beds/.test(cap) && (/Next newcomer/.test(cap) || /Every bed is taken/.test(cap)), "the Capitol shows people, the cap, and the next newcomer");
// Workers can attack-move.
const am = await pg.evaluate(() => { readWorld(); const ws = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === K.Worker) ws.push(E(i, F.id)); setSelection(ws.slice(0, 2)); renderSelection(true); return !!cmdKeys["z"]; });
check(am, "workers have attack-move (Z)");
// Several kinds of training buildings: every unit gets a key.
const keys = await pg.evaluate(() => {
  readWorld(); const c = findOwn(K.Capitol); const cx = E(c, F.x) | 0, cy = E(c, F.y) | 0;
  const r = W.debug_spawn(K.Range, cx + 6, cy - 8), bk = W.debug_spawn(K.Barracks, cx - 9, cy - 8);
  readWorld(); setSelection([r, bk]); renderSelection(true);
  return [...$("cmd").querySelectorAll("button")].filter(b => /^Train/.test(b.getAttribute("aria-label"))).every(b => b.dataset.key);
});
check(keys, "a barracks and a range selected together: every unit has a hotkey");
// Houses: an Upgrade button (Z), which says why not yet.
const up = await pg.evaluate(() => {
  readWorld(); const c = findOwn(K.Capitol); const cx = E(c, F.x) | 0, cy = E(c, F.y) | 0;
  const h = W.debug_spawn(K.Hut, cx - 9, cy + 6); readWorld(); setSelection([h]); renderSelection(true);
  const b = [...$("cmd").querySelectorAll("button")].find(b => /^Upgrade/.test(b.getAttribute("aria-label")));
  return b ? [b.getAttribute("aria-label"), b.classList.contains("locked"), !!cmdKeys["z"]] : null;
});
check(up && up[0] === "Upgrade to Cottage" && up[1] && up[2], `a hut has "Upgrade to Cottage" (Z), locked until it's ready (${up})`);
// Era pages of the build menu: Shift and a key picks one; a click on a tab
// works even when the panel would have been redrawn while it was held.
await pg.evaluate(() => { W.debug_set_era(2); readWorld(); const c = findOwn(K.Capitol); setSelection([E(c, F.id)]); renderSelection(true); });
await pg.keyboard.press("Shift+E");
check(await pg.evaluate(() => buildPage) === 1, "Shift+E: the Medieval page");
await pg.keyboard.press("Shift+Q");
check(await pg.evaluate(() => buildPage) === 0, "Shift+Q: back to the Ancient page");
const tab = await pg.$("#cmd button.page:nth-of-type(3)");
const tb = await tab.boundingBox();
await pg.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
await pg.mouse.down();
await pg.evaluate(() => { selKey = "changed"; renderSelection(false); }); // something changed meanwhile
await pg.mouse.up();
await pg.evaluate(() => renderSelection(false));
check(await pg.evaluate(() => buildPage) === 2, "clicking an era tab works even if the panel changed while it was held");
// Replays say which version of the game made them.
const v = await pg.evaluate(() => { const v = Rec.object("test").version; return [v, v.protocol === NET.PROTOCOL && v.replay === REPLAY_FORMAT]; });
check(v[1] && /^[0-9a-f]{12}$/.test(v[0].sim) && typeof v[0].base === "string", `replays carry the game's version (${JSON.stringify(v[0])})`);
// The name box: empty it twice, a new random name each time.
await pg.evaluate(() => { running = false; $("startScreen").hidden = false; });
let prev = await pg.evaluate(() => myName);
for (const round of [1, 2]) {
  await pg.fill("#nameInput", ""); await pg.press("#nameInput", "Enter");
  const n = await pg.evaluate(() => [myName, $("nameInput").value, RANDOM_NAMES.includes(myName)]);
  check(n[0] === n[1] && n[2] && n[0] !== prev, `emptied the name box (${round}): a new random name (${n[0]})`);
  prev = n[0];
}
check(pg.errors.filter(e => !/WebSocket/.test(e)).length === 0, "no page errors"); if (pg.errors.length) console.log(pg.errors);
await b.close();
process.exit(failed() ? 1 : 0);
