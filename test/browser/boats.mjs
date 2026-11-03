// Boats in the page: a dock trains them, they sail, a transport takes
// soldiers aboard and the right-click cursor says so. With SHOT=path, also
// saves a picture of the harbour full of boats.
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const shot = process.env.SHOT;
const page = await open(b, "", { draw: !!shot, w: 1100, h: 700 });
const r = await page.evaluate(() => {
  newGame(4, 0, 2); running = true; paused = true; Rec.real = true;
  W.set_view(1, 1); W.debug_set_era(5); readWorld();
  // The harbour: the water nearest our Capitol.
  const w = W.map_w(), h = W.map_h(), ter = new Uint8Array(mem.buffer, W.terrain_ptr(), w * h);
  let cap = -1;
  for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === K.Capitol) cap = i;
  const cx = E(cap, F.x), cy = E(cap, F.y);
  let best = null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (ter[y * w + x] !== 1) continue;
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (!best || d < best[0]) best = [d, x, y];
  }
  const [, hx, hy] = best;
  const wet = (x, y) => x >= 0 && y >= 0 && x < w && y < h && ter[y * w + x] === 1;
  const ids = {};
  // Boats on the water round the harbour.
  const kinds = [K.FishingBoat, K.Transport, K.Galley, K.Cog, K.Galleon, K.Ironclad, K.Destroyer, K.Submarine, K.NuclearSub, K.Carrier];
  let n = 0;
  for (let r = 0; r < 8 && n < kinds.length; r++) for (let dy = -r; dy <= r && n < kinds.length; dy++) for (let dx = -r; dx <= r && n < kinds.length; dx++) {
    const x = hx + dx * 2, y = hy + dy * 2;
    if (Math.max(Math.abs(dx), Math.abs(dy)) === r && wet(x, y) && wet(x + 1, y) && wet(x, y + 1)) ids[kinds[n]] = W.debug_spawn(kinds[n++], x, y);
  }
  // Land next to the transport, and soldiers there.
  const t = ids[K.Transport];
  readWorld();
  const ti = byId.get(t), tx = E(ti, F.x), ty = E(ti, F.y);
  let shore = null;
  for (let r = 1; r < 8 && !shore; r++) for (let dy = -r; dy <= r && !shore; dy++) for (let dx = -r; dx <= r && !shore; dx++) {
    const x = Math.floor(tx) + dx, y = Math.floor(ty) + dy;
    if (x >= 0 && y >= 0 && x < w && y < h && ter[y * w + x] !== 1 && ter[y * w + x] !== 4) shore = [x, y];
  }
  const men = [0, 1].map(k => W.debug_spawn(K.Swordsman, shore[0], shore[1]));
  readWorld();
  const cursorBoard = intentAt(men, tx, ty);
  issue({ c: 1, ids: men, x: tx, y: ty });
  for (let k = 0; k < 20 * 15; k++) W.tick();
  readWorld();
  const visibleMen = men.filter(id => byId.has(id)).length;
  const aboard = (() => { const i = byId.get(t); return i == null ? -1 : E(i, F.residents); })();
  const cursorUnload = intentAt([t], cx, cy);
  // A nuclear submarine: Launch (C) and Arm a nuke (V) among its buttons.
  const ns = W.debug_spawn(K.NuclearSub, hx, hy);
  readWorld(); setSelection([ns]); renderSelection(true);
  const buttons = [...document.querySelectorAll("#cmd .cbtn")].map(b => b.textContent);
  const subButtons = buttons.filter(t => t === "🚀C" || t === "☢V").length;
  const subArm = issue({ c: 11, ids: [ns] }); // away from any dock: refused
  // An aircraft's panel: its fuel and its ammunition.
  const fighter = W.debug_spawn(K.Fighter, hx, hy);
  readWorld(); setSelection([fighter]); renderSelection(true);
  const panel = document.querySelector(".info")?.textContent || "";
  centerOn(hx, hy); cam.dist = 18;
  return { panel, subButtons, subArm, buttons: buttons.join("|"), n, cursorBoard, visibleMen, aboard, cursorUnload, trains: TRAINS[K.Dock].length, name: NAMES[K.Galleon] };
});
check(r.n === 10, `ten kinds of boat on the water (${r.n})`);
check(r.cursorBoard === 7, `right-clicking a transport with soldiers means board (${r.cursorBoard})`);
check(r.visibleMen === 0 && r.aboard === 2, `the soldiers went aboard and aren't drawn (${r.visibleMen} drawn, ${r.aboard} aboard)`);
check(r.cursorUnload === 8, `right-clicking land with a loaded transport means put ashore (${r.cursorUnload})`);
check(r.trains === 10 && r.name === "Galleon", `the dock trains ten boats (${r.trains})`);
check(r.subButtons === 2, `a nuclear submarine has Launch and Arm buttons (${r.buttons})`);
check(/Fuel \d+ of 45/.test(r.panel) && /Ammunition 12 of 12/.test(r.panel), `a fighter shows its fuel and ammunition (${r.panel})`);
check(r.subArm !== 0, `arming away from a dock is refused (${r.subArm})`);
if (shot) {
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => {
    document.getElementById("boot")?.remove();
    for (const el of document.querySelectorAll("#menu, #lobby, #start, .overlay")) el.hidden = true;
    readWorld(); for (let k = 0; k < 3; k++) render3d(1, performance.now() + k * 16, 0.016);
  });
  if (process.env.SHOT2) {
    // Low over open sea, looking towards the sun: reflections and glint.
    const cdp2 = await page.context().newCDPSession(page);
    await page.evaluate(() => { const w = W.map_w(); cam.x = w * 0.5; cam.y = 4; cam.dist = 22; cam.pitch = 0.42; cam.yaw = 2.4; clampCam(); readWorld(); for (let k = 0; k < 3; k++) render3d(1, performance.now() + k * 16, 0.016); });
    const { data } = await cdp2.send("Page.captureScreenshot", { format: "png" });
    (await import("fs")).writeFileSync(process.env.SHOT2, Buffer.from(data, "base64"));
    await page.evaluate(() => { centerOn(W.map_w() * 0.2, W.map_h() * 0.8); cam.pitch = 0.95; cam.yaw = 0; cam.dist = 18; readWorld(); render3d(1, performance.now(), 0.016); });
  }
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  (await import("fs")).writeFileSync(shot, Buffer.from(data, "base64"));
}
check(page.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
