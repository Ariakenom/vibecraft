// Close-ups of a few models from two sides, for working on them:
//   node closeup.mjs <out.png> <Name,Name,...> [simple]
// A name is a kind (Horseman, Bakery) or a deposit's model (horse, deer, pine).
import { browser, open } from "./lib.mjs";
import fs from "fs";
const [out, names, mode] = process.argv.slice(2);
const b = await browser();
const pg = await open(b);
const url = await pg.evaluate(async ({ names, simple }) => {
  newGame(1, 0, 2);
  if (simple) { setGfx("models", "simple"); applyModels(); }
  const PX = 520;
  const ir = iconRenderer(); ir.renderer.setSize(PX, PX, false);
  const shot = (name, turn) => {
    const { renderer, scene, cam, mat } = ir;
    const g = new THREE.Group();
    const bld = name in K ? isBld(K[name]) : true;
    if (name in K) {
      const mdl = cachedModel(K[name], 1);
      g.add(new THREE.Mesh(mdl.body, mat));
      if (mdl.tool) { const t = new THREE.Mesh(mdl.tool, mat); t.position.set(...(mdl.rig ? mdl.rig.toolAt : mdl.pivot)); g.add(t); }
    } else g.add(new THREE.Mesh(R3.resGeo[name], mat));
    g.rotation.y = turn; scene.add(g);
    const bb = new THREE.Box3().setFromObject(g);
    if (bld) bb.min.y = Math.max(bb.min.y, 0);
    const c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z) * 0.68 / Math.tan((cam.fov * Math.PI) / 360);
    cam.position.set(c.x, c.y + dist * 0.45, c.z + dist * 0.9); cam.lookAt(c);
    renderer.render(scene, cam); scene.remove(g);
    const cv = document.createElement("canvas"); cv.width = cv.height = PX;
    cv.getContext("2d").drawImage(renderer.domElement, 0, 0, PX, PX);
    return cv;
  };
  const cv = document.createElement("canvas"); cv.width = names.length * PX; cv.height = PX * 2;
  const c = cv.getContext("2d"); c.fillStyle = "#6f8f58"; c.fillRect(0, 0, cv.width, cv.height);
  names.forEach((n, i) => { c.drawImage(shot(n, -0.35), i * PX, 0); c.drawImage(shot(n, 2.4), i * PX, PX); });
  return cv.toDataURL("image/png");
}, { names: names.split(","), simple: mode === "simple" });
fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
console.log("wrote", out, pg.errors.length ? pg.errors : "");
await b.close();
