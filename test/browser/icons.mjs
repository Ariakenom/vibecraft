// The HUD's icons (build buttons, portraits) are drawn by a small renderer of
// their own. On the Globe every material bends round the ball where the main
// camera looks, unless it's kept flat: the icons' material must be, or every
// icon comes out empty.
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const pg = await open(b);
const r = await pg.evaluate(() => {
  const seen = cv => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
  const out = {};
  for (const [name, mode] of [["flat", 0], ["globe", 4]]) {
    newGame(3, 0, 2, mode); $("startScreen").hidden = true; running = false; readWorld();
    let hx = 0, hy = 0;
    for (let i = 0; i < entCount; i++) if (E(i, F.kind) === K.Capitol && E(i, F.owner) === ME) { hx = E(i, F.x); hy = E(i, F.y); }
    cam.x = hx; cam.y = hy; placeCamera();
    out[name] = { on: GLOBE.on, px: [K.Capitol, K.Hut, K.LumberCamp, K.Worker].map(k => seen(iconEl(k, ME, 48))) };
  }
  return out;
});
check(!r.flat.on && r.flat.px.every(n => n > 300), `icons drawn on a flat map (${r.flat.px})`);
check(r.globe.on && r.globe.px.every(n => n > 300), `icons drawn on the Globe (${r.globe.px})`);
await b.close();
process.exit(failed() ? 1 : 0);
