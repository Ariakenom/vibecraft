// The graphics settings: presets, changed settings kept across presets and
// put back by their reset button, the old four levels carried over, the
// effects running without errors, and Esc for the menu.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b);
await pg.evaluate(() => { try { localStorage.removeItem("vibecraftGfx"); } catch (e) {} });

let r = await pg.evaluate(() => {
  const out = {};
  setGfxPreset("fancy");
  setGfx("tilt", 0.5);                 // a change of its own
  setGfx("shadows", 0);                // the same as Fast's
  setGfxPreset("fast");
  out.keptTilt = GFX.tilt === 0.5 && "tilt" in gfxOver;
  out.droppedSame = !("shadows" in gfxOver) && GFX.shadows === 0;
  out.fastBloom = GFX.bloom === 0;
  const item = document.querySelector("#menuScreen .gfx-item[data-key=tilt]");
  out.resetShown = !item.querySelector(".gfx-reset").hidden;
  item.querySelector(".gfx-reset").click();
  out.resetDone = GFX.tilt === 0 && !("tilt" in gfxOver) && item.querySelector(".gfx-reset").hidden;
  out.saved = JSON.parse(localStorage.getItem("vibecraftGfx")).preset === "fast";
  // Every setting's controls work: click each choice, drag each slider.
  for (const it of document.querySelectorAll("#menuScreen .gfx-item")) {
    for (const bt of it.querySelectorAll("button[data-v]")) bt.click();
    const inp = it.querySelector("input"); if (inp) { inp.value = inp.max; inp.dispatchEvent(new Event("input")); }
  }
  out.allChanged = Object.keys(gfxOver).length >= 8;
  return out;
});
check(r.keptTilt, "a changed setting stays when switching preset");
check(r.droppedSame, "a change equal to the new preset is no longer a change");
check(r.fastBloom, "Fast turns glow off");
check(r.resetShown && r.resetDone, "the reset button shows on a change and puts it back");
check(r.saved, "the choice is saved");
check(r.allChanged, "every control changes its setting");

// The effects, with a game on (drawing is off in tests, so step them by hand).
r = await pg.evaluate(() => {
  setGfxPreset("fancy"); for (const k of Object.keys(gfxOver)) delete gfxOver[k]; gfxChanged();
  newGame(7, 0, 2); $("startScreen").hidden = true; running = true; paused = true;
  readWorld();
  let cx = 0, cy = 0;
  for (let i = 0; i < entCount; i++) if (E(i, F.kind) === K.Capitol && E(i, F.owner) === ME) { cx = E(i, F.x); cy = E(i, F.y); }
  R3.fowData.fill(255);
  fxCollapse(cx, cy, 3); fxDustRing(cx, cy, 1, 12); fxHammer(cx, cy); fxHit(cx, cy, true, true); fxHit(cx, cy, false, true);
  const n = Fx.list.length;
  for (let k = 0; k < 120; k++) Fx.update(1 / 30);
  return { n, left: Fx.list.length };
});
check(r.n > 30 && r.left === 0, `effects spawn and fade away (${r.n} spawned)`);

// Esc: with nothing selected it opens the menu, and closes it again.
await pg.evaluate(() => { W.clear_selection(); placing = null; });
await pg.keyboard.press("Escape");
const opened = await pg.evaluate(() => !$("menuScreen").hidden);
await pg.keyboard.press("Escape");
const closed = await pg.evaluate(() => $("menuScreen").hidden);
check(opened && closed, "Esc opens and closes the menu");
check(pg.errors.length === 0, "no page errors");

// The old four levels carry over.
const ctx = pg.context();
await ctx.addInitScript(() => { if (!sessionStorage.done) { sessionStorage.done = 1; localStorage.removeItem("vibecraftGfx"); localStorage.setItem("vibecraftGraphics", "ultra"); } });
await pg.reload();
await pg.waitForFunction(() => typeof GFX !== "undefined" && typeof R3 !== "undefined" && R3.renderer);
r = await pg.evaluate(() => ({ preset: gfxPreset, ao: GFX.ao, shadows: GFX.shadows }));
check(r.preset === "fancy" && r.ao === true && r.shadows === 4096, "Ultra becomes Fancy with contact shadows and the highest shadows");
await b.close();
process.exit(failed() ? 1 : 0);
