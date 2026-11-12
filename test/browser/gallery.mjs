// A contact sheet of every model, for reviewing them side by side:
//   node serve.cjs ../../dist/vibecraft.html &   then   node gallery.mjs <out-dir> [simple]
// Writes units.png, boats.png, buildings.png and resources.png: each model
// drawn by the game's own icon renderer, large, with its name. "simple"
// draws the models built in code (the Models setting on Simple) instead.
import { browser, open } from "./lib.mjs";
import fs from "fs";
const out = process.argv[2] || ".", simple = process.argv[3] === "simple";
const b = await browser();
const pg = await open(b);
const sheets = await pg.evaluate(async (simple) => {
  newGame(1, 0, 2);
  if (simple) { setGfx("models", "simple"); applyModels(); }
  const PX = 360, CELL = 240, LABEL = 22;
  const ir = iconRenderer(); ir.renderer.setSize(PX, PX, false);
  // A deposit's model isn't a kind: draw it the way icon() draws a building.
  const resIcon = geo => {
    const { renderer, scene, cam, mat } = ir;
    const g = new THREE.Group(); g.add(new THREE.Mesh(geo, mat)); g.rotation.y = -0.6; scene.add(g);
    const bb = new THREE.Box3().setFromObject(g), c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z) * 0.7 / Math.tan((cam.fov * Math.PI) / 360);
    cam.position.set(c.x, c.y + dist * 0.55, c.z + dist * 0.85); cam.lookAt(c);
    renderer.render(scene, cam); scene.remove(g);
    const cv = document.createElement("canvas"); cv.width = cv.height = PX;
    cv.getContext("2d").drawImage(renderer.domElement, 0, 0, PX, PX);
    return cv;
  };
  const sheet = (items, cols) => {
    const rows = Math.ceil(items.length / cols);
    const cv = document.createElement("canvas"); cv.width = cols * CELL; cv.height = rows * (CELL + LABEL);
    const c = cv.getContext("2d");
    c.fillStyle = "#6f8f58"; c.fillRect(0, 0, cv.width, cv.height);
    c.font = "15px sans-serif"; c.textAlign = "center";
    items.forEach(([name, img], i) => {
      const x = (i % cols) * CELL, y = Math.floor(i / cols) * (CELL + LABEL);
      c.drawImage(img, x, y, CELL, CELL);
      c.fillStyle = "#10180c"; c.fillText(name, x + CELL / 2, y + CELL + 15);
    });
    return cv.toDataURL("image/png");
  };
  const kinds = Object.entries(K).sort((a, b) => a[1] - b[1]);
  const of = f => kinds.filter(([, k]) => f(k)).map(([n, k]) => [NAMES[k] || n, icon(k, 1, PX / 2)]);
  return {
    units: sheet(of(k => !isBld(k) && !isNaval(k)), 7),
    boats: sheet(of(isNaval), 5),
    buildings: sheet(of(isBld), 8),
    resources: sheet(Object.entries(R3.resGeo).map(([n, g]) => [n, resIcon(g)]), 8),
  };
}, simple);
for (const [name, url] of Object.entries(sheets)) fs.writeFileSync(`${out}/${name}.png`, Buffer.from(url.split(",")[1], "base64"));
console.log("wrote", Object.keys(sheets).join(", "), "to", out, pg.errors.length ? pg.errors : "");
await b.close();
