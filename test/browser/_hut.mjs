import { browser, open, sleep } from "./lib.mjs";
const b = await browser();
const pg = await open(b, "");
await sleep(300);
await pg.click("#startBtn");
await pg.waitForFunction(() => running, null, { timeout: 60000 });
const out = await pg.evaluate(() => {
  W.set_ai(ME, 1);
  const seen = new Map();
  for (let m = 0; m < 16; m++) {
    for (let s = 0; s < 1200; s++) { W.tick(); if (s % 20 === 0) W.take_events(); }
    readWorld();
    for (let i = 0; i < entCount; i++) {
      const k = E(i, F.kind);
      if (!HOUSE_UP[k] || E(i, F.owner) !== ME || (E(i, F.flags) & 2)) continue;
      const st = W.house_upgrade_state(E(i, F.id));
      const key = `${NAMES[k]}:${st}`;
      if (!seen.has(key)) seen.set(key, `min ${m + 1}: ${NAMES[k]} state ${st} → "${explain(st)}"`);
    }
  }
  return [...seen.values()];
});
console.log(out.join("\n"));
await b.close();
