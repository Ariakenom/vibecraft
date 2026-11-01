// Missile silo buttons: Launch (Z) and Arm a nuke (X) are always there,
// greyed out when no selected silo can do them; Demolish stays in the
// bottom-right corner. With several silos selected, each Arm press arms the
// next empty one, and nukes launch one by one (Shift-click keeps aiming).
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const pg = await open(b);
await pg.evaluate(() => { newGame(7, 0, 2); running = false; Rec.real = true; $("startScreen").hidden = true; });
// Where each button is (grid column), and whether it's greyed out.
const layout = () => pg.evaluate(() => {
  const box = $("cmd"), r0 = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const tracks = cs.gridTemplateColumns.split(" ").map(parseFloat), gap = parseFloat(cs.columnGap) || 0;
  const starts = tracks.map((_, n) => tracks.slice(0, n).reduce((a, t) => a + t + gap, 0));
  const btns = [...box.querySelectorAll(".cbtn")].map(e => { const r = e.getBoundingClientRect(), x = r.left - r0.left;
    return { name: e.getAttribute("aria-label"), x, y: r.top - r0.top, col: starts.findIndex(s => Math.abs(s - x) < 2), off: e.classList.contains("off"), count: e.querySelector(".count")?.textContent || "" }; });
  return { cols: tracks.length, btns };
});
const show = l => l.btns.map(e => `${e.name}${e.off ? "(off)" : ""}${e.count ? "×" + e.count : ""}@${e.col}`).join(", ");
const select = ids => pg.evaluate(ids => { readWorld(); setSelection(ids); selKey = ""; renderSelection(true); }, ids);
const silos = await pg.evaluate(() => {
  W.debug_set_era(5); readWorld();
  const c = findOwn(K.Capitol), cx = E(c, F.x) | 0, cy = E(c, F.y) | 0;
  // Plenty of everything, so arming is never short.
  return [W.debug_spawn(K.MissileSilo, cx + 8, cy + 8), W.debug_spawn(K.MissileSilo, cx - 8, cy + 8), W.debug_spawn(K.MissileSilo, cx + 8, cy - 8)];
});
const one = silos[0];

// One silo, in each state: both buttons there, Demolish fixed in the corner.
const spots = [];
for (const [st, label, launchOff, armOff] of [[0, "empty", true, false], [1, "arming", true, true], [2, "armed", false, true]]) {
  await pg.evaluate(([id, st]) => W.debug_set_nuke(id, st), [one, st]);
  await select([one]);
  const l = await layout(), by = n => l.btns.find(e => e.name === n);
  console.log(label, show(l));
  check(by("Launch") && by("Arm a nuke"), `silo ${label}: Launch and Arm both there`);
  check(by("Launch")?.off === launchOff && by("Arm a nuke")?.off === armOff, `silo ${label}: the right one greyed out`);
  const d = by("Demolish");
  check(d && d.col === l.cols - 1, `silo ${label}: Demolish in the last column`);
  spots.push(d && `${d.x},${d.y}`);
}
check(spots.every(s => s === spots[0]), "Demolish doesn't move as the silo arms and becomes armed");

// Three silos, all empty: each Arm press (X) arms one more (cheat mode, so
// arming costs nothing).
await pg.evaluate(ids => { applyCmd(0, [15, 1, 0, 0]); ids.forEach(id => W.debug_set_nuke(id, 0)); }, silos);
await select(silos);
console.log("3 empty", show(await layout()));
const armed = [];
for (let n = 0; n < 3; n++) {
  armed.push(await pg.evaluate(ids => { cmdKeys["x"](); return ids.filter(id => W.silo_state(id) === 1).length; }, silos));
}
check(armed.join() === "1,2,3", `each Arm press arms one more silo (${armed})`);
await select(silos);
check((await layout()).btns.find(e => e.name === "Arm a nuke").off, "all arming: Arm greyed out");

// Two armed, one arming: Launch shows 2; a click launches one, Shift-click keeps aiming.
await pg.evaluate(ids => { W.debug_set_nuke(ids[0], 2); W.debug_set_nuke(ids[1], 2); W.debug_set_nuke(ids[2], 1); }, silos);
await select(silos);
const l2 = await layout();
console.log("2 armed", show(l2));
check(l2.btns.find(e => e.name === "Launch").count === "2", "Launch shows 2 armed");
const r = await pg.evaluate(ids => {
  const out = {};
  cmdKeys["z"]();
  out.aiming = amode && aimSilo != null;
  out.hint = $("hint").textContent;
  launchAt({ x: MW / 2, y: MH / 2 }, true); // Shift-click
  out.afterFirst = ids.map(id => W.silo_state(id)).join("");
  out.stillAiming = amode && aimSilo != null;
  launchAt({ x: MW / 2 + 2, y: MH / 2 }, true); // Shift-click again: the last armed one
  out.afterSecond = ids.map(id => W.silo_state(id)).join("");
  out.doneAiming = !amode;
  out.inFlight = W.nuke_count();
  return out;
}, silos);
console.log(r);
check(r.aiming && /2 armed/.test(r.hint), "Z aims, and the hint says 2 armed");
check(r.afterFirst === "021" && r.stillAiming, "a Shift-click launches one nuke and keeps aiming");
check(r.afterSecond === "001" && r.doneAiming && r.inFlight === 2, "the next launches the second, then aiming ends");
// A plain click launches only one.
const plain = await pg.evaluate(ids => { W.debug_set_nuke(ids[0], 2); W.debug_set_nuke(ids[1], 2); readWorld(); cmdKeys["z"](); launchAt({ x: MW / 2 - 2, y: MH / 2 }, false); return [ids.map(id => W.silo_state(id)).join(""), amode]; }, silos);
check(plain[0] === "021" && plain[1] === false, "a plain click launches one, then stops aiming");
// Greyed-out buttons still answer, with a message.
await pg.evaluate(ids => ids.forEach(id => W.debug_set_nuke(id, 1)), silos);
await select(silos);
const msg = await pg.evaluate(() => { cmdKeys["z"](); cmdKeys["x"](); return [...$("toasts").children].map(t => t.textContent).slice(-2); });
check(/still arming/.test(msg[0]) && /already has a nuke/.test(msg[1]), `greyed-out buttons explain (${msg.join(" | ")})`);

// An enemy air defense shoots one down: its missile is drawn going up, and
// the nuke blows up in the air.
const shot = await pg.evaluate(ids => {
  while (W.nuke_count()) W.tick();
  W.set_view(1, 1); readWorld();
  const craters0 = W.crater_count();
  const c2 = (() => { for (let i = 0; i < entCount; i++) if (E(i, F.owner) === 2 && E(i, F.kind) === K.Capitol) return i; })();
  const tx = E(c2, F.x) | 0, ty = E(c2, F.y) | 0;
  let ad = -1;
  // Spawn it for player 2 (debug_spawn places for whoever we view), and
  // watch everything so player 2's things are in the render buffers.
  W.set_view(2, 1);
  for (let r = 4; r < 12 && ad < 0; r++) for (let dy = -r; dy <= r && ad < 0; dy++) for (let dx = -r; dx <= r && ad < 0; dx++) {
    if (W.can_place(K.AirDefense, tx + dx, ty + dy)) ad = W.debug_spawn(K.AirDefense, tx + dx, ty + dy);
  }
  W.set_view(1, 1);
  readWorld();
  const adi = byId.get(ad), owner = adi != null ? E(adi, F.owner) : -1;
  W.debug_set_nuke(ids[0], 2); readWorld();
  aimSilo = [ids[0]]; amode = true; launchAt({ x: E(c2, F.x), y: E(c2, F.y) });
  const AT = W.nuke_numbers(5), FL = W.nuke_numbers(6), out = { owner, seen: false, burst: 0 };
  let t = 0;
  while (W.nuke_count() && t < 30 * 20) {
    W.tick(); t++; handleEvents(); readWorld(); updateNukes(performance.now(), 1);
    if (W.nuke_count() && W.nuke_info(0, 6) && R3.interceptors[0].visible) out.seen = true;
  }
  out.fb = R3.fireballs.length; out.ticks = t; out.craters = W.crater_count() - craters0; out.alive = ids.map(id => W.silo_state(id));
  out.burstY = R3.fireballs.length ? R3.fireballs[R3.fireballs.length - 1].y0 : null;
  out.ground = groundAt(E(c2, F.x), E(c2, F.y));
  return out;
}, silos);
console.log(shot);
check(shot.seen, "the air defense's missile is drawn while it climbs");
check(shot.craters === 0 && shot.ticks < 20 * 20, "the nuke is shot down before it lands (no crater)");
check(shot.fb > 0 && shot.burstY > shot.ground + 1, "and blows up in the air");

// Units: Disband is last, in the corner, after Attack-move and Stop.
const u = await pg.evaluate(() => { readWorld(); const c = findOwn(K.Capitol); const id = W.debug_spawn(K.Spearman, (E(c, F.x) | 0) + 3, (E(c, F.y) | 0) - 5); readWorld(); setSelection([id]); selKey = ""; renderSelection(true); }).then(layout);
console.log("unit", show(u));
const dis = u.btns[u.btns.length - 1];
check(dis.name === "Disband" && dis.col === u.cols - 1, "units: Disband last, in the last column");
check(await pg.evaluate(() => !!cmdKeys["⇧q"] && !!cmdKeys["delete"] && !!cmdKeys["z"] && !!cmdKeys["x"]), "unit keys still work: Shift+Q, Delete, Z, X");
check(!pg.errors.length, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
