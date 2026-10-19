"use strict";
const WASM_B64 = "/*WASM_BASE64*/";

// ===========================================================================
// Constants shared with the Rust side
const ENT_STRIDE = 18;
const TILE = 32; // pixels per tile in the baked terrain texture
const SIM_MS = 50;
const K = { Citizen: 0, Spearman: 1, Archer: 2, Horseman: 3, Capitol: 10, Barracks: 12, Range: 13, Stable: 14, Tower: 15, Settlement: 16, Farm: 17,
  Granary: 18, Sawmill: 19, Mason: 20, Smithy: 21, Market: 22, Temple: 23, Wonder: 24 };
const NAMES = { 0: "Citizen", 1: "Spearman", 2: "Archer", 3: "Horseman", 10: "Capitol", 12: "Barracks", 13: "Archery Range", 14: "Stable", 15: "Watch Tower", 16: "Settlement", 17: "Farm",
  18: "Granary", 19: "Sawmill", 20: "Stonemason", 21: "Smithy", 22: "Market", 23: "Temple", 24: "Wonder" };
const DESC = {
  0: "Gathers resources and constructs buildings.",
  1: "Sturdy infantry. Deals heavy damage to horsemen.",
  2: "Fires from range. Strong against spearmen, weak against horsemen.",
  3: "Fast cavalry. Runs down archers.",
  12: "Trains spearmen.",
  13: "Trains archers.",
  14: "Trains horsemen.",
  15: "Shoots at enemies in range. Needs stone.",
  16: "A drop-off point for all resources. Build it near forests and mines.",
  17: "Endless food, gathered a little slower than berries. One farmer per farm.",
  18: "Food gathering +20%.",
  19: "Wood gathering +20%.",
  20: "Stone and gold gathering +20%.",
  21: "Your soldiers deal 20% more damage.",
  22: "Traders bring in 20 gold a minute.",
  23: "All your units slowly heal.",
  24: "Finish it and you win. A huge job: put many citizens on it, and defend it.",
};
// The tech tree, grouped into eras. Your era is the latest one you've built
// something from. (Requirements themselves live in Rust: Kind::requires.)
const ERAS = [
  { name: "Village", kinds: [K.Farm, K.Settlement, K.Barracks] },
  { name: "Town", kinds: [K.Granary, K.Sawmill, K.Range] },
  { name: "City", kinds: [K.Mason, K.Tower, K.Smithy, K.Market] },
  { name: "Kingdom", kinds: [K.Stable, K.Temple] },
  { name: "Empire", kinds: [K.Wonder] },
];
const RES_NAMES = ["food", "wood", "stone", "gold"];
const ORDER_TEXT = ["Idle", "Moving", "Attack-moving", "Fighting", "Gathering", "Returning", "Building"];
// Player colours: 0 is nature, then blue, red, green, gold.
const PCOL = ["#999", "#3f86e0", "#d2452f", "#3fae5a", "#e0b23a"];
const PDARK = ["#555", "#1f4f8f", "#7f2216", "#1f6b33", "#8c6a12"];
const PLIGHT = ["#bbb", "#8cb9f0", "#ec8a77", "#86d69a", "#f2d27f"];
const PNAME = ["Nature", "Blue", "Red", "Green", "Gold"];
// Hotkeys avoid W, A, S and D, which move the camera.
const BUILD_MENU = [[K.Farm, "Q"], [K.Settlement, "E"], [K.Barracks, "R"], [K.Granary, "T"], [K.Sawmill, "Y"],
  [K.Range, "U"], [K.Mason, "I"], [K.Tower, "O"], [K.Smithy, "F"], [K.Stable, "G"], [K.Market, "C"], [K.Temple, "V"], [K.Wonder, "B"]];
const TRAIN_KEYS = "QERT";
const TRAINS = { 10: [K.Citizen], 12: [K.Spearman], 13: [K.Archer], 14: [K.Horseman] };

const RES_ICON = [
  '<svg viewBox="0 0 16 16"><path d="M8 4.2c2.6-1.6 6 .2 6 4 0 3.4-2.7 6.6-6 6.6S2 11.6 2 8.2c0-3.8 3.4-5.6 6-4z" fill="#c9473a"/><path d="M8 4.5C8 2.8 9 1.6 10.6 1.2" stroke="#6fa046" stroke-width="1.5" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="5" width="11" height="6.5" rx="1" fill="#8a5a33"/><ellipse cx="12.5" cy="8.25" rx="2.2" ry="3.25" fill="#c8995f"/><ellipse cx="12.5" cy="8.25" rx="1" ry="1.5" fill="#8a5a33"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 12l2-6 4-3 5 2 1 6-4 3H5z" fill="#9b958a"/><path d="M4 6l4-3 5 2-4 2z" fill="#c7c2b8"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 12l2-5 4-2 5 2 1 5-3 2H5z" fill="#a8822b"/><path d="M4 7l4-2 5 2-4 2z" fill="#f2cd5c"/><circle cx="6" cy="11" r="1" fill="#f7dc80"/></svg>',
];

// ===========================================================================
// Mouse cursors, drawn as tiny SVGs. Each shows what a right-click will do.
// Lines are drawn twice, dark and wide then light and narrow, so they read
// on any ground.
const svgCursor = (body, hx, hy) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`)}") ${hx} ${hy}, auto`;
const DK = "#1a140c", HANDLE = `<path d="M{a}" stroke="${DK}" stroke-width="5" stroke-linecap="round"/><path d="M{a}" stroke="#8a5a33" stroke-width="2.6" stroke-linecap="round"/>`;
const handle = d => HANDLE.replaceAll("{a}", d);
const CURSORS = {
  // 1 move: an arrow with a green target ring
  1: svgCursor(`<path d="M3 2v20l5.5-5 3.5 8 3-1.4-3.4-7.6H19z" fill="#fff" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="24" cy="25" r="5" fill="none" stroke="${DK}" stroke-width="4"/><circle cx="24" cy="25" r="5" fill="none" stroke="#7be864" stroke-width="2"/>`, 3, 2),
  // 2 attack: a sword
  2: svgCursor(`<path d="M2 2l5 1 15 15-4 4L3 7z" fill="#e3e6ea" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M15 25l10-10" stroke="${DK}" stroke-width="6" stroke-linecap="round"/><path d="M15 25l10-10" stroke="#b5321f" stroke-width="3" stroke-linecap="round"/>
    ${handle("21 21l6 6")}<circle cx="28" cy="28" r="2.6" fill="#b5321f" stroke="${DK}" stroke-width="1.4"/>`, 2, 2),
  // 3 forage and 9 farm: a sickle
  3: svgCursor(`${handle("19 19l8 8")}<path d="M19 19C5 18 2 6 11 2c-3 5-2 12 8 17z" fill="#dfe3e8" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 10, 3),
  // 4 build: a hammer
  4: svgCursor(`${handle("13 13l14 14")}<path d="M3 10l7-7 9 9-7 7z" fill="#9da3ab" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 6, 6),
  // 5 rally point: a flag
  5: svgCursor(`<path d="M6 30V3" stroke="${DK}" stroke-width="4" stroke-linecap="round"/><path d="M6 30V3" stroke="#d9c9a8" stroke-width="2"/>
    <path d="M7 4l17 5-17 6z" fill="#3f86e0" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 6, 30),
  // 6 chop wood: an axe
  6: svgCursor(`${handle("9 9l18 18")}<path d="M3 14l5-11 9 3-8 11z" fill="#d6d9de" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 4, 9),
  // 7 mine stone or gold: a pickaxe
  7: svgCursor(`${handle("10 10l17 17")}<path d="M2 13C7 5 14 2 23 3" fill="none" stroke="${DK}" stroke-width="6" stroke-linecap="round"/>
    <path d="M2 13C7 5 14 2 23 3" fill="none" stroke="#a9aeb6" stroke-width="3" stroke-linecap="round"/>`, 2, 13),
  // 8 drop off resources: a crate with an arrow into it
  8: svgCursor(`<rect x="7" y="15" width="18" height="13" rx="1.5" fill="#a0703f" stroke="${DK}" stroke-width="1.6"/><path d="M7 21h18" stroke="${DK}" stroke-width="1.4"/>
    <path d="M16 2v10m-5-4 5 5 5-5" fill="none" stroke="${DK}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M16 2v10m-5-4 5 5 5-5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`, 16, 14),
};
CURSORS[9] = CURSORS[3];

// ===========================================================================
// Boot the WebAssembly module
let W, mem;
async function loadWasm() {
  const bin = Uint8Array.from(atob(WASM_B64), c => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bin, {});
  W = instance.exports;
  mem = W.memory;
}
// Views must be re-created after wasm memory grows, so always get fresh ones.
const f32 = (ptr, n) => new Float32Array(mem.buffer, ptr, n);
const u8 = (ptr, n) => new Uint8Array(mem.buffer, ptr, n);

// ===========================================================================
// DOM
const $ = id => document.getElementById(id);
const view = $("view");
const over = $("over"), octx = over.getContext("2d"); // 2D overlay: health bars, drag box
const mini = $("mini"), mctx = mini.getContext("2d");
const stage = $("stage");

let MW = 80, MH = 80;
let terrainCanvas, terrainSmall, fogCanvas, fogCtx, fogImg;
let difficulty = 1, seed = 1, opponents = 1;
// The camera looks at map point (x, y) from `dist` away, tilted down by `pitch`,
// turned by `yaw` (middle-drag rotates).
let cam = { x: 40, y: 40, dist: 24, pitch: 0.95, yaw: 0 };
let paused = false, speed = 1, running = false;
let acc = 0, last = performance.now(), simTime = 0;
let ents = new Float32Array(0), entCount = 0, byId = new Map();
let resBuf = new Float32Array(0), resCount = 0;
let projBuf = new Float32Array(0), projCount = 0;
let mouse = { x: 0, y: 0, inside: false };
let drag = null, orbit = null;
let placing = null, amode = false;
let groups = {};
let lastClick = { t: 0, x: 0, y: 0 };
let lastAlert = null;
let keys = new Set();
let selKey = "";
let hoverTip = null;
let frame = 0;

function resizeView() {
  const r = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view._w = r.width; view._h = r.height;
  over.width = Math.max(1, Math.round(r.width * dpr));
  over.height = Math.max(1, Math.round(r.height * dpr));
  over._dpr = dpr;
  resizeRenderer();
}
window.addEventListener("resize", resizeView);

function clampCam() {
  cam.x = Math.max(0, Math.min(MW, cam.x));
  cam.y = Math.max(0, Math.min(MH, cam.y));
  cam.dist = Math.max(9, Math.min(48, cam.dist));
  cam.pitch = Math.max(0.6, Math.min(1.35, cam.pitch));
}
function centerOn(tx, ty) { cam.x = tx; cam.y = ty; clampCam(); }

// ===========================================================================
// Small helpers
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function ellipse(c, x, y, rx, ry) { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); }
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }
function fmtTime(s) { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function costOf(k) { return [0, 1, 2, 3].map(r => W.kind_cost(k, r)); }
function stat(k, i) { return W.kind_stat(k, i); }
function canAfford(k) { return costOf(k).every((c, r) => W.stock(r) >= c); }
function costHtml(k) {
  return '<div class="cost">' + costOf(k).map((c, r) => c ? `<span class="${W.stock(r) < c ? "short" : ""}">${RES_ICON[r]}${c}</span>` : "").join("") + "</div>";
}

// ===========================================================================
// Terrain: paint tile colours into a tiny canvas, then let the browser scale
// it up with smoothing — that blends the tile edges for free.
// Smooth value noise for large-scale colour variation (meadow patches).
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sm = t => t * t * (3 - 2 * t), u = sm(fx), v = sm(fy);
  const hsh = (a, b) => hash2(a * 31 + seed, b * 17 - seed);
  const top = hsh(xi, yi) + (hsh(xi + 1, yi) - hsh(xi, yi)) * u;
  const bot = hsh(xi, yi + 1) + (hsh(xi + 1, yi + 1) - hsh(xi, yi + 1)) * u;
  return top + (bot - top) * v;
}
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Paint the ground texture. A small per-tile image feeds the minimap; the big
// one (32 px per tile) is the 3D terrain's texture.
function bakeTerrain() {
  MW = W.map_w(); MH = W.map_h();
  computeHeights();
  const ter = u8(W.terrain_ptr(), MW * MH).slice();
  // Colour at any map position. Grass blends lush, dark and sun-dried greens
  // in big soft patches; slopes turn to earth and rock; shores to sand.
  const LUSH = [86, 140, 58], DARK = [58, 104, 44], DRY = [146, 152, 76], EARTH = [122, 104, 72], ROCK = [132, 126, 112], SAND = [204, 186, 132], SEABED = [120, 132, 96];
  const colourAt = (x, y) => {
    const t = ter[Math.min(MH - 1, y | 0) * MW + Math.min(MW - 1, x | 0)];
    const n1 = vnoise(x / 9, y / 9, 3), n2 = vnoise(x / 3.5, y / 3.5, 11), n3 = vnoise(x * 1.3, y * 1.3, 29);
    let c = mixc(LUSH, DARK, Math.max(0, Math.min(1, (n1 - 0.45) * 2.5)));
    c = mixc(c, DRY, Math.max(0, Math.min(1, (n2 - 0.62) * 3)));
    const sl = slopeAt(x, y), ht = hAt(x, y);
    c = mixc(c, EARTH, Math.max(0, Math.min(1, (sl - 0.18) * 4)));
    c = mixc(c, ROCK, Math.max(0, Math.min(1, (sl - 0.38) * 4)));
    c = mixc(c, [c[0] * 1.08, c[1] * 1.05, c[2] * 0.95], Math.max(0, Math.min(1, ht - 0.8))); // sunnier up high
    // Beaches follow the (smooth) height near the water, not the square tiles.
    c = mixc(c, SAND, Math.max(0, Math.min(1, (0.2 - ht) / 0.14)) * 0.9);
    if (t === 1) c = mixc(SAND, SEABED, Math.min(1, -ht));
    const k = 0.92 + n3 * 0.16;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  terrainSmall = document.createElement("canvas");
  terrainSmall.width = MW; terrainSmall.height = MH;
  const sc = terrainSmall.getContext("2d");
  const img = sc.createImageData(MW, MH);
  for (let i = 0; i < MW * MH; i++) {
    const c = ter[i] === 1 ? [40, 96, 118] : colourAt((i % MW) + 0.5, ((i / MW) | 0) + 0.5);
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  sc.putImageData(img, 0, 0);

  // The 3D texture: a mid-resolution colour pass (8 px per tile), scaled up.
  const MID = 8;
  const mid = document.createElement("canvas"); mid.width = MW * MID; mid.height = MH * MID;
  const mc = mid.getContext("2d"), mi = mc.createImageData(mid.width, mid.height);
  for (let py = 0; py < mid.height; py++) for (let px = 0; px < mid.width; px++) {
    const c = colourAt((px + 0.5) / MID, (py + 0.5) / MID);
    mi.data.set([c[0], c[1], c[2], 255], (py * mid.width + px) * 4);
  }
  mc.putImageData(mi, 0, 0);
  terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = MW * TILE; terrainCanvas.height = MH * TILE;
  const tc = terrainCanvas.getContext("2d");
  tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = "high";
  tc.drawImage(mid, 0, 0, MW * TILE, MH * TILE);

  // Detail on top: blades of grass in a few greens, pebbles, sand ripples.
  const blades = ["rgba(36,64,26,.38)", "rgba(150,190,96,.28)", "rgba(70,110,44,.35)", "rgba(190,190,110,.22)"];
  for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) {
    const t = ter[ty * MW + tx];
    const rocky = slopeAt(tx + 0.5, ty + 0.5) > 0.35;
    for (let k = 0; k < 9; k++) {
      const hx = hash2(tx * 7 + k, ty * 13 - k), hy = hash2(ty * 11 + k, tx * 5 + k);
      const x = (tx + hx) * TILE, y = (ty + hy) * TILE;
      if ((t === 0 || t === 3) && !rocky) {
        tc.strokeStyle = blades[k % 4]; tc.lineWidth = 1.1;
        const lean = (hx - 0.5) * 3;
        tc.beginPath(); tc.moveTo(x, y); tc.lineTo(x + lean, y - 4 - hy * 3); tc.moveTo(x + 2, y); tc.lineTo(x + 2 + lean, y - 3); tc.stroke();
      } else if (rocky && k < 4) {
        tc.fillStyle = k % 2 ? "rgba(70,62,50,.35)" : "rgba(200,192,176,.3)";
        tc.beginPath(); tc.ellipse(x, y, 1.5 + hx * 2.5, 1 + hy * 1.5, hx * 3, 0, 7); tc.fill();
      } else if (t === 2 && k < 3) {
        tc.strokeStyle = "rgba(150,124,80,.25)"; tc.lineWidth = 1;
        tc.beginPath(); tc.moveTo(x - 4, y); tc.quadraticCurveTo(x, y - 1.5, x + 4, y); tc.stroke();
      }
    }
  }
  // Fine grain over everything.
  const grain = document.createElement("canvas"); grain.width = 128; grain.height = 128;
  const gc = grain.getContext("2d"), gi = gc.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) { const v = Math.random() * 255; gi.data.set([v, v, v, 12], i * 4); }
  gc.putImageData(gi, 0, 0);
  tc.fillStyle = tc.createPattern(grain, "repeat"); tc.fillRect(0, 0, MW * TILE, MH * TILE);

  fogCanvas = document.createElement("canvas"); fogCanvas.width = MW; fogCanvas.height = MH;
  fogCtx = fogCanvas.getContext("2d"); fogImg = fogCtx.createImageData(MW, MH);
}

function updateFog() {
  const fog = u8(W.fog_ptr(), MW * MH);
  const d = fogImg.data;
  for (let i = 0; i < MW * MH; i++) {
    d[i * 4] = 10; d[i * 4 + 1] = 9; d[i * 4 + 2] = 7;
    d[i * 4 + 3] = fog[i] === 0 ? 255 : fog[i] === 1 ? 120 : 0;
  }
  fogCtx.putImageData(fogImg, 0, 0);
  updateFowTexture();
}

// ===========================================================================
// Reading the world from wasm memory
function readWorld() {
  entCount = W.render();
  ents = f32(W.ents_ptr(), entCount * ENT_STRIDE);
  resCount = W.res_count();
  resBuf = f32(W.res_ptr(), resCount * 5);
  projCount = W.proj_count();
  projBuf = f32(W.proj_ptr(), projCount * 4);
  byId.clear();
  for (let i = 0; i < entCount; i++) byId.set(ents[i * ENT_STRIDE], i);
}
const E = (i, f) => ents[i * ENT_STRIDE + f];
// field offsets
const F = { id: 0, kind: 1, owner: 2, x: 3, y: 4, px: 5, py: 6, hp: 7, maxhp: 8, flags: 9, prog: 10, anim: 11, carryK: 12, carry: 13, face: 14, order: 15, rx: 16, ry: 17 };

function selection() {
  const out = [];
  for (let i = 0; i < entCount; i++) if (E(i, F.flags) & 1) out.push(i);
  return out;
}

// ===========================================================================
// 2D overlay on top of the 3D view: health bars and the drag box.
function drawOverlay() {
  const dpr = over._dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, view._w, view._h);
  for (let i = 0; i < entCount; i++) {
    const sel = E(i, F.flags) & 1, f = E(i, F.hp) / E(i, F.maxhp);
    if (!sel && (f >= 1 || E(i, F.kind) >= 10)) continue;
    const p = entScreen(i, true);
    if (!p || p.behind) continue;
    const w = E(i, F.kind) >= 10 ? 46 : 22;
    octx.fillStyle = "rgba(0,0,0,.6)"; octx.fillRect(p.x - w / 2 - 1, p.y - 8, w + 2, 5);
    octx.fillStyle = f > 0.5 ? "#79c95f" : f > 0.25 ? "#e3b23c" : "#e2593f";
    octx.fillRect(p.x - w / 2, p.y - 7, w * Math.max(0, f), 3);
  }
  if (drag && drag.moved) {
    octx.strokeStyle = "#9cf27f"; octx.lineWidth = 1; octx.fillStyle = "rgba(156,242,127,.08)";
    const x = Math.min(drag.x0, mouse.x), y = Math.min(drag.y0, mouse.y), w = Math.abs(mouse.x - drag.x0), h = Math.abs(mouse.y - drag.y0);
    octx.fillRect(x, y, w, h); octx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
}

function drawMinimap() {
  const s = mini.width / MW;
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(terrainSmall, 0, 0, mini.width, mini.height);
  for (let i = 0; i < resCount; i++) {
    const kd = resBuf[i * 5 + 2];
    mctx.fillStyle = ["#d04848", "#24451f", "#b8b2a6", "#f0c94a"][kd];
    mctx.fillRect(resBuf[i * 5] * s, resBuf[i * 5 + 1] * s, Math.max(1.5, s), Math.max(1.5, s));
  }
  mctx.drawImage(fogCanvas, 0, 0, mini.width, mini.height);
  for (let i = 0; i < entCount; i++) {
    const k = E(i, F.kind), o = E(i, F.owner);
    mctx.fillStyle = (E(i, F.flags) & 1) ? "#fff" : PLIGHT[o];
    if (k >= 10) { const z = stat(k, 6) * s; mctx.fillRect(E(i, F.x) * s - z / 2, E(i, F.y) * s - z / 2, z, z); }
    else mctx.fillRect(E(i, F.x) * s - 1.5, E(i, F.y) * s - 1.5, 3, 3);
  }
  // What the camera sees is a trapezoid on the ground.
  const q = viewQuad();
  if (q.length === 4) {
    mctx.strokeStyle = "#efe6d1"; mctx.lineWidth = 1;
    mctx.beginPath();
    q.forEach(([x, y], n) => n ? mctx.lineTo(x * s, y * s) : mctx.moveTo(x * s, y * s));
    mctx.closePath(); mctx.stroke();
  }
}

// ===========================================================================
// HUD
// The resource bar. Built once, then only its numbers change, so the hover
// tooltip doesn't flicker.
function setupTopBar() {
  const bar = $("res");
  bar.replaceChildren();
  const chips = [];
  for (let r = 0; r < 4; r++) {
    const c = document.createElement("span");
    c.className = "chip"; c.tabIndex = 0;
    c.innerHTML = `${RES_ICON[r]}<b></b><small></small>`;
    c.onmouseenter = c.onfocus = () => { resTipFor = r; renderResTip(); };
    c.onmouseleave = c.onblur = () => { resTipFor = -1; $("restip").hidden = true; };
    c.onclick = () => { resTipFor = resTipFor === r ? -1 : r; renderResTip(); }; // tap on phones
    bar.append(c); chips.push(c);
  }
  const pop = document.createElement("span"); pop.className = "chip pop";
  const era = document.createElement("button"); era.className = "era"; era.title = "Tech tree (K)";
  era.onclick = toggleTech;
  const wonder = document.createElement("span"); wonder.className = "chip foe-wonder"; wonder.hidden = true;
  bar.append(pop, era, wonder);
  topBar = { chips, pop, era, wonder };
}
let topBar = null, resTipFor = -1;
// Buildings the player has already been told they can build.
let knownUnlocked = new Set();

function eraIndex() {
  let e = 0;
  ERAS.forEach((era, i) => { if (era.kinds.some(k => W.has_built(k))) e = i; });
  return e;
}

// Net change per minute: what's gathered minus what's eaten (food only).
function netRate(r) { return W.income(r) - (r === 0 ? W.upkeep() : 0); }
const signed = v => (v >= 0.5 ? "+" : v <= -0.5 ? "−" : "±") + Math.abs(Math.round(v));

function renderTopBar() {
  if (!topBar) setupTopBar();
  topBar.chips.forEach((c, r) => {
    c.querySelector("b").textContent = Math.floor(W.stock(r));
    const v = netRate(r), sm = c.querySelector("small");
    sm.textContent = `${signed(v)}/min`;
    sm.className = v <= -0.5 ? "neg" : v >= 0.5 ? "pos" : "";
  });
  const starving = W.starving();
  topBar.pop.className = "chip pop" + (starving ? " full" : "");
  topBar.pop.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="8" cy="4.5" r="2.8" fill="#d9c9a8"/><path d="M2.5 15c0-3.6 2.4-6 5.5-6s5.5 2.4 5.5 6z" fill="#d9c9a8"/></svg>${W.pop()}${starving ? " · starving" : ""}`;
  topBar.era.textContent = `${ERAS[eraIndex()].name} era`;
  const ew = W.enemy_wonder();
  topBar.wonder.hidden = ew < 0;
  if (ew >= 0) topBar.wonder.textContent = `Rival Wonder ${Math.floor(ew * 100)}%`;
  $("clock").textContent = fmtTime(W.game_time());
  if (resTipFor >= 0) renderResTip();
}

// Where a resource comes from and where it goes.
function renderResTip() {
  const tip = $("restip"), r = resTipFor;
  if (r < 0) { tip.hidden = true; return; }
  const inc = W.income(r), n = W.workers(r), bonus = W.gather_bonus(r);
  const line = (label, v, cls = "") => `<div class="row ${cls}"><span>${label}</span><b>${signed(v)}/min</b></div>`;
  const bonusFrom = { 0: "Granary", 1: "Sawmill", 2: "Stonemason", 3: "Stonemason" }[r];
  let html = `<h4>${RES_NAMES[r][0].toUpperCase() + RES_NAMES[r].slice(1)}</h4>`;
  let gathered = inc;
  if (r === 3 && W.bonus(2) > 0) { html += line("Market traders", W.bonus(2), "pos"); gathered -= W.bonus(2); }
  html += line(`Gathering · ${n} citizen${n === 1 ? "" : "s"}`, gathered, "pos");
  html += bonus > 1 ? `<p>${bonusFrom}: gathering +${Math.round((bonus - 1) * 100)}%</p>` : `<p>A ${bonusFrom} would speed this up by 20%.</p>`;
  if (r === 0) {
    for (const k of [K.Citizen, K.Spearman, K.Archer, K.Horseman]) {
      const c = W.count(k);
      if (c) html += line(`${c} ${NAMES[k]}${c === 1 ? "" : k === K.Spearman ? "" : "s"} × ${stat(k, 7)}`.replace("Spearman", c === 1 ? "Spearman" : "Spearmen"), -c * stat(k, 7), "neg");
    }
    html += `<div class="row total"><span>Net</span><b>${signed(netRate(0))}/min</b></div>`;
    if (W.starving()) html += `<p class="bad">Starving: your units are losing health.</p>`;
  }
  html += `<p class="note">Gathering is averaged over the last minute.</p>`;
  tip.innerHTML = html;
  const chip = topBar.chips[r].getBoundingClientRect(), app = $("app").getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(app.width - 270, chip.left - app.left))}px`;
  tip.hidden = false;
}

// The tech tree panel.
function toggleTech() {
  const p = $("techScreen");
  if (!p.hidden) { p.hidden = true; return; }
  renderTech();
  p.hidden = false;
}
function renderTech() {
  const body = $("techBody");
  body.replaceChildren();
  ERAS.forEach((era, i) => {
    const col = document.createElement("div"); col.className = "era-col" + (i <= eraIndex() ? " reached" : "");
    col.innerHTML = `<h3>${["I", "II", "III", "IV", "V"][i]} · ${era.name}</h3>`;
    for (const k of era.kinds) {
      const card = document.createElement("div");
      const built = W.has_built(k), open = W.unlocked(k);
      card.className = "tcard " + (built ? "built" : open ? "open" : "locked");
      card.append(iconEl(k, ME, 40));
      const needs = []; for (let n = 0, q; (q = W.requires(k, n)) >= 0; n++) needs.push(q);
      const info = document.createElement("div");
      info.innerHTML = `<b>${NAMES[k]}</b><span>${DESC[k] || ""}</span>` +
        (needs.length ? `<span class="needs">Needs ${needs.map(q => `<i class="${W.has_built(q) ? "ok" : ""}">${NAMES[q]}</i>`).join(" + ")}</span>` : "") +
        `<span class="state">${built ? "Built" : open ? "Ready to build" : "Locked"}</span>`;
      card.append(info);
      col.append(card);
    }
    body.append(col);
  });
}

function renderSelection(force) {
  const sel = selection();
  // Only rebuild the DOM when something visible changed.
  const sig = sel.map(i => `${E(i, F.id)}:${Math.ceil(E(i, F.hp))}:${E(i, F.order)}:${Math.floor(E(i, F.carry))}:${Math.floor(E(i, F.prog) * 40)}:${W.queue_len(E(i, F.id))}`).join(",") + `|${placing}|${amode}|${ERAS.flatMap(e => e.kinds).map(k => W.has_built(k)).join("")}|${Math.floor(W.stock(0))}${Math.floor(W.stock(1))}${Math.floor(W.stock(2))}${Math.floor(W.stock(3))}`;
  if (!force && sig === selKey) return;
  selKey = sig;
  const panel = $("sel");
  panel.replaceChildren();
  if (sel.length === 0) {
    const d = document.createElement("div");
    d.className = "tips";
    d.innerHTML = `<h3>Outlast your rivals</h3>Select citizens and right-click trees, berries, gold or stone to gather. Every unit eats food all the time, so keep plenty of people on berries and <b>Farms</b>. Then build a <b>Barracks</b>, <b>Archery Range</b> or <b>Stable</b> for an army. Press <kbd class="k">.</kbd> to find idle citizens.`;
    panel.append(d);
  } else if (sel.length === 1) {
    singleInfo(panel, sel[0]);
  } else {
    const box = document.createElement("div"); box.className = "multi";
    for (const i of sel.slice(0, 40)) {
      const b = document.createElement("button");
      b.title = NAMES[E(i, F.kind)];
      b.append(iconEl(E(i, F.kind), E(i, F.owner), 36));
      const bar = document.createElement("i"); const fill = document.createElement("b");
      fill.style.width = `${(E(i, F.hp) / E(i, F.maxhp)) * 100}%`; bar.append(fill); b.append(bar);
      const id = E(i, F.id);
      b.onclick = () => { setSelection([id]); };
      box.append(b);
    }
    panel.append(box);
  }
  renderCommands(sel);
}

function singleInfo(panel, i) {
  const k = E(i, F.kind), owner = E(i, F.owner), id = E(i, F.id);
  const por = iconEl(k, owner, 72); por.className = "portrait";
  const info = document.createElement("div"); info.className = "info";
  const hp = Math.ceil(E(i, F.hp)), max = E(i, F.maxhp);
  let html = `<div class="owner" style="color:${PLIGHT[owner]}">${owner === ME ? "Yours" : PNAME[owner]}</div><h3>${NAMES[k]}</h3>
    <div class="bar"><i style="width:${(hp / max) * 100}%"></i></div>
    <div class="statline"><b>${hp}</b> / ${max} hp`;
  const atk = stat(k, 1);
  if (atk > 0) html += ` · attack <b>${atk}</b> · ${stat(k, 2) > 1.5 ? `range <b>${stat(k, 2)}</b>` : "melee"}`;
  html += `</div>`;
  if (k < 10) {
    let st = ORDER_TEXT[E(i, F.order)];
    if (k === K.Citizen && E(i, F.carry) >= 1) st += ` · carrying ${Math.floor(E(i, F.carry))} ${RES_NAMES[E(i, F.carryK)]}`;
    if (owner === ME) html += `<div class="statline">${st}</div>`;
  } else if (E(i, F.flags) & 2) {
    html += `<div class="statline">Under construction · ${Math.floor(E(i, F.prog) * 100)}%</div><div class="bar prog"><i style="width:${E(i, F.prog) * 100}%"></i></div>`;
  }
  info.innerHTML = html;
  if (k >= 10 && owner === ME && W.queue_len(id) > 0) {
    const q = W.queue_len(id);
    const line = document.createElement("div"); line.className = "statline";
    line.innerHTML = `Training ${NAMES[W.queue_kind(id, 0)]} · ${Math.floor(E(i, F.prog) * 100)}%`;
    const bar = document.createElement("div"); bar.className = "bar prog"; bar.innerHTML = `<i style="width:${E(i, F.prog) * 100}%"></i>`;
    const row = document.createElement("div"); row.className = "queue";
    for (let n = 0; n < q; n++) {
      const b = document.createElement("button"); b.title = "Click to cancel the last unit in the queue";
      b.append(iconEl(W.queue_kind(id, n), ME, 32));
      b.onclick = () => issue({ c: 5, ids: [id] });
      row.append(b);
    }
    info.append(line, bar, row);
  }
  panel.append(por, info);
}

function cmdButton(label, key, onClick, opts = {}) {
  const b = document.createElement("button");
  b.className = "cbtn" + (opts.glyph ? " glyph" : "") + (opts.poor ? " poor" : "") + (opts.locked ? " locked" : "");
  if (opts.icon) b.append(opts.icon); else b.append(document.createTextNode(opts.glyph || ""));
  if (key) { const kb = document.createElement("kbd"); kb.textContent = key; b.append(kb); }
  b.setAttribute("aria-label", label);
  b.onclick = onClick;
  b.onmouseenter = () => showTip(opts.tip || `<h4>${label}</h4>`);
  b.onmouseleave = hideTip;
  b.dataset.key = key || "";
  return b;
}
function showTip(html) { const t = $("tip"); t.innerHTML = html; t.hidden = false; }
function hideTip() { $("tip").hidden = true; }

let cmdKeys = {};
function renderCommands(sel) {
  const box = $("cmd");
  const tip = $("tip");
  box.replaceChildren(tip);
  cmdKeys = {};
  const mine = sel.filter(i => E(i, F.owner) === ME);
  if (!mine.length) return;
  const kinds = new Set(mine.map(i => E(i, F.kind)));
  const add = (b, key, fn) => { box.append(b); if (key) cmdKeys[key.toLowerCase()] = fn; };
  const unitTip = k => {
    let h = `<h4>${NAMES[k]}</h4>${costHtml(k)}<p>${DESC[k] || ""}</p>` + (stat(k, 7) > 0 ? `<p>Eats ${stat(k, 7)} food per minute.</p>` : "");
    const needs = []; for (let n = 0, q; (q = W.requires(k, n)) >= 0; n++) needs.push(q);
    if (needs.length) h += `<p>Needs ${needs.map(q => `<span class="${W.has_built(q) ? "" : "short"}">${NAMES[q]}</span>`).join(" and ")}.</p>`;
    return h;
  };

  if (kinds.has(K.Citizen)) {
    for (const [k, key] of BUILD_MENU) {
      const fn = () => startPlacing(k);
      const locked = k >= 10 && !W.unlocked(k);
      add(cmdButton(`Build ${NAMES[k]}`, key, fn, { icon: iconEl(k, ME, 48), poor: !canAfford(k), locked, tip: unitTip(k) }), key, fn);
    }
  }
  const producers = mine.filter(i => TRAINS[E(i, F.kind)] && !(E(i, F.flags) & 2));
  const trainable = new Set(producers.flatMap(i => TRAINS[E(i, F.kind)]));
  for (const k of trainable) {
    const key = TRAIN_KEYS[[...trainable].indexOf(k)];
    const fn = () => doTrain(k);
    add(cmdButton(`Train ${NAMES[k]}`, key, fn, { icon: iconEl(k, ME, 48), poor: !canAfford(k), tip: unitTip(k) + `<p>Right-click the map to set a rally point.</p>` }), key, fn);
  }
  const hasUnits = mine.some(i => E(i, F.kind) < 10);
  if (mine.some(i => E(i, F.kind) >= 1 && E(i, F.kind) <= 3)) {
    const fn = () => setAmode(true);
    add(cmdButton("Attack-move", "Z", fn, { glyph: "⚔︎", tip: "<h4>Attack-move</h4><p>Walk to a spot and fight anything met on the way.</p>" }), "Z", fn);
  }
  if (hasUnits) {
    const fn = () => issue({ c: 3, ids: myIds(false) });
    add(cmdButton("Stop", "X", fn, { glyph: "■", tip: "<h4>Stop</h4><p>Drop the current order.</p>" }), "X", fn);
  }
}

function toast(msg, cls = "") {
  const t = document.createElement("div"); t.className = "toast " + cls; t.textContent = msg;
  $("toasts").append(t);
  setTimeout(() => t.remove(), 3300);
  while ($("toasts").children.length > 4) $("toasts").firstChild.remove();
}
function explain(code) {
  if (code >= 1 && code <= 4) return `Not enough ${RES_NAMES[code - 1]}`;
  if (code >= 100) return `Build a ${NAMES[code - 100]} first`;
  return { 10: "That queue is full", 11: "Select a building that can train this", 12: "Can't build there" }[code] || "Can't do that";
}

// ===========================================================================
// Commands. Everything the player tells the game goes through `issue`, as a
// small plain object: {c: code, ids: [...], x, y, a}. In single player it
// runs at once. In multiplayer it's handed to the lockstep, which runs it on
// both computers a few turns from now. (Codes: see `command` in lib.rs.)
// On the wire, and everywhere after `issue`, a command is a flat array of
// numbers: [code, arg, x, y, ...ids]. Compact (it has to fit, with others,
// into 4 KiB messages) and shallow. x and y are rounded to 1/100 of a tile
// once, here, so every computer applies exactly the same numbers.
function issue(cmd) {
  const r2 = v => Math.round((v || 0) * 100) / 100;
  const arr = [cmd.c, cmd.a || 0, r2(cmd.x), r2(cmd.y), ...(cmd.ids || []).slice(0, 60)];
  if (mp) { mp.queue(arr); return 0; }
  return applyCmd(ME, arr);
}
function applyCmd(owner, arr) {
  const [c, a, x, y] = arr, ids = arr.slice(4);
  if (c === 7 && owner !== 0) return 0; // only the host's system messages may do that
  if (c === 7) toast(`${PNAME[a] || "A player"} left. The computer takes over their people.`);
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(mem.buffer);
  ids.forEach((id, n) => { buf[p + n] = id; });
  const code = W.command(owner, c, ids.length, x, y, a);
  // In multiplayer we only learn now (a moment later) whether it worked.
  if (code && mp && owner === ME) { toast(explain(code), "bad"); Sfx.ui("error"); }
  return code;
}
// Commands arriving from the network are someone else's input: check the shape.
function cleanCmd(arr) {
  if (!Array.isArray(arr) || arr.length < 4 || arr.length > 64) return null;
  if (!arr.every(v => typeof v === "number" && Number.isFinite(v))) return null;
  const c = arr[0] | 0;
  if (c < 1 || c > 7) return null;
  return [c, arr[1] >>> 0, arr[2], arr[3], ...arr.slice(4).map(v => v >>> 0)];
}
const myIds = (buildings = null) => selection().filter(i => E(i, F.owner) === ME && (buildings === null || (E(i, F.kind) >= 10) === buildings)).map(i => E(i, F.id));

function doTrain(k) {
  if (!canAfford(k)) { toast(explain(1 + costOf(k).findIndex((c, r) => W.stock(r) < c)), "bad"); Sfx.ui("error"); return; }
  const code = issue({ c: 4, ids: myIds(true), a: k });
  if (code) { toast(explain(code), "bad"); Sfx.ui("error"); } else Sfx.ui("queued");
  selKey = "";
}
function startPlacing(k) {
  if (k >= 10 && !W.unlocked(k)) { let n = 0, q; while ((q = W.requires(k, n++)) >= 0) if (!W.has_built(q)) break; toast(explain(100 + q), "bad"); Sfx.ui("error"); return; }
  if (!canAfford(k)) { toast(explain(1 + costOf(k).findIndex((c, r) => W.stock(r) < c)), "bad"); Sfx.ui("error"); return; }
  placing = k; amode = false; updateCursor();
}
function setAmode(on) { amode = on; placing = null; updateCursor(); }
function updateCursor() {
  lastCursorCheck = 0; cursorCode = -1; // refresh the mouse cursor now
  view.classList.toggle("placing", placing != null);
  view.classList.toggle("amode", amode);
  const h = $("hint");
  if (placing != null) { h.hidden = false; h.textContent = `Place ${NAMES[placing]}: click to build, Shift-click for more, right-click to cancel`; }
  else if (amode) { h.hidden = false; h.textContent = "Attack-move: click a destination, right-click to cancel"; }
  else h.hidden = true;
}
function setSelection(ids) {
  const p = W.scratch_ptr() >>> 2;
  const buf = new Uint32Array(mem.buffer);
  ids.slice(0, 512).forEach((id, n) => { buf[p + n] = id; });
  W.select_ids(Math.min(ids.length, 512));
  readWorld(); selKey = "";
}

// ===========================================================================
// Input
view.addEventListener("contextmenu", e => e.preventDefault());
mini.addEventListener("contextmenu", e => e.preventDefault());

function localPos(e) { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

// Where a building would go for the cursor at screen (sx, sy).
function placementSpot(sx, sy) {
  const w = screenToGround(sx, sy);
  if (!w) return null;
  const size = stat(placing, 6);
  return { tx: Math.round(w.x - size / 2), ty: Math.round(w.y - size / 2) };
}

// Box select happens here in JS: with a tilted camera, a box on screen is
// not a rectangle on the map, so we test each unit's position on screen.
function boxSelect(x0, y0, x1, y1, add, kindFilter = -1) {
  const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
  const units = [], buildings = [];
  for (let i = 0; i < entCount; i++) {
    if (E(i, F.owner) !== ME) continue;
    const k = E(i, F.kind);
    if (kindFilter >= 0 && k !== kindFilter) continue;
    const p = entScreen(i, false);
    if (!p || p.behind || p.x < lx || p.x > hx || p.y < ly || p.y > hy) continue;
    (k >= 10 ? buildings : units).push(E(i, F.id));
  }
  let ids = units.length ? units : buildings;
  if (add) ids = [...new Set([...selection().filter(i => E(i, F.owner) === ME).map(i => E(i, F.id)), ...ids])];
  setSelection(ids);
}

let touch = null;
view.addEventListener("pointerdown", e => {
  if (!running) return;
  view.setPointerCapture(e.pointerId);
  const p = localPos(e); mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
  if (e.pointerType === "touch") { touch = { x0: p.x, y0: p.y, cx: cam.x, cy: cam.y, moved: false }; return; }
  if (e.button === 1) { orbit = { x0: p.x, y0: p.y, yaw: cam.yaw, pitch: cam.pitch }; e.preventDefault(); return; }
  if (e.button === 2) {
    if (placing != null || amode) { placing = null; setAmode(false); return; }
    command(p);
    return;
  }
  if (e.button !== 0) return;
  if (placing != null) { tryPlace(p, e.shiftKey); return; }
  if (amode) {
    const w = screenToGround(p.x, p.y);
    if (w) { issue({ c: 2, ids: myIds(false), x: w.x, y: w.y }); marker(w, 2); Sfx.ui("command", 2); }
    if (!e.shiftKey) setAmode(false);
    return;
  }
  drag = { x0: p.x, y0: p.y, moved: false, shift: e.shiftKey };
});
view.addEventListener("pointermove", e => {
  const p = localPos(e); mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
  if (touch) {
    if (Math.hypot(p.x - touch.x0, p.y - touch.y0) > 10) touch.moved = true;
    if (touch.moved) {
      // Drag the map under your finger.
      const k = cam.dist / view._h * 1.6, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
      const dx = -(p.x - touch.x0) * k, dy = -(p.y - touch.y0) * k;
      cam.x = touch.cx + dx * c + dy * s; cam.y = touch.cy - dx * s + dy * c; clampCam();
    }
    return;
  }
  if (orbit) { cam.yaw = orbit.yaw - (p.x - orbit.x0) * 0.008; cam.pitch = orbit.pitch + (p.y - orbit.y0) * 0.005; clampCam(); }
  if (drag && Math.hypot(p.x - drag.x0, p.y - drag.y0) > 5) drag.moved = true;
});
view.addEventListener("pointerleave", () => { mouse.inside = false; });

// The cursor shows what a right-click would do: move, attack, chop, mine...
// Checked a few times a second, not on every mouse move (it raycasts).
let lastCursorCheck = 0, cursorCode = -1;
function updateHoverCursor(now) {
  if (now - lastCursorCheck < 90) return;
  lastCursorCheck = now;
  let code = 0;
  if (placing != null) code = -2;
  else if (amode) code = 2;
  else if (mouse.inside && !drag && !orbit) {
    const ids = myIds();
    if (ids.length) {
      const w = pickAt(mouse.x, mouse.y);
      if (w) code = intentAt(ids, w.x, w.y);
    }
  }
  if (code === cursorCode) return;
  cursorCode = code;
  view.style.cursor = code === -2 ? "crosshair" : CURSORS[code] || "default";
}
view.addEventListener("pointerup", e => {
  const p = localPos(e);
  if (touch) { if (!touch.moved) tap(p); touch = null; return; }
  if (orbit && e.button === 1) { orbit = null; return; }
  if (!drag || e.button !== 0) return;
  if (drag.moved) {
    boxSelect(drag.x0, drag.y0, p.x, p.y, drag.shift);
  } else {
    const now = performance.now();
    const dbl = now - lastClick.t < 320 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 8;
    lastClick = { t: now, x: p.x, y: p.y };
    const hit = pickAt(p.x, p.y);
    const id = hit ? W.select_at(hit.x, hit.y, drag.shift ? 1 : 0) : -1;
    if (!hit) W.clear_selection();
    if (dbl && id >= 0) {
      readWorld();
      const i = byId.get(id);
      if (i != null && E(i, F.owner) === ME) boxSelect(0, 0, view._w, view._h, false, E(i, F.kind));
    }
  }
  drag = null; readWorld(); selKey = "";
  if (selection().some(i => E(i, F.owner) === ME)) Sfx.ui("select");
});

function command(p) {
  const w = pickAt(p.x, p.y);
  if (w) rightClickAt(w);
}
function rightClickAt(w) {
  const ids = myIds();
  if (!ids.length) return;
  const what = intentAt(ids, w.x, w.y); // decided before the order changes anything
  issue({ c: 1, ids, x: w.x, y: w.y });
  if (what) { marker(w, what); Sfx.ui("command", what === 2 ? 2 : 1); }
}
// What a right-click would do there (see `intent` in lib.rs).
function intentAt(ids, x, y) {
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(mem.buffer);
  ids.slice(0, 60).forEach((id, n) => { buf[p + n] = id; });
  return W.intent(Math.min(ids.length, 60), x, y);
}
function marker(w, code) {
  const col = { 1: "#9cf27f", 2: "#ff6a50", 4: "#f2cd5c", 5: "#efe6d1" }[code] || "#f2cd5c";
  addMarker(w.x, w.y, col);
}
function tryPlace(p, keep) {
  const spot = placementSpot(p.x, p.y);
  if (!spot) return;
  if (!W.can_place(placing, spot.tx, spot.ty)) { toast(explain(12), "bad"); Sfx.ui("error"); return; }
  if (!canAfford(placing)) { toast(explain(1 + costOf(placing).findIndex((c, r) => W.stock(r) < c)), "bad"); Sfx.ui("error"); return; }
  const code = issue({ c: 6, ids: myIds(false), x: spot.tx, y: spot.ty, a: placing });
  if (code) { toast(explain(code), "bad"); Sfx.ui("error"); return; }
  Sfx.ui("place");
  if (!keep || !canAfford(placing)) { placing = null; updateCursor(); }
  selKey = "";
}
// Touch: tap your own things to select them; tap elsewhere to command.
function tap(p) {
  if (placing != null) { tryPlace(p, false); return; }
  if (amode) { const w = screenToGround(p.x, p.y); if (w) { issue({ c: 2, ids: myIds(false), x: w.x, y: w.y }); marker(w, 2); } setAmode(false); return; }
  const hit = pickAt(p.x, p.y);
  if (!hit) return;
  const own = hit.id != null && byId.has(hit.id) && E(byId.get(hit.id), F.owner) === ME;
  if (own || selection().filter(i => E(i, F.owner) === ME).length === 0) W.select_at(hit.x, hit.y, 0);
  else command(p);
  readWorld(); selKey = "";
}

view.addEventListener("wheel", e => {
  e.preventDefault();
  cam.dist *= Math.exp(e.deltaY * 0.0012);
  clampCam();
}, { passive: false });

let miniDrag = false;
function miniMove(e) {
  const r = mini.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * MW, y: ((e.clientY - r.top) / r.height) * MH };
}
mini.addEventListener("pointerdown", e => {
  if (!running) return;
  const w = miniMove(e);
  if (e.button === 2) { rightClickAt(w); return; }
  miniDrag = true; mini.setPointerCapture(e.pointerId); centerOn(w.x, w.y);
});
mini.addEventListener("pointermove", e => { if (miniDrag) { const w = miniMove(e); centerOn(w.x, w.y); } });
mini.addEventListener("pointerup", () => { miniDrag = false; });

// Camera keys are tracked by physical key (e.code), so WASD works on any
// keyboard layout. Everything else uses the character typed (e.key).
const SCROLL_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
window.addEventListener("keydown", e => {
  if (!running) return;
  if (SCROLL_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (e.key === "Escape" && !$("techScreen").hidden) { $("techScreen").hidden = true; return; }
  if (!$("loadScreen").hidden) { if (e.key === "Escape") closeLoadScreen(); return; }
  if (e.key === "Escape") { if (placing != null || amode) { placing = null; setAmode(false); } else { W.clear_selection(); selKey = ""; } return; }
  if (/^Digit[1-9]$/.test(e.code)) {
    const g = e.code.slice(5);
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      groups[g] = selection().filter(i => E(i, F.owner) === ME).map(i => E(i, F.id));
      toast(`Group ${g} set`);
    } else if (groups[g]) {
      const now = performance.now();
      if (groups._last === g && now - groups._t < 400) focusSelection();
      groups._last = g; groups._t = now;
      setSelection(groups[g]);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); if (!mp) saveGame(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "p") { if (!mp) togglePause(); return; }
  if (k === "k") { toggleTech(); return; }
  if (k === "m") { Sfx.setMuted(!Sfx.muted); syncSoundBtn(); return; }
  if (k === "h") { const i = findOwn(K.Capitol); if (i != null) { setSelection([E(i, F.id)]); centerOn(E(i, F.x), E(i, F.y)); } return; }
  if (k === "." || k === ",") { const id = W.idle_citizen(); if (id >= 0) { readWorld(); const i = byId.get(id); if (i != null) centerOn(E(i, F.x), E(i, F.y)); selKey = ""; } else toast("No idle citizens"); return; }
  if (k === " ") { e.preventDefault(); if (lastAlert && performance.now() - lastAlert.t < 15000) centerOn(lastAlert.x, lastAlert.y); else focusSelection(); return; }
  if (cmdKeys[k]) { cmdKeys[k](); e.preventDefault(); }
});
window.addEventListener("keyup", e => keys.delete(e.code));
window.addEventListener("blur", () => { keys.clear(); mouse.inside = false; });

function findOwn(kind) { for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === kind) return i; return null; }
function focusSelection() {
  const s = selection(); if (!s.length) return;
  let x = 0, y = 0; for (const i of s) { x += E(i, F.x); y += E(i, F.y); }
  centerOn(x / s.length, y / s.length);
}

// WASD / arrows / screen edges move the camera, relative to where it faces.
function scrollCamera(dt) {
  let dx = 0, dy = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) dx--;
  if (keys.has("ArrowRight") || keys.has("KeyD")) dx++;
  if (keys.has("ArrowUp") || keys.has("KeyW")) dy--;
  if (keys.has("ArrowDown") || keys.has("KeyS")) dy++;
  if (mouse.inside && !drag && !orbit && !touch && matchMedia("(pointer: fine)").matches) {
    const m = 12;
    if (mouse.x < m) dx--; if (mouse.x > view._w - m) dx++;
    if (mouse.y < m) dy--; if (mouse.y > view._h - m) dy++;
  }
  if (!dx && !dy) return;
  const v = cam.dist * 1.1 * dt, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
  cam.x += (dx * c + dy * s) * v;
  cam.y += (-dx * s + dy * c) * v;
  clampCam();
}

// ===========================================================================
// Events from the simulation. Numbers match `enum Ev` in game.rs.
const EV = { Alert: 1, Trained: 2, Built: 3, Lost: 4, Death: 5, Melee: 6, Shoot: 7, Work: 8, Hammer: 9, DropOff: 10, ArrowHit: 11, Starving: 12, WonderBegun: 13, Eliminated: 14 };
function handleEvents() {
  const n = W.take_events();
  if (!n) return;
  // Copy out: playing sounds reads fog memory, and wasm memory could move.
  const ev = f32(W.events_ptr(), n).slice();
  for (let j = 0; j < n; j += 4) {
    const type = ev[j], x = ev[j + 1], y = ev[j + 2], d = ev[j + 3];
    switch (type) {
      case EV.Alert:
        toast(d >= 10 ? `Your ${NAMES[d]} is under attack. Space to view.` : "Your people are under attack. Space to view.", "bad");
        lastAlert = { x, y, t: performance.now() };
        Sfx.ui("horn");
        break;
      case EV.Trained: Sfx.ui("trained"); break;
      case EV.Built: {
        // Say what this building unlocked, but only the first time.
        const opened = BUILD_MENU.map(([k]) => k).filter(k => W.unlocked(k) && !knownUnlocked.has(k));
        opened.forEach(k => knownUnlocked.add(k));
        toast(`${NAMES[d]} complete` + (opened.length ? `. You can now build: ${opened.map(k => NAMES[k]).join(", ")}` : ""), "good");
        Sfx.ui("built");
        break; }
      case EV.Lost: toast(`Your ${NAMES[d]} was destroyed`, "bad"); break;
      case EV.Death: { const kind = d % 100;
        if (kind >= 10) Sfx.at("crumble", x, y, 200);
        else Sfx.at("death", x, y, 90, kind === K.Horseman);
        break; }
      case EV.Melee: Sfx.at("melee", x, y, 45, d); break;
      case EV.Shoot: Sfx.at("bow", x, y, 60, d >= 10); break;
      case EV.ArrowHit: Sfx.at("arrowHit", x, y, 50, d === 1); break;
      case EV.Work: {
        const r = d % 4, farm = d >= 4;
        if (farm) Sfx.at("till", x, y, 120);
        else if (r === 1) Sfx.at("chop", x, y, 70);
        else if (r === 0) Sfx.at("forage", x, y, 120);
        else Sfx.at("mine", x, y, 80, r === 3);
        break; }
      case EV.Hammer: Sfx.at("hammer", x, y, 90); break;
      case EV.DropOff: Sfx.at("dropoff", x, y, 150, d); break;
      case EV.WonderBegun:
        if (d !== ME) { toast(`${PNAME[d]} has begun a Wonder! Destroy it before it's finished.`, "bad"); Sfx.ui("horn"); lastAlert = { x, y, t: performance.now() }; }
        else toast("Wonder begun. Put many citizens on it, and protect it.", "good");
        break;
      case EV.Eliminated:
        if (d !== ME) toast(`${PNAME[d]} has been eliminated.`, "good");
        break;
      case EV.Starving: toast("Your food has run out and your people are starving. Put more citizens on food.", "bad"); Sfx.ui("starving"); break;
    }
  }
}


// ===========================================================================
// Main loop: fixed 20 Hz simulation, render every animation frame.
let ME = 1;          // which player this computer controls (2 = multiplayer guest)
let mp = null;       // the Lockstep, while a multiplayer game runs
let simTick = 0;     // ticks run so far (multiplayer counts turns with it)
let stalledSince = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running) {
    scrollCamera(dt);
    if (mp) { if (!workerClock) stepMultiplayer(dt, now); /* else the worker clock steps it */ }
    else if (!paused) {
      acc += dt * 1000 * speed;
      let steps = 0;
      while (acc >= SIM_MS && steps < 8) { W.tick(); acc -= SIM_MS; steps++; }
      if (steps === 8) acc = 0;
      if (steps) handleEvents();
    }
    readWorld();
    if (frame % 3 === 0) updateFog();
    render3d(paused && !mp ? 1 : Math.min(1, acc / SIM_MS), now, dt);
    drawOverlay();
    updateHoverCursor(now);
    if (frame % 4 === 0) drawMinimap();
    if (frame % 6 === 0) { renderTopBar(); renderSelection(false); }
    if (W.state() !== 0) endGame();
    frame++;
  } else if (titleSpin) {
    // Slowly circle the town behind the title screen.
    cam.yaw += dt * 0.05;
    readWorld();
    render3d(1, now, dt);
  }
  requestAnimationFrame(loop);
}
let titleSpin = false;

// In multiplayer the game is stepped on its own clock, not on animation
// frames: a slow graphics card, or a tab in the background (where browsers
// all but stop animation frames), would otherwise slow down everyone. A tiny
// Web Worker keeps time (workers aren't throttled the way pages are), and
// animation frames only draw.
let bgLast = 0, workerClock = false;
try {
  const src = "setInterval(() => postMessage(0), 50);";
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  workerClock = true;
  worker.onmessage = () => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - (bgLast || now)) / 1000);
    bgLast = now;
    if (!running || !mp) return;
    for (const look of roomLookers) look();
    stepMultiplayer(dt, now);
    if (W.state() !== 0) endGame();
  };
} catch { /* no workers here: background tabs will just be slow */ }

// Multiplayer stepping: run ticks only as far as everyone's commands allow.
function stepMultiplayer(dt, now) {
  acc += dt * 1000;
  let steps = 0, stalled = false;
  while (acc >= SIM_MS && steps < 8) {
    if (simTick % NET.TURN_TICKS === 0) {
      const T = simTick / NET.TURN_TICKS;
      if (!mp.canRun(T)) { stalled = true; acc = Math.min(acc, SIM_MS); break; }
      mp.seal(T);
      mp.runTurn(T, (owner, c) => { const cmd = cleanCmd(c); if (cmd) applyCmd(owner, cmd); });
    }
    W.tick(); simTick++; acc -= SIM_MS; steps++;
    if (simTick % NET.TURN_TICKS === 0) mp.afterTurn(simTick / NET.TURN_TICKS - 1, W.checksum());
  }
  if (steps === 8) acc = 0;
  if (steps) handleEvents();
  if (stalled) {
    mp.keepAlive();
    if (!stalledSince) stalledSince = now;
  } else stalledSince = 0;
  // Say so if we've been waiting a while; give up if they're gone.
  const h = $("netWait");
  h.hidden = !(stalledSince && now - stalledSince > 700);
  if (!h.hidden) h.textContent = ME === 1 ? "Waiting for the other players…" : "Waiting for the host…";
  if (mp instanceof ClientSeq && now - mp.lastHeard > 15000) endMultiplayer("Lost contact with the host.");
  if (mp instanceof HostSeq) for (const s of mp.silent(20000)) dropPlayer(s);
}

// Start a game. Single player: `players` is you plus the computer opponents.
// Multiplayer: `local` is the slot this computer plays (1 is the host).
function newGame(seedArg, local = 0, players = opponents + 1) {
  seed = seedArg ?? ((Math.random() * 1e9) >>> 0);
  W.init(seed, difficulty, players);
  if (local) W.setup_multiplayer(local);
  enterWorld(local);
}

// Set the page up for whatever game the wasm side now holds: a new one, or
// one just loaded from a save.
function enterWorld(local = 0) {
  ME = W.local_player();
  simTick = 0; stalledSince = 0; spectating = false;
  bakeTerrain();
  buildWorld();
  updateFog();
  readWorld();
  resizeView();
  R3.ghostKind = -1;
  const i = findOwn(K.Capitol);
  cam.dist = 24; cam.pitch = 0.95; cam.yaw = 0;
  if (i != null) centerOn(E(i, F.x), E(i, F.y));
  groups = {}; placing = null; amode = false; updateCursor();
  paused = false; $("pauseBtn").setAttribute("aria-pressed", "false"); $("pauseBtn").textContent = "Pause";
  knownUnlocked = new Set(BUILD_MENU.map(([k]) => k).filter(k => W.unlocked(k)));
  acc = 0; selKey = ""; titleSpin = false; topBar = null; $("techScreen").hidden = true;
  // No pausing or speeding up a game other people are playing too.
  $("pauseBtn").hidden = !!local; $("speedBtn").hidden = !!local; $("restartBtn").hidden = !!local;
  $("quitBtn").textContent = local ? "Leave game" : "New game";
  if (local) speed = 1;
  renderTopBar(); renderSelection(true);
}

let spectating = false;
function endGame() {
  const st = W.state();
  // Out of the running, but others play on (multiplayer): watch, or leave.
  if (st === 5) {
    if (mp && !spectating) {
      spectating = true;
      toast("Your Capitol has fallen. You can keep watching, or leave from the menu.", "bad");
      Sfx.ui("fanfare", false);
    }
    if (mp) return;
  }
  running = false;
  const won = st === 1 || st === 3;
  $("endTitle").textContent = won ? "Victory" : "Defeat";
  const winner = PNAME[W.winner_player()] || "Someone";
  $("endWhy").textContent = {
    1: "All your rivals have fallen.",
    2: `${winner} has conquered the land.`,
    3: "Your Wonder stands complete. Your people will be remembered.",
    4: `${winner} finished a Wonder.`,
    5: "Your Capitol has fallen.",
  }[st];
  Sfx.ui("fanfare", won);
  showEndStats();
  if (mp) leaveMultiplayer();
}
function showEndStats() {
  const ps = [...Array(W.n_players())].map((_, i) => i + 1);
  const head = ps.map(p => `<th style="color:${PLIGHT[p]}">${p === ME ? "You" : PNAME[p]}</th>`).join("");
  const row = (label, f) => `<tr><th>${label}</th>${ps.map(p => `<td>${f(p)}</td>`).join("")}</tr>`;
  $("endStats").innerHTML = `<tr><th></th>${head}</tr>` +
    row("Units trained", p => W.player_stat(p, 0)) +
    row("Units and buildings lost", p => W.player_stat(p, 1)) +
    row("Resources gathered", p => Math.floor(W.player_stat(p, 2))) +
    `<tr><th>Game time</th><td colspan="${ps.length}">${fmtTime(W.game_time())}</td></tr>`;
  $("againBtn").textContent = mp || lastWasMultiplayer ? "Back to menu" : "Play again";
  $("endScreen").hidden = false;
}

function togglePause() {
  if (mp) return;
  paused = !paused;
  $("pauseBtn").setAttribute("aria-pressed", String(paused));
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
}

// The connection status line: what claude.ai's room says right now. Helps
// tell "blocked by the browser" from "not invited" from "nobody else here".
function renderNetStatus() {
  const el = $("netStatus");
  if (!el || $("startScreen").hidden) return;
  const d = Net.diag;
  if (!d.onClaude) { el.textContent = "Online: through a relay server (this copy isn't on claude.ai)."; return; }
  let t = `Online: ${d.room}`;
  if (Net.room) {
    const c = Net.room.connected ? Net.room.connected() : null;
    t += c === true ? ", connected" : c === false ? ", not connected yet" : "";
    if (lobby && lobby.count) t += ` · ${lobby.count()} other ${lobby.count() === 1 ? "person" : "people"} on this page`;
  }
  if (d.errors.length) t += ` · problems: ${d.errors.join("; ")}`;
  el.textContent = t;
}

// ===========================================================================
// Multiplayer lobby. The host gets a code, friends join it, the host picks
// how many computer players to add and starts. Up to 4 players in all.
let lobby = null, gameNet = null, lastWasMultiplayer = false, startTimer = 0;
let hosting = null;   // while hosting: { code, seed, guests: Map(token -> first seen) }
const myToken = Math.random().toString(36).slice(2, 10); // who I am in a game room
const mpStatus = (text, bad = false) => { const s = $("mpStatus"); s.textContent = text; s.classList.toggle("bad", bad); };
const randomCode = () => Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const okToken = t => typeof t === "string" && /^[a-z0-9]{4,12}$/.test(t);

async function connectLobby() {
  if (lobby) return lobby;
  const relay = $("relayUrl").value.trim();
  await Net.init(relay);
  lobby = await Net.lobby();
  // Hosts advertise their game in the lobby; show them as one-click joins.
  lobby.onPeers(peers => {
    const box = $("openGames");
    box.replaceChildren();
    for (const p of peers) {
      const code = p.presence && p.presence.hosting;
      if (typeof code !== "string" || !/^[A-Z0-9]{4}$/.test(code) || p.presence.v !== NET.PROTOCOL) continue;
      const b = document.createElement("button");
      b.className = "ghost"; b.textContent = `Join game ${code}`;
      b.onclick = () => joinGame(code);
      box.append(b);
    }
  });
  return lobby;
}

// The host's view of who has joined, and the Start button.
function renderHostPanel() {
  const panel = $("hostPanel");
  panel.hidden = !hosting;
  if (!hosting) return;
  const guests = [...hosting.guests.keys()].slice(0, 3);
  const ais = Math.min(+$("aiFill").value, 3 - guests.length);
  const slots = [`<li style="color:${PLIGHT[1]}">Blue: you</li>`];
  guests.forEach((_, i) => slots.push(`<li style="color:${PLIGHT[i + 2]}">${PNAME[i + 2]}: a friend</li>`));
  for (let k = 0; k < ais; k++) { const s = guests.length + 2 + k; slots.push(`<li style="color:${PLIGHT[s]}">${PNAME[s]}: computer</li>`); }
  $("lobbyPlayers").innerHTML = slots.join("");
  // How many others the room says are here at all: tells "nobody's
  // connected" apart from "they're here but not joining as players".
  const inRoom = gameNet && gameNet.count ? gameNet.count() : null;
  $("roomCount").textContent = inRoom === null ? "" : `${inRoom} other ${inRoom === 1 ? "person" : "people"} in this game's room.`;
  $("mpStartBtn").disabled = guests.length === 0;
  $("mpStartBtn").textContent = guests.length ? `Start game (${1 + guests.length + ais} players)` : "Waiting for friends to join…";
}

async function hostGame() {
  try {
    leaveMultiplayer();
    await connectLobby();
    const code = randomCode();
    gameNet = await Net.game(code);
    hosting = { code, seed: (Math.random() * 1e9) >>> 0, guests: new Map() };
    gameNet.presence({ role: "host", v: NET.PROTOCOL, token: myToken });
    lobby.presence({ hosting: code, v: NET.PROTOCOL });
    $("hostCode").textContent = code; $("hostCode").hidden = false; $("copyCode").hidden = false;
    mpStatus(`Hosting game ${code}. Friends open this page and join it.`);
    gameNet.onPeers(peers => {
      const here = new Set();
      for (const p of peers) {
        const pr = p.presence || {};
        if (pr.role !== "guest" || pr.v !== NET.PROTOCOL || !okToken(pr.token)) continue;
        here.add(pr.token);
        if (hosting && !hosting.guests.has(pr.token) && !mp) hosting.guests.set(pr.token, performance.now());
      }
      if (hosting && !mp) for (const t of hosting.guests.keys()) if (!here.has(t)) hosting.guests.delete(t);
      // During the game: anyone who has left is handed to the computer.
      if (mp instanceof HostSeq) for (const [slot, t] of mp.tokens) if (!here.has(t)) dropPlayer(slot);
      renderHostPanel();
    });
    renderHostPanel();
  } catch (e) { mpStatus(String(e.message || e), true); }
}

function hostStart() {
  if (!hosting || mp) return;
  const tokens = [...hosting.guests.keys()].slice(0, 3);
  if (!tokens.length) return;
  const ais = Math.min(+$("aiFill").value, 3 - tokens.length);
  const n = 1 + tokens.length + ais;
  const slots = Object.fromEntries(tokens.map((t, i) => [t, i + 2]));
  const aiSlots = [...Array(ais)].map((_, k) => tokens.length + 2 + k);
  const settings = { v: NET.PROTOCOL, seed: hosting.seed, n, slots, ai: aiSlots, diff: difficulty, host: myToken };
  // Keep telling the guests until all of them have answered.
  const send = () => gameNet && gameNet.emit("start", settings);
  send();
  startTimer = setInterval(() => {
    if (!(mp instanceof HostSeq)) return clearInterval(startTimer);
    const waiting = [...mp.active].some(s => mp.ack.get(s) < NET.DELAY);
    if (waiting) send(); else clearInterval(startTimer);
  }, 400);
  lobby && lobby.presence({ hosting: null });
  startMultiplayer(1, settings, new HostSeq(gameNet, Object.entries(slots).map(([t, s]) => [s, t]), endMultiplayer));
}

async function joinGame(code) {
  code = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { mpStatus("A game code is 4 letters or digits.", true); return; }
  try {
    leaveMultiplayer();
    await connectLobby();
    gameNet = await Net.game(code);
    gameNet.presence({ role: "guest", v: NET.PROTOCOL, token: myToken });
    mpStatus(`Joined game ${code}. Waiting for the host to start…`);
    let hostToken = null;
    gameNet.on("start", d => {
      if (mp || !d || d.v !== NET.PROTOCOL || typeof d.seed !== "number" || !d.slots) return;
      const slot = d.slots[myToken];
      if (typeof slot !== "number") { mpStatus("That game started without you.", true); return; }
      hostToken = d.host;
      startMultiplayer(slot, d, new ClientSeq(gameNet, slot, myToken, endMultiplayer));
    });
    gameNet.onPeers(peers => {
      const hostHere = peers.some(p => p.presence && p.presence.role === "host" && (!hostToken || p.presence.token === hostToken));
      if (mp && !hostHere) endMultiplayer("The host left the game.");
    });
  } catch (e) { mpStatus(String(e.message || e), true); }
}

function startMultiplayer(me, d, seq) {
  const n = Math.max(2, Math.min(4, d.n | 0));
  difficulty = [0, 1, 2].includes(d.diff) ? d.diff : 1;
  newGame(d.seed >>> 0, me, n);
  for (const s of Array.isArray(d.ai) ? d.ai : []) W.set_ai(s, 1);
  mp = seq;
  // Building the map can take a few seconds on a slow computer: only start
  // the "haven't heard from you" clocks once we're ready to play.
  mp.lastHeard = performance.now();
  if (mp.heard) for (const s of mp.heard.keys()) mp.heard.set(s, performance.now());
  lastWasMultiplayer = true;
  hosting = null; renderHostPanel();
  $("startScreen").hidden = true;
  running = true;
  toast(`You are ${PNAME[me]}. ${n} players.`, "good");
}

// A guest left: the computer takes over their people (in the next frame).
function dropPlayer(slot) {
  if (!(mp instanceof HostSeq) || !mp.active.has(slot)) return;
  mp.drop(slot);
}

function endMultiplayer(reason) {
  if (!mp) return;
  running = false;
  $("endTitle").textContent = "Game over";
  $("endWhy").textContent = reason;
  showEndStats();
  leaveMultiplayer();
}

function leaveMultiplayer() {
  clearInterval(startTimer);
  if (gameNet) gameNet.leave();
  gameNet = null; mp = null; hosting = null;
  renderHostPanel();
  $("netWait").hidden = true;
  $("hostCode").hidden = true; $("copyCode").hidden = true;
  if (lobby) lobby.presence({ hosting: null });
}

// ===========================================================================
// Saving and loading (single player)
//
// The Rust side turns the whole game into bytes (src/save.rs). Here we wrap
// those bytes in a small JSON envelope with what the page needs on top
// (camera, control groups, a description for the list), gzip them where the
// browser can, and keep them in localStorage or a downloaded file.
const SAVE_KEY = "vibecraft.saves", SAVE_MAX = 8, SAVE_FORMAT = 1;

function readSaves() {
  try { const v = JSON.parse(localStorage.getItem(SAVE_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
// Newest first. If the browser is out of room, drop the oldest and try again.
function writeSaves(list) {
  for (let keep = list.length; keep >= 1; keep--) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(list.slice(0, keep))); return keep; }
    catch { /* quota (or storage blocked): try with fewer */ }
  }
  return 0;
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function makeSave() {
  const n = W.save_game();
  let bytes = u8(W.save_ptr(), n).slice(), z = false;
  if (window.CompressionStream) {
    try { bytes = await pipeBytes(bytes, new CompressionStream("gzip")); z = true; } catch { /* keep it raw */ }
  }
  const players = W.n_players();
  return {
    format: SAVE_FORMAT, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    saved: Date.now(), time: W.game_time(), players, difficulty: W.game_difficulty(),
    cam: { x: cam.x, y: cam.y, dist: cam.dist, pitch: cam.pitch, yaw: cam.yaw },
    groups: Object.fromEntries(Object.entries(groups).filter(([g]) => /^[1-9]$/.test(g))),
    z, data: toB64(bytes),
  };
}

let saving = false;
async function saveGame() {
  if (mp || !running || saving || W.state() !== 0) return;
  saving = true;
  try {
    const save = await makeSave();
    const list = readSaves();
    list.unshift(save);
    const kept = writeSaves(list.slice(0, SAVE_MAX));
    if (kept) toast(`Game saved (${fmtTime(save.time)})` + (kept < Math.min(list.length, SAVE_MAX) ? ". Older saves were removed to make room." : ""));
    else { toast("This browser won't store the save. Downloading it instead.", "bad"); downloadSave(save); }
  } catch (err) {
    toast("Couldn't save the game.", "bad");
  } finally { saving = false; }
}

function downloadSave(save) {
  const d = new Date(save.saved), pad = v => String(v).padStart(2, "0");
  const name = `vibecraft-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.vibecraft`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(save)], { type: "application/json" }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function loadSave(save) {
  if (!save || save.format !== SAVE_FORMAT || typeof save.data !== "string") throw new Error("not a save");
  let bytes = fromB64(save.data);
  if (save.z) {
    if (!window.DecompressionStream) { toast("This browser can't open compressed saves.", "bad"); return; }
    bytes = await pipeBytes(bytes, new DecompressionStream("gzip"));
  }
  leaveMultiplayer(); lastWasMultiplayer = false;
  u8(W.load_buffer(bytes.length), bytes.length).set(bytes);
  if (!W.load_game(bytes.length)) { toast("That save is damaged, or from another version of the game.", "bad"); return; }
  seed = W.game_seed(); difficulty = W.game_difficulty();
  enterWorld(0);
  if (save.cam) { Object.assign(cam, save.cam); clampCam(); }
  if (save.groups) groups = save.groups;
  for (const id of ["loadScreen", "menuScreen", "startScreen", "endScreen"]) $(id).hidden = true;
  running = true;
  toast(`Loaded: ${fmtTime(W.game_time())} into the game`);
}

let loadReturn = "menuScreen";
function openLoadScreen(from) {
  loadReturn = from;
  $(from).hidden = true;
  renderSaveList();
  $("loadScreen").hidden = false;
}
function closeLoadScreen() {
  $("loadScreen").hidden = true;
  $(loadReturn).hidden = false;
}
function renderSaveList() {
  const ul = $("saveList"), list = readSaves();
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li"); li.className = "empty";
    li.textContent = "No saved games in this browser yet. Save from the Menu during a game, or press Ctrl+S.";
    ul.append(li);
    return;
  }
  const DIFF = ["Easy", "Normal", "Hard"];
  for (const save of list) {
    const li = document.createElement("li");
    const what = document.createElement("div"); what.className = "what";
    const when = new Date(save.saved);
    const title = document.createElement("b");
    title.textContent = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const sub = document.createElement("small");
    const opp = (save.players || 2) - 1;
    sub.textContent = `${fmtTime(save.time || 0)} played · ${opp} opponent${opp === 1 ? "" : "s"} · ${DIFF[save.difficulty] ?? "Normal"}`;
    what.append(title, sub);
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.className = cls; b.textContent = label; b.onclick = fn; return b; };
    li.append(what,
      btn("Load", "go", () => loadSave(save).catch(() => toast("That save couldn't be read.", "bad"))),
      btn("Download", "ghost", () => downloadSave(save)),
      btn("Delete", "ghost", e => {
        // Two clicks, so a slip doesn't lose a game.
        if (e.target.dataset.sure) { writeSaves(readSaves().filter(s => s.id !== save.id)); renderSaveList(); }
        else { e.target.dataset.sure = "1"; e.target.textContent = "Really delete?"; }
      }));
    ul.append(li);
  }
}

// ---- buttons ----
// Browsers only allow audio after the player interacts with the page.
window.addEventListener("pointerdown", () => Sfx.init(), { capture: true });
window.addEventListener("keydown", () => Sfx.init(), { capture: true });
function syncSoundBtn() { const b = $("soundBtn"); b.textContent = Sfx.muted ? "Sound off" : "Sound on"; }
$("soundBtn").onclick = () => { Sfx.setMuted(!Sfx.muted); syncSoundBtn(); };
syncSoundBtn();
$("diff").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  difficulty = +b.dataset.d;
  for (const x of $("diff").children) x.setAttribute("aria-pressed", String(x === b));
});
const toMenu = () => { leaveMultiplayer(); lastWasMultiplayer = false; running = false; titleSpin = true; $("endScreen").hidden = true; $("menuScreen").hidden = true; $("startScreen").hidden = false; mpStatus(""); };
$("startBtn").onclick = () => { leaveMultiplayer(); lastWasMultiplayer = false; $("startScreen").hidden = true; newGame(); running = true; };
$("againBtn").onclick = () => { if (lastWasMultiplayer) return toMenu(); $("endScreen").hidden = true; newGame(); running = true; };
$("toMenuBtn").onclick = toMenu;
$("pauseBtn").onclick = togglePause;
$("speedBtn").onclick = () => { speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; $("speedBtn").textContent = `${speed}×`; };
$("menuBtn").onclick = () => { if (!running) return; if (!paused && !mp) togglePause(); $("saveBtn").hidden = $("menuLoadBtn").hidden = !!mp; $("menuScreen").hidden = false; };
$("saveBtn").onclick = () => saveGame();
$("menuLoadBtn").onclick = () => openLoadScreen("menuScreen");
$("startLoadBtn").onclick = () => openLoadScreen("startScreen");
$("loadClose").onclick = () => closeLoadScreen();
$("loadFileBtn").onclick = () => $("loadFile").click();
$("loadFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { await loadSave(JSON.parse(await f.text())); }
  catch { toast("That file isn't a VibeCraft save.", "bad"); }
};
$("resumeBtn").onclick = () => { $("menuScreen").hidden = true; if (paused) togglePause(); };
$("restartBtn").onclick = () => { $("menuScreen").hidden = true; newGame(); };
$("quitBtn").onclick = toMenu;
$("hostBtn").onclick = hostGame;
$("mpStartBtn").onclick = hostStart;
// Copy the game code. Some app views refuse the clipboard: then select the
// code so it can be copied by hand.
$("copyCode").onclick = () => {
  const code = $("hostCode").textContent, btn = $("copyCode");
  const selectIt = () => { const r = document.createRange(); r.selectNodeContents($("hostCode")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "Press Ctrl+C"; };
  try {
    navigator.clipboard.writeText(code).then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy code"; }, 1500); }, selectIt);
  } catch { selectIt(); }
};
$("aiFill").onchange = renderHostPanel;
$("opp").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  opponents = +b.dataset.n;
  for (const x of $("opp").children) x.setAttribute("aria-pressed", String(x === b));
});
$("joinBtn").onclick = () => joinGame($("joinCode").value);
$("joinCode").addEventListener("keydown", e => { if (e.key === "Enter") joinGame($("joinCode").value); });
$("techClose").onclick = () => { $("techScreen").hidden = true; };

// ---- start ----
(async () => {
  if (!window.THREE) {
    document.body.insertAdjacentHTML("beforeend", '<div class="overlay"><div class="card"><h1>Can\'t load 3D</h1><p class="note">The 3D library (three.js) didn\'t load. It comes from cdn.jsdelivr.net, so check your internet connection and reload.</p></div></div>');
    return;
  }
  await loadWasm();
  initRenderer();
  resizeView();
  // A live map behind the title screen.
  newGame();
  running = false; titleSpin = true;
  requestAnimationFrame(loop);
  // On claude.ai the page can talk to other viewers directly. Elsewhere (your
  // own copy) multiplayer goes through a relay server you run: show its address.
  const onClaude = !!(window.claude && window.claude.use);
  setInterval(renderNetStatus, 1000);
  // Served from a web server, assume the relay sits next to the page at ./relay.
  if (!onClaude && /^https?:$/.test(location.protocol))
    $("relayUrl").value = new URL("relay", location.href).href.replace(/^http/, "ws");
  const hasRoom = await Net.init($("relayUrl").value.trim());
  // The relay is only for copies you run yourself. On claude.ai the page
  // can't open other connections anyway, so don't offer it there.
  $("relayRow").hidden = hasRoom || onClaude;
  if (hasRoom) connectLobby().catch(() => {});
  else if (onClaude) {
    $("hostBtn").disabled = $("joinBtn").disabled = true;
    mpStatus(Net.diag.room === "no answer from claude.ai"
      ? "Online play can't reach claude.ai from this page. Your browser may be blocking it: in Firefox, turn off Enhanced Tracking Protection for this site (the shield in the address bar), or pause your ad blocker here, then reload."
      : "Online play isn't available in this view. You need to be signed in to claude.ai and invited to this game (the owner adds you with Share).", true);
  }
})();
