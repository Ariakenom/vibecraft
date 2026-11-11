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
  setGfx("shadows", -1);               // the same as Fast's (blobs)
  setGfxPreset("fast");
  out.keptTilt = GFX.tilt === 0.5 && "tilt" in gfxOver;
  out.droppedSame = !("shadows" in gfxOver) && GFX.shadows === -1;
  out.fastBloom = GFX.bloom === 0;
  const item = document.querySelector("#menuScreen .gfx-item[data-key=tilt]");
  out.resetShown = !item.querySelector(".gfx-reset").classList.contains("off");
  item.querySelector(".gfx-reset").click();
  out.resetDone = GFX.tilt === 0 && !("tilt" in gfxOver) && item.querySelector(".gfx-reset").classList.contains("off");
  out.saved = JSON.parse(localStorage.getItem("vibecraftGfx")).preset === "fast";
  // Every setting's controls work: click each choice, drag each slider.
  for (const it of document.querySelectorAll("#menuScreen .gfx-item")) {
    const sel = it.querySelector("select"); if (sel) { sel.selectedIndex = sel.options.length - 1 - (sel.selectedIndex === sel.options.length - 1 ? 1 : 0); sel.dispatchEvent(new Event("change")); }
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

// Nothing moves: a row keeps its height when its reset button shows, and
// buttons whose text changes keep their width (CLAUDE.md).
r = await pg.evaluate(() => {
  $("menuScreen").hidden = false;
  showTab(document.querySelector("#menuScreen .card"), "settings");
  const row = document.querySelector("#menuScreen .gfx-item[data-key=grass]");
  setGfxPreset("fancy"); delete gfxOver.grass; gfxChanged();
  const h0 = row.getBoundingClientRect().height;
  setGfx("grass", 0.2);
  const h1 = row.getBoundingClientRect().height;
  setGfx("grass", GFX_SETTINGS.find(s => s.key === "grass").fancy);
  const w = [0, 1].map(i => { showLabel($("cheatBtn"), i); return $("cheatBtn").getBoundingClientRect().width; });
  const v = [0, 1].map(i => { showLabel($("surrenderBtn"), i); return $("surrenderBtn").getBoundingClientRect().width; });
  showLabel($("cheatBtn"), 0); showLabel($("surrenderBtn"), 0);
  // The tabs stay where they are, whichever tab is open (the card's top is pinned).
  const tabsAt = ["game", "players", "settings"].map(t => { showTab(document.querySelector("#menuScreen .card"), t); return document.querySelector("#menuScreen .tabs").getBoundingClientRect().top; });
  $("menuScreen").hidden = true;
  return { h0, h1, w, v, tabsAt };
  return { h0, h1, w, v };
});
check(r.h0 > 0 && r.h0 === r.h1, `a setting's row keeps its height when changed (${r.h0}, ${r.h1})`);
check(r.w[0] === r.w[1] && r.v[0] === r.v[1], "the cheat and surrender buttons keep their width");
check(new Set(r.tabsAt).size === 1, `the menu's tabs don't move between tabs (${r.tabsAt})`);

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

// The free-workers button: how many, and a click selects them (like ".").
await pg.evaluate(() => { for (let i = 0; i < 200; i++) { W.tick(); simTick++; } readWorld(); renderTopBar(); });
r = await pg.evaluate(() => { const n = W.people(0), shown = $("idleCount").textContent; W.clear_selection(); $("idleBtn").click(); readWorld(); return { n, shown, sel: selection().length, visible: !$("idleBtn").classList.contains("gone") }; });
check(r.n > 0 && r.shown === String(r.n) && r.sel === r.n && r.visible, `the free-workers button shows ${r.shown} and selects them (${r.sel})`);
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
