// Checks the simulation's multiplayer promises, straight against the built
// wasm (no browser needed). Run after ./build.sh:   node test/wasm.mjs
//
// 1. Determinism: two copies run the same ticks and stay identical.
// 2. mp_restore makes the live copy exactly the confirmed one.
// 3. How long a tick, a copy and a restore take, late in a busy game.
import fs from "fs";
import { fileURLToPath } from "url";
const here = fileURLToPath(new URL("..", import.meta.url));
const { instance } = await WebAssembly.instantiate(fs.readFileSync(here + "target/wasm32-unknown-unknown/release/rts.wasm"), { env: { now_ms: () => performance.now() } });
const w = instance.exports;
let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };

w.init(7, 2, 4); // 4 computer players on Hard, so the map fills up
const t0 = performance.now();
for (let s = 0; s < 20 * 60 * 10; s++) { w.tick(); if (s % 20 === 0) w.take_events(); } // 10 minutes in
const tickMs = (performance.now() - t0) / (20 * 60 * 10);

w.mp_save();                                                    // confirmed = live
for (let s = 0; s < 200; s++) { w.tick(); w.take_events(); }    // live runs 200 ticks
const live = w.checksum();
w.mp_swap(); for (let s = 0; s < 200; s++) { w.tick(); w.take_events(); } const confirmed = w.checksum(); w.mp_swap();
check(live === confirmed, "two copies running the same 200 ticks stay identical");

for (let s = 0; s < 50; s++) w.tick();                          // live drifts ahead
w.mp_restore();
check(w.checksum() === confirmed, "mp_restore makes live identical to confirmed");

let a = performance.now(); for (let i = 0; i < 100; i++) w.mp_restore(); const restoreMs = (performance.now() - a) / 100;
a = performance.now(); for (let i = 0; i < 20; i++) w.mp_save(); const saveMs = (performance.now() - a) / 20;
console.log(`tick ${tickMs.toFixed(3)} ms · copy ${saveMs.toFixed(3)} ms · restore ${restoreMs.toFixed(3)} ms · memory ${(w.memory.buffer.byteLength / 1048576).toFixed(1)} MB`);

// Frontier: the same promises on its big map with barbarians, and what a
// tick costs as the camps grow. Set FRONTIER_MINUTES for a longer game.
{
  const minutes = +(process.env.FRONTIER_MINUTES || 10);
  w.init_frontier(7, 1, 2);
  w.set_ai(1, 1); w.set_ai(2, 1);
  check(w.game_mode() === 1, "a Frontier game says so");
  check(w.is_barbarian(3) === 1 && w.is_barbarian(2) === 0, "owners after the seats are barbarians");
  const times = [];
  for (let m = 1; m <= minutes; m++) {
    const t = performance.now();
    for (let s = 0; s < 1200; s++) { w.tick(); if (s % 20 === 0) w.take_events(); }
    if (m % 5 === 0) times.push(`${m} min ${((performance.now() - t) / 1200).toFixed(2)} ms`);
  }
  w.mp_save();
  for (let s = 0; s < 200; s++) { w.tick(); w.take_events(); }
  const live = w.checksum();
  w.mp_swap(); for (let s = 0; s < 200; s++) { w.tick(); w.take_events(); } const confirmed = w.checksum(); w.mp_swap();
  check(live === confirmed, "Frontier: two copies running the same 200 ticks stay identical");
  for (let s = 0; s < 50; s++) w.tick();
  w.mp_restore();
  check(w.checksum() === confirmed, "Frontier: mp_restore makes live identical to confirmed");
  let a = performance.now(); for (let i = 0; i < 20; i++) w.mp_restore(); const restoreMs = (performance.now() - a) / 20;
  a = performance.now(); for (let i = 0; i < 10; i++) w.mp_save(); const saveMs = (performance.now() - a) / 10;
  console.log(`Frontier tick: ${times.join(", ")} · copy ${saveMs.toFixed(2)} ms · restore ${restoreMs.toFixed(2)} ms · memory ${(w.memory.buffer.byteLength / 1048576).toFixed(1)} MB`);
}
process.exit(failed ? 1 : 0);
