// The map picker on the start screen: "Surprise me" plays a new random map
// unseen; "Pick one" shows a preview of the numbered map, and that map is
// the one played.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "", { draw: !!process.env.SHOT });
await sleep(300);
const st = () => pg.evaluate(() => ({ mode: $("mapMode").value, preview: !$("mapPreview").hidden, ctl: !$("mapPickCtl").hidden, w: $("mapPreview").width }));
await pg.evaluate(() => { try { localStorage.removeItem("vibecraft.map"); } catch {} mapMode = "surprise"; renderLobby(); });
let s = await st();
check(s.mode === "surprise" && !s.preview && !s.ctl, "Surprise me: no preview, no number");
await pg.selectOption("#mapMode", "pick");
await pg.fill("#mapSeed", "4242");
await sleep(100);
s = await st();
check(s.preview && s.ctl && s.w >= 120, `Pick one: a preview (${s.w} px)`);
// The preview really shows a map: water round the edge, land in the middle.
const px = await pg.evaluate(() => { const c = $("mapPreview"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, w = c.width; const at = (x, y) => [...d.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)]; let land = 0; for (let i = 0; i < w * w; i++) if (d[i * 4 + 1] > d[i * 4 + 2]) land++; return { edge: at(1, 1), land: land / (w * w) }; });
console.log(px);
check(px.edge[2] > px.edge[1] && px.edge[2] > px.edge[0], "sea at the edge");
check(px.land > 0.25, `land on the map (${Math.round(px.land * 100)}%)`);
// Another changes the number and the picture.
const before = await pg.evaluate(() => $("mapPreview").toDataURL());
await pg.click("#mapAnother");
const after = await pg.evaluate(() => ({ url: $("mapPreview").toDataURL(), seed: +$("mapSeed").value }));
check(after.url !== before && after.seed !== 4242, `Another: map ${after.seed}`);
await pg.fill("#mapSeed", "4242");
await sleep(100);
// It's remembered, and Begin plays that map.
check(await pg.evaluate(() => JSON.parse(localStorage.getItem("vibecraft.map")).seed === 4242), "the choice is remembered");
if (process.env.SHOT) {
  const cdp = await pg.context().newCDPSession(pg);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  (await import("fs")).writeFileSync(process.env.SHOT, Buffer.from(data, "base64"));
}
await pg.click("#startBtn");
await sleep(500);
check(await pg.evaluate(() => W.game_seed()) === 4242, "Begin plays the picked map");
// Surprise again: a different map each time.
await pg.evaluate(() => { mapMode = "surprise"; });
const seeds = await pg.evaluate(() => [chosenSeed(), chosenSeed(), chosenSeed()]);
check(new Set(seeds).size === 3, "Surprise me: a new map each game");
check(pg.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
