// The minimap takes orders: Z (attack-move) and a click there sends the
// selected units off fighting, and a right-click there moves them.
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const page = await open(b, "", { w: 1100, h: 700 });
await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 120000 }).catch(() => {});
const ids = await page.evaluate(() => {
  newGame(4, 0, 2); running = true; paused = true; Rec.real = true;
  for (const el of document.querySelectorAll("#menu, #lobby, #start, .overlay")) el.hidden = true;
  readWorld();
  let cap = -1;
  for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === K.Capitol) cap = i;
  const x = Math.round(E(cap, F.x)), y = Math.round(E(cap, F.y)) + 5;
  const ids = [0, 1, 2].map(k => W.debug_spawn(K.Spearman, x + k, y));
  readWorld(); setSelection(ids); renderSelection(true);
  return ids;
});
const box = await page.locator("#mini").boundingBox();
const order = () => page.evaluate(ids => { readWorld(); return ids.map(id => E(byId.get(id), F.order)); }, ids);
// Z, then a left-click on the minimap, near its middle: attack-move.
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press("z");
check(await page.evaluate(() => amode && $("mini").style.cursor === "crosshair" && /minimap/.test($("hint").textContent)), "in attack-move mode the minimap shows a crosshair, and the hint mentions it");
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
await page.evaluate(() => { for (let k = 0; k < 2; k++) W.tick(); });
const a = await order();
check(a.every(o => o === 2), `Z and a click on the minimap: attack-moving (orders ${a})`);
check(await page.evaluate(() => !amode && $("mini").style.cursor === ""), "...and attack-move mode ends");
// The Attack-move button, then the minimap.
await page.locator("#cmd .cbtn", { hasText: "Z" }).first().click();
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.evaluate(() => { for (let k = 0; k < 2; k++) W.tick(); });
const c = await order();
check(c.every(o => o === 2), `the button and a click on the minimap: attack-moving (orders ${c})`);
// A right-click on the minimap: move.
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6, { button: "right" });
await page.evaluate(() => { for (let k = 0; k < 2; k++) W.tick(); });
const m = await order();
check(m.every(o => o === 1), `a right-click on the minimap: moving (orders ${m})`);
check(page.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
