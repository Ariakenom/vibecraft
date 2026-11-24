// The World and the Globe online: a friend gets the same map as the host
// (they once got a Skirmish map), and a spectator by link loads it (the
// Globe's was too wide to load, so spectators and replays got nothing).
import { browser, open, check, failed } from "./lib.mjs";
const b = await browser();
const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
await host.selectOption("#gameMode", "globe");
const guest = await open(b, "#" + code);
await host.waitForFunction(() => seats.some(isFriend), null, { timeout: 30000, polling: 200 });
await host.evaluate(() => { beginGame(); });
await guest.waitForFunction(() => running && mp, null, { timeout: 60000 });
const map = pg => pg.evaluate(() => ({ w: MW, h: MH, globe: W.map_globe(), seed: W.game_seed() }));
const hm = await map(host), gm = await map(guest);
check(hm.globe === 1 && hm.w === 480, `the host plays the Globe (${hm.w} x ${hm.h})`);
check(gm.globe === 1 && gm.w === hm.w && gm.seed === hm.seed, `the friend gets the same Globe (${gm.w} x ${gm.h}, globe ${gm.globe})`);

const watcher = await open(b, "#watch-" + code);
await watcher.waitForFunction(() => observe && observe.kind === "watch" && watcher && watcher.loaded, null, { timeout: 60000 }).catch(() => {});
const wm = await watcher.evaluate(() => ({ loaded: !!(watcher && watcher.loaded), running, w: MW, globe: W.map_globe() }));
check(wm.loaded && wm.running && wm.globe === 1 && wm.w === 480, `a spectator by link watches the Globe (loaded ${wm.loaded}, ${wm.w} wide)`);
// The spectator's copy keeps up with the players' confirmed game.
await host.waitForTimeout(4000);
const [hs, ws] = await Promise.all([host.evaluate(() => [...mp.sums].slice(-8)), watcher.evaluate(() => [watcher.k, W.checksum()])]);
check(hs.length > 0 && ws[0] > 0, `the spectator plays the game on (tick ${ws[0]})`);
check(host.errors.length === 0 && guest.errors.length === 0 && watcher.errors.length === 0, "no page errors");
await b.close();
process.exit(failed() ? 1 : 0);
