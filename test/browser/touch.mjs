// Phones: one finger drags the map, two pinch to zoom and twist to turn,
// and lifting the fingers after a pinch isn't taken for a tap.
// Also the menu's Reveal map switch (single player).
import { chromium } from "playwright";
import fs from "fs";
import { URL0, check, failed, sleep } from "./lib.mjs";
const THREE = fs.readFileSync(process.env.THREE_JS || new URL("./three.min.js", import.meta.url));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await b.newContext({ viewport: { width: 1000, height: 700 }, hasTouch: true });
const pg = await ctx.newPage();
const errors = [];
pg.on("pageerror", e => { errors.push(String(e)); console.log("PAGE ERROR", e.message); });
await pg.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ body: THREE, contentType: "text/javascript" }));
await pg.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "", contentType: "text/css" }));
await pg.goto(URL0);
await pg.waitForFunction(() => typeof W !== "undefined" && typeof R3 !== "undefined" && R3.renderer);
await pg.evaluate(() => { window.render3d = () => {}; newGame(7, 0, 2); running = true; paused = true; $("startScreen").hidden = true; });
await sleep(500);
const cdp = await ctx.newCDPSession(pg);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
// Fingers move in steps, as real ones do.
async function gesture(from, to, steps = 8) {
  await touch("touchStart", from);
  for (let s = 1; s <= steps; s++) await touch("touchMove", from.map((p, i) => [p[0] + (to[i][0] - p[0]) * s / steps, p[1] + (to[i][1] - p[1]) * s / steps]));
  await touch("touchEnd", []);
  await sleep(50);
}
const camNow = () => pg.evaluate(() => ({ x: cam.x, y: cam.y, yaw: cam.yaw, dist: cam.dist, sel: selection().length }));
const reset = () => pg.evaluate(() => { cam.x = MW / 2; cam.y = MH / 2; cam.yaw = 0; cam.dist = 24; W.clear_selection(); readWorld(); placeCamera(); });
const ground = (x, y) => pg.evaluate(([x, y]) => { placeCamera(); const r = view.getBoundingClientRect(); return screenToGround(x - r.left, y - r.top); }, [x, y]);

// Pinch apart: twice as far apart, half the distance (zoomed in).
await reset();
let before = await camNow();
const mid0 = await ground(500, 350);
await gesture([[420, 350], [580, 350]], [[340, 350], [660, 350]]);
let after = await camNow();
check(Math.abs(after.dist - before.dist / 2) < 0.5, `pinch apart zooms in (${before.dist.toFixed(1)} → ${after.dist.toFixed(1)})`);
check(Math.abs(after.yaw - before.yaw) < 0.01, "a straight pinch doesn't turn the view");
const mid1 = await ground(500, 350);
check(Math.hypot(mid1.x - mid0.x, mid1.y - mid0.y) < 0.5, "the ground between the fingers stays put");
check(after.sel === 0, "lifting both fingers isn't a tap");
// Pinch together: zoomed out.
await gesture([[340, 350], [660, 350]], [[420, 350], [580, 350]]);
check(Math.abs((await camNow()).dist - before.dist) < 0.5, "pinch together zooms back out");

// Twist: the ground under a finger should follow it round.
await reset();
const r = 120, c = [500, 350], ang = 0.5;
const at = a => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
const g0 = await ground(...at(0));
await gesture([at(0), at(Math.PI)], [at(ang), at(Math.PI + ang)]);
after = await camNow();
check(Math.abs(Math.abs(after.yaw) - ang) < 0.05, `a twist turns the view (${after.yaw.toFixed(2)})`);
const gA = await ground(...at(ang));
const follow = Math.hypot(gA.x - g0.x, gA.y - g0.y);
await pg.evaluate(y => { cam.yaw = -y; }, after.yaw);
const gB = await ground(...at(ang));
const reverse = Math.hypot(gB.x - g0.x, gB.y - g0.y);
check(follow < reverse && follow < 1, `the ground follows the finger round (${follow.toFixed(2)} tiles off, the other way ${reverse.toFixed(2)})`);

// One finger still drags, and after a pinch the remaining finger drags on.
await reset();
before = await camNow();
await gesture([[500, 350]], [[500, 250]]);
after = await camNow();
check(Math.hypot(after.x - before.x, after.y - before.y) > 1, "one finger drags the map");
await reset();
await touch("touchStart", [[420, 350], [580, 350]]);
await touch("touchMove", [[400, 350], [600, 350]]);
await touch("touchEnd", [[400, 350]].map(p => p)); // (CDP: lists the fingers still down)
before = await camNow();
for (let s = 1; s <= 5; s++) await touch("touchMove", [[400, 350 - s * 20]]);
await touch("touchEnd", []);
await sleep(50);
after = await camNow();
check(Math.hypot(after.x - before.x, after.y - before.y) > 1 && after.sel === 0, "the finger left after a pinch drags on, no tap");
// A tap still selects or commands (tap on empty ground: nothing breaks).
await touch("touchStart", [[500, 350]]); await touch("touchEnd", []);

// Reveal map, in the menu next to Cheat mode.
await pg.evaluate(() => { $("menuBtn").click(); });
const vis = await pg.evaluate(() => !$("revealBtn").hidden && $("revealBtn").parentElement === $("cheatBtn").parentElement);
check(vis, "Reveal map sits next to Cheat mode in single player");
const w0 = await pg.evaluate(() => $("revealBtn").getBoundingClientRect().width);
await pg.evaluate(() => $("revealBtn").click());
const on = await pg.evaluate(() => ({ r: W.view_reveal(), w: $("revealBtn").getBoundingClientRect().width, label: $("revealBtn").querySelector(".on").textContent }));
check(on.r === 1 && on.label === "Reveal map: on", "Reveal map lifts the fog");
check(Math.abs(on.w - w0) < 0.5, "the button keeps its width");
const sum0 = await pg.evaluate(() => W.checksum());
await pg.evaluate(() => $("revealBtn").click());
check(await pg.evaluate(() => W.view_reveal() === 0 && W.local_player() === 1), "and turns it back off");
check(await pg.evaluate(() => W.checksum()) === sum0, "the game itself is unchanged");
await pg.evaluate(() => { $("menuScreen").hidden = true; mp = { server: null }; $("menuBtn").click(); });
check(await pg.evaluate(() => { const h = $("revealBtn").hidden; mp = null; return h; }), "hidden online");
check(errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
