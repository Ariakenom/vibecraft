// Demolish (and Disband) sit in the bottom-right corner of the command
// buttons, so they never slide into the place of a button that just went
// away: clicking a silo's "Arm a nuke" used to put Demolish under the mouse.
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const pg = await open(b);
await pg.evaluate(() => { newGame(7, 0, 2); running = false; Rec.real = true; $("startScreen").hidden = true; });
// Where each button is, as [column, row] within the command grid.
const layout = () => pg.evaluate(() => {
  const box = $("cmd"), r0 = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const tracks = cs.gridTemplateColumns.split(" ").map(parseFloat), gap = parseFloat(cs.columnGap) || 0;
  const starts = tracks.map((_, n) => tracks.slice(0, n).reduce((a, t) => a + t + gap, 0));
  const btns = [...box.querySelectorAll(".cbtn")].map(e => { const r = e.getBoundingClientRect(), x = r.left - r0.left;
    return { name: e.getAttribute("aria-label"), x, y: r.top - r0.top, col: starts.findIndex(s => Math.abs(s - x) < 2) }; });
  return { cols: tracks.length, btns };
});
const silo = await pg.evaluate(() => {
  W.debug_set_era(5); readWorld();
  const c = findOwn(K.Capitol), id = W.debug_spawn(K.MissileSilo, (E(c, F.x) | 0) + 8, (E(c, F.y) | 0) + 8);
  readWorld(); return id;
});
const spots = [];
for (const [st, label] of [[0, "empty"], [1, "arming"], [2, "armed"]]) {
  const l = await pg.evaluate(([id, st]) => { W.debug_set_nuke(id, st); readWorld(); setSelection([id]); selKey = ""; renderSelection(true); }, [silo, st]).then(layout);
  const d = l.btns.find(e => e.name === "Demolish");
  console.log(label, l.btns.map(e => `${e.name}@${e.col}`).join(", "));
  check(d && d.col === l.cols - 1, `silo ${label}: Demolish in the last column`);
  spots.push(d && `${d.x},${d.y}`);
}
check(spots.every(s => s === spots[0]), "Demolish doesn't move as the silo arms and becomes armed");
// Units: Disband is still last, after Attack-move and Stop, in the corner.
const u = await pg.evaluate(() => { readWorld(); const c = findOwn(K.Capitol); const id = W.debug_spawn(K.Spearman, (E(c, F.x) | 0) + 3, (E(c, F.y) | 0) - 5); readWorld(); setSelection([id]); selKey = ""; renderSelection(true); }).then(layout);
console.log("unit", u.btns.map(e => `${e.name}@${e.col}`).join(", "));
const dis = u.btns[u.btns.length - 1];
check(dis.name === "Disband" && dis.col === u.cols - 1, "units: Disband last, in the last column");
check(await pg.evaluate(() => !!cmdKeys["⇧q"] && !!cmdKeys["delete"] && !!cmdKeys["z"] && !!cmdKeys["x"]), "keys still work: Shift+Q, Delete, Z, X");
check(!pg.errors.length, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
