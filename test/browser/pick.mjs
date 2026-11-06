// Pointing at the ground (screenToGround, pickAt) walks the height grid
// instead of testing every triangle of the terrain: it must land where the
// mesh says, and cost about the same on every map size.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: true });
await sleep(300);
for (const mode of ["skirmish", "frontier", "frontier-large"]) {
  const r = await pg.evaluate(async m => {
    newGame(7, 0, 2, ["skirmish", "frontier", "frontier-large"].indexOf(m)); running = true;
    await new Promise(r => setTimeout(r, 1500));
    const out = { map: MW, worst: 0, n: 0, missed: 0 };
    // From several camera spots, angles and zooms, across the screen.
    for (let k = 0; k < 8; k++) {
      cam.x = MW * (0.2 + 0.08 * k); cam.y = MH * (0.75 - 0.07 * k); cam.yaw = k * 0.8; cam.pitch = 0.6 + 0.05 * k; cam.dist = 14 + k * 6;
      placeCamera();
      for (let i = 0; i < 25; i++) {
        const sx = view._w * ((i % 5) + 0.5) / 5, sy = view._h * (Math.floor(i / 5) + 0.5) / 5;
        R3.raycaster.setFromCamera(ndc(sx, sy), R3.camera);
        const mesh = R3.raycaster.intersectObject(R3.terrain, false)[0];
        const w = screenToGround(sx, sy);
        if (!mesh) continue;
        out.n++;
        if (!w) { out.missed++; continue; }
        out.worst = Math.max(out.worst, Math.hypot(w.x - mesh.point.x, w.y - mesh.point.z));
      }
    }
    const t = (f, n = 50) => { const a = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - a) / n; };
    cam.x = MW / 2; cam.y = MH / 2; cam.dist = 24; cam.pitch = 0.95; placeCamera();
    out.ms = t(() => screenToGround(view._w * 0.5, view._h * 0.3));
    out.pickMs = t(() => pickAt(view._w * 0.5, view._h * 0.3));
    return out;
  }, mode);
  console.log(mode, JSON.stringify(r));
  check(r.n > 100 && r.missed === 0 && r.worst < 0.35, `${mode}: lands where the terrain mesh says (worst ${r.worst.toFixed(2)} tiles over ${r.n} points)`);
  check(r.ms < 1.5, `${mode}: a ground point takes ${r.ms.toFixed(2)} ms, pickAt ${r.pickMs.toFixed(2)} ms`);
}
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
