// Checks the simulation's multiplayer promises, straight against the built
// wasm (no browser needed). Run after ./build.sh:   node test/wasm.mjs
//
// 1. Determinism: two copies run the same ticks and stay identical.
// 2. mp_restore makes the live copy exactly the confirmed one.
// 3. How long a tick, a copy and a restore take, late in a busy game.
import fs from "fs";
import { fileURLToPath } from "url";
const here = fileURLToPath(new URL("..", import.meta.url));
const { instance } = await WebAssembly.instantiate(fs.readFileSync(here + "target/wasm32-unknown-unknown/release/rts.wasm"));
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
process.exit(failed ? 1 : 0);
