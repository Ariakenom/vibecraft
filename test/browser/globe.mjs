// The Globe: the map is flat in the game and wrapped round a ball when
// drawn. Picking has to undo the wrapping: a spot's pixel picks that spot,
// near the camera and far round the ball; the far side isn't picked at all;
// and the camera goes round the world instead of stopping at an edge.
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const pg = await open(b);
const r = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = false;
  readWorld();
  let hx = 0, hy = 0;
  for (let i = 0; i < entCount; i++) if (E(i, F.kind) === K.Capitol && E(i, F.owner) === ME) { hx = E(i, F.x); hy = E(i, F.y); }
  const out = { on: GLOBE.on, size: [MW, MH], trips: [] };
  for (const [dist, dx, dy] of [[26, 0, 0], [26, 7, -5], [120, 30, 20], [300, -70, 40]]) {
    cam.x = hx; cam.y = hy; cam.dist = dist; cam.pitch = 1.0; cam.yaw = 0.4;
    placeCamera();
    // (Water is level, so the spot's height doesn't come into it.)
    const x = hx + dx, y = hy + dy, p = worldToScreen(x, y, hAt(x, y)), g = screenToGround(p.x, p.y);
    out.trips.push(g ? Math.hypot(g.x - x, g.y - y) : -1);
  }
  cam.dist = 300; placeCamera();
  out.back = worldToScreen((hx + MW / 2) % MW, hy, 0).behind;
  out.space = screenToGround(2, 2);
  cam.x = MW + 5; clampCam(); out.wrapped = cam.x;
  // An ordinary game after it is flat again.
  newGame(7, 0, 2, 0); running = false;
  out.flatAgain = !GLOBE.on && GLOBE.u.uGlobe.value.x === 0;
  return out;
});
check(r.on && r.size[0] === 640, `the Globe's map is wrapped round a ball (${r.size})`);
check(r.trips.every(d => d >= 0 && d < 0.6), `a spot's pixel picks that spot, near and far (off by ${r.trips.map(d => d.toFixed(2))} tiles)`);
check(r.back === true, "the far side of the ball counts as behind");
check(r.space === null, "a click on the sky picks nothing");
check(Math.abs(r.wrapped - 5) < 1e-6, "the camera goes on round the world past the edge");
check(r.flatAgain, "the next ordinary game is flat again");
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
