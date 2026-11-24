// The Globe: the map is flat in the game (a cube's faces, cube.rs) and
// bent round a ball when drawn. Picking has to undo the bending: a spot's
// pixel picks that spot, near the camera and far round the ball, on every
// face and by the seams; the far side isn't picked at all; and the camera
// goes on over a seam onto the face beyond without moving on the ball.
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
    // (On water, the pointer picks the water's surface. Far off, the spot
    // may lie on another face: it's picked where it is on the ball.)
    const [x, y] = cubeResolve(hx + dx, hy + dy), p = worldToScreen(x, y, Math.max(hAt(x, y), WATER_Y)), g = screenToGround(p.x, p.y);
    out.trips.push(g ? Math.hypot(...cubeDelta(x, y, g.x, g.y)) : -1);
  }
  cam.dist = 300; placeCamera();
  // The far side: the point straight through the ball.
  const d = globeAt(hx, hy).map(v => -v), [ax, ay] = cubeAtDir(d);
  out.back = worldToScreen(ax, ay, 0).behind;
  out.space = screenToGround(2, 2);
  // Over the seam at the east end of strip A: the camera's spot is on a
  // face, at the same place on the ball, still looking the same way.
  cam.x = MW - 0.5; cam.y = 60.5; cam.yaw = 0.7; cam.dist = 40; clampCam(); placeCamera();
  const look = () => { globeAt(cam.x, cam.y); const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); return [GLOBE.up.slice(), GLOBE.east.map((v, i) => v * s + GLOBE.south[i] * c)]; };
  const [u0, l0] = look();
  cam.x += 1.0; clampCam();
  const [u1, l1] = look();
  out.onFace = cubeFaceOf(cam.x, cam.y) >= 0;
  out.moved = Math.hypot(u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2]) * GLOBE.R;
  out.turned = Math.acos(Math.min(1, l0[0] * l1[0] + l0[1] * l1[1] + l0[2] * l1[2])) * 180 / Math.PI;
  // An ordinary game after it is flat again.
  newGame(7, 0, 2, 0); running = false;
  out.flatAgain = !GLOBE.on && GLOBE.u.uGlobe.value.x === 0;
  return out;
});
check(r.on && r.size[0] === 480 && r.size[1] === 416, `the Globe's map is a cube's faces, bent round a ball (${r.size})`);
check(r.trips.every(d => d >= 0 && d < 0.6), `a spot's pixel picks that spot, near and far (off by ${r.trips.map(d => d.toFixed(2))} tiles)`);
check(r.back === true, "the far side of the ball counts as behind");
check(r.space === null, "a click on the sky picks nothing");
check(r.onFace && r.moved > 0.4 && r.moved < 1.6 && r.turned < 2, `over a seam the camera goes on, a tile on the ball (${r.moved.toFixed(2)}), looking the same way (${r.turned.toFixed(2)}°)`);
check(r.flatAgain, "the next ordinary game is flat again");
// The pointer picks what it's over, on every face, by seams and by a
// corner, on land and on the sea (the water's surface, not the seabed
// under it): a spot drawn on the screen is picked back within a tenth of a
// tile. (Picking straightens the ray at the ball where it hits, so on a
// mountainside seen low it's a few hundredths off.)
const picks = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = false; readWorld();
  let worst = 0, n = 0, at = null;
  for (const [cx, cy, dist, pitch] of [[80, 80, 60, 0.95], [240, 30, 24, 0.7], [400, 150, 24, 0.95], [90, 300, 24, 0.95], [250, 400, 24, 0.95], [470, 330, 120, 1.2], [478, 60, 24, 1.0], [250, 158, 24, 1.0], [3, 3, 40, 1.1]]) {
    cam.x = cx; cam.y = cy; cam.dist = dist; cam.pitch = pitch; cam.yaw = 0.3; placeCamera();
    for (let k = 0; k < 60; k++) {
      const [x, y] = cubeResolve(cam.x + (hash2(k, cy) - 0.5) * dist * 0.8, cam.y + (hash2(cy, k * 3) - 0.5) * dist * 0.5);
      const p = worldToScreen(x, y, Math.max(hAt(x, y), WATER_Y));
      if (p.behind || p.x < 0 || p.y < 0 || p.x > view._w || p.y > view._h) continue;
      const g = screenToGround(p.x, p.y);
      const e = g ? Math.hypot(...cubeDelta(x, y, g.x, g.y)) : 99;
      if (e > worst) { worst = e; at = [cx, cy, x.toFixed(1), y.toFixed(1), hAt(x, y).toFixed(2)]; }
      n++;
    }
  }
  return { worst, n, at };
});
check(picks.n > 300 && picks.worst < 0.1, `the pointer picks where it points (${picks.n} spots, worst ${picks.worst.toFixed(3)} tiles off, ${picks.at})`);
// A nuke flies the great circle, the shortest way round the ball: every
// point of its flight lies in the plane through the ball's middle, the silo
// and the target, and it lands where it was aimed, here 150 tiles off on
// another face.
const nuke = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = false;
  W.debug_set_era(5); readWorld();
  let hx = 0, hy = 0;
  for (let i = 0; i < entCount; i++) if (E(i, F.kind) === K.Capitol && E(i, F.owner) === ME) { hx = E(i, F.x); hy = E(i, F.y); }
  const id = W.debug_spawn(K.MissileSilo, (hx | 0) + 6, (hy | 0) + 6);
  W.debug_set_nuke(id, 2); readWorld();
  const sx = (hx | 0) + 7.5, sy = (hy | 0) + 7.5;
  // 150 tiles along the ground, past a seam.
  const [tx, ty] = cubeResolve(sx + 150, sy);
  aimSilo = [id]; amode = true; launchAt({ x: tx, y: ty });
  const a = globeAt(sx, sy).slice(), bb = globeAt(tx, ty).slice();
  const nrm = [a[1] * bb[2] - a[2] * bb[1], a[2] * bb[0] - a[0] * bb[2], a[0] * bb[1] - a[1] * bb[0]], nl = Math.hypot(...nrm);
  const out = { flew: 0, off: 0, finite: true, faces: new Set() };
  for (let t = 0; t < 30 * 20 && W.nuke_count(); t++) {
    W.tick(); handleEvents(); readWorld(); updateNukes(performance.now(), 1);
    if (!W.nuke_count()) break;
    const m = R3.nukeMesh[0].position;
    if (![m.x, m.y, m.z].every(Number.isFinite)) out.finite = false;
    const d = globeAt(m.x, m.z);
    out.off = Math.max(out.off, Math.abs(d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]) / nl * GLOBE.R);
    out.faces.add(cubeFaceOf(m.x, m.z));
    out.flew++;
  }
  out.faces = out.faces.size;
  return out;
});
check(nuke.flew > 100 && nuke.finite, `a nuke flies on the Globe (${nuke.flew} ticks)`);
check(nuke.off < 0.5 && nuke.faces >= 2, `on the great circle, over ${nuke.faces} faces (${nuke.off.toFixed(2)} tiles off it at most)`);
// The ground meets itself at every seam: a corner on a seam, drawn once by
// each face, has the same height and the same light (normal, turned into
// the other face's frame) both times.
const twins = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = false; readWorld();
  const cw = MW + 1, h = R3.heights, nor = R3.terrainGeo.attributes.normal;
  let n = 0, dh = 0, dn = 0;
  for (let f = 0; f < 6; f++) for (let side = 0; side < 4; side++) {
    const m = CUBE_SEAMS[f][side], F = CUBE_FACES[f];
    if (!m) continue;
    for (let a = 1; a < CUBE_N; a++) {
      const [s, t] = [[0, a], [CUBE_N, a], [a, 0], [a, CUBE_N]][side], x = F.at[0] + s, y = F.at[1] + t;
      const [qx, qy] = cubeTurn(m.k, x, y), tx = qx + m.tx, ty = qy + m.ty, i = y * cw + x, j = ty * cw + tx;
      dh = Math.max(dh, Math.abs(h[i] - h[j]));
      const [ex, ez] = cubeTurn(m.k, nor.getX(i), nor.getZ(i));
      dn = Math.max(dn, Math.hypot(ex - nor.getX(j), nor.getY(i) - nor.getY(j), ez - nor.getZ(j)));
      n++;
    }
  }
  return { n, dh, dn };
});
check(twins.n > 1000 && twins.dh < 1e-6 && twins.dn < 1e-4, `the ground meets itself at the seams: same height and light (${twins.n} corners, ${twins.dh.toExponential(1)} high, ${twins.dn.toExponential(1)} light)`);
// Holding W zoomed far out on a slow computer (big steps): the camera
// crosses seams without the view spinning round. (One long step landed far
// past a seam and turned the view 147°; now at most the ball's own curve
// over the step.)
const spin = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = true; paused = true; readWorld();
  const look = () => { globeAt(cam.x, cam.y); const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); return GLOBE.east.map((v, i) => v * s + GLOBE.south[i] * c); };
  cam.x = 454.5; cam.y = 44.5; cam.yaw = 0; cam.pitch = 1.0; cam.dist = 400; clampCam(); placeCamera();
  keys.clear(); keys.add("KeyW");
  let worst = 0;
  for (let f = 0; f < 600; f++) {
    const l0 = look(); scrollCamera(1 / 8); const l1 = look();
    worst = Math.max(worst, Math.acos(Math.min(1, l0[0] * l1[0] + l0[1] * l1[1] + l0[2] * l1[2])) * 180 / Math.PI);
  }
  keys.clear(); running = false;
  return worst;
});
check(spin < 45, `scrolling over seams in big steps doesn't spin the view (${spin.toFixed(1)}° at most)`);
// Nor across the edges between faces inside a strip: their grids meet at
// an angle too, up to 57° by a corner, and the view snapped round by that
// much there (playtest). Each frame, the camera's facing on the ball turns
// a fraction of a degree at most.
const edges = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = true; paused = true; readWorld();
  const look = () => { globeAt(cam.x, cam.y); const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); return GLOBE.east.map((v, i) => v * s + GLOBE.south[i] * c); };
  let worst = 0;
  for (const [x, y, yaw] of [[150, 4, -Math.PI / 2], [310, 155, -Math.PI / 2], [170, 262, Math.PI / 2]]) {
    cam.x = x; cam.y = y; cam.yaw = yaw; cam.pitch = 0.95; cam.dist = 24; clampCam(); placeCamera();
    keys.clear(); keys.add("KeyW");
    for (let f = 0; f < 300; f++) {
      const l0 = look(); scrollCamera(1 / 60); const l1 = look();
      worst = Math.max(worst, Math.acos(Math.min(1, l0[0] * l1[0] + l0[1] * l1[1] + l0[2] * l1[2])) * 180 / Math.PI);
    }
  }
  keys.clear(); running = false;
  return worst;
});
check(edges < 2, `scrolling across the edges between faces by a corner doesn't turn the view (${edges.toFixed(2)}° a frame at most)`);
// The minimap is a world map: a town is drawn where it is in the world
// (Stockholm-ish towns north, Sydney's south), and a click there brings
// the camera back to it.
const mm = await pg.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = false; readWorld();
  const out = { on: WorldMap.on, trips: [], order: [] };
  for (const [x, y] of [[100.5, 50.5], [300.5, 140.5], [470.5, 300.5], [20.5, 400.5]]) {
    const [mx, my] = WorldMap.of(x, y), [bx, by] = WorldMap.toMap(mx, my);
    out.trips.push(Math.hypot(...cubeDelta(x, y, bx, by)));
  }
  // North is up: the North Pole's pixel row is the top of the map.
  out.northUp = WorldMap.of(...WorldMap.toMap(75, WorldMap.y0 + 1))[1] < WorldMap.y0 + 3;
  drawMinimap();
  return out;
});
check(mm.on && mm.northUp && mm.trips.every(d => d < 0.5), `the minimap is a world map, north up, and a click comes back where it was (${mm.trips.map(d => d.toFixed(2))} tiles)`);
check(pg.errors.length === 0, "no page errors" + (pg.errors.length ? ": " + pg.errors.slice(0, 2).join(" / ") : ""));
// Lakes have water in them, drawn (a stale test once threw away every
// drop of water on the Globe, and its lakes stood empty, dry sand): looking
// straight down on the middle of the lake nearest the start, it's blue.
const pd = await open(b, "", { draw: true, w: 400, h: 300 });
const px = await pd.evaluate(() => {
  newGame(3, 0, 2, 4); $("startScreen").hidden = true; running = true; paused = true; W.set_view(ME, 1); readWorld();
  const ter = u8(W.terrain_ptr(), MW * MH);
  let hx = 0, hy = 0;
  for (let i = 0; i < entCount; i++) if (E(i, F.kind) === K.Capitol && E(i, F.owner) === ME) { hx = E(i, F.x); hy = E(i, F.y); }
  // A lake tile with lake all round it.
  let best = null, bd = 1e9;
  for (let y = 2; y < MH - 2; y++) for (let x = 2; x < MW - 2; x++) {
    if (ter[y * MW + x] !== 5 || ![-1, 0, 1].every(dy => [-1, 0, 1].every(dx => ter[(y + dy) * MW + x + dx] === 5))) continue;
    const d = Math.hypot(...cubeDelta(hx, hy, x, y));
    if (d < bd) { bd = d; best = [x + 0.5, y + 0.5]; }
  }
  cam.x = best[0]; cam.y = best[1]; cam.dist = 12; cam.pitch = 1.35; cam.yaw = 0; placeCamera();
  // (Read in the frame it's drawn, from the game's own loop.)
  const cv = R3.renderer.domElement, sm = document.createElement("canvas"); sm.width = sm.height = 1;
  // (Read right after the game's own drawing, in the same task: by the
  // next frame the canvas is cleared.)
  const real = window.render3d;
  return new Promise(r => {
    let n = 0;
    window.render3d = (...a) => {
      const out = real(...a);
      if (++n === 3) { window.render3d = real; sm.getContext("2d").drawImage(cv, cv.width / 2, cv.height / 2, 1, 1, 0, 0, 1, 1); r(Array.from(sm.getContext("2d").getImageData(0, 0, 1, 1).data.slice(0, 3))); }
      return out;
    };
  });
});
check(px[2] > px[0] + 30 && px[2] > px[1] - 10, `a lake on the Globe has water in it (the middle is ${px})`);
check(pd.errors.length === 0, "no page errors drawing" + (pd.errors.length ? ": " + pd.errors.slice(0, 2).join(" / ") : ""));
await b.close();
process.exit(failed() ? 1 : 0);
