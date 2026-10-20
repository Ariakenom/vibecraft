"use strict";
const WASM_B64 = "/*WASM_BASE64*/";

// ===========================================================================
// Constants shared with the Rust side
const ENT_STRIDE = 18;
const TILE = 32; // pixels per tile in the baked terrain texture
const SIM_MS = 50;
// Units are kinds 0–63, buildings 64 and up (defs.rs).
const K = { Citizen: 0, Spearman: 1, Archer: 2, Horseman: 3, Capitol: 64, Barracks: 65, Range: 66, Stable: 67, Tower: 68, Farm: 69,
  LumberCamp: 70, Quarry: 71, FishingHut: 72, HuntingLodge: 73, Orchard: 74, Pasture: 75, Wonder: 76 };
const isBld = k => k >= 64;
const NAMES = { [K.Citizen]: "Citizen", [K.Spearman]: "Spearman", [K.Archer]: "Archer", [K.Horseman]: "Horseman", [K.Capitol]: "Capitol", [K.Barracks]: "Barracks",
  [K.Range]: "Archery Range", [K.Stable]: "Stable", [K.Tower]: "Watch Tower", [K.Farm]: "Farm", [K.LumberCamp]: "Lumber Camp", [K.Quarry]: "Quarry",
  [K.FishingHut]: "Fishing Hut", [K.HuntingLodge]: "Hunting Lodge", [K.Orchard]: "Orchard", [K.Pasture]: "Pasture", [K.Wonder]: "Wonder" };
const DESC = {
  [K.Citizen]: "Constructs buildings.",
  [K.Spearman]: "Sturdy infantry. Deals heavy damage to horsemen.",
  [K.Archer]: "Fires from range. Strong against spearmen, weak against horsemen.",
  [K.Horseman]: "Fast cavalry. Runs down archers.",
  [K.Capitol]: "Your seat of power. Lose it and you lose the game.",
  [K.Barracks]: "Trains spearmen.",
  [K.Range]: "Trains archers.",
  [K.Stable]: "Trains horsemen.",
  [K.Tower]: "Shoots at enemies in range.",
  [K.Farm]: "Grows grain anywhere on open ground.",
  [K.LumberCamp]: "Cuts wood from a forest next to it. Costs nothing, so you can always get more wood.",
  [K.Quarry]: "Cuts stone from rock next to it.",
  [K.FishingHut]: "Catches fish from the water next to it.",
  [K.HuntingLodge]: "Hunts the game grazing next to it.",
  [K.Orchard]: "Picks fruit from the wild bushes next to it.",
  [K.Pasture]: "Breeds horses from the wild herd next to it.",
  [K.Wonder]: "Finish it and you win. A huge job: put many citizens on it, and defend it.",
};
// The tech tree, grouped into eras. Your era is the latest one you've built
// something from. (Requirements themselves live in Rust: Kind::requires.)
const ERAS = [
  { name: "Village", kinds: [K.Farm, K.LumberCamp, K.Quarry, K.Barracks] },
  { name: "Town", kinds: [K.FishingHut, K.HuntingLodge, K.Orchard, K.Pasture, K.Range] },
  { name: "City", kinds: [K.Stable, K.Tower] },
  { name: "Empire", kinds: [K.Wonder] },
];
// Resources, in the order of `enum Res` in defs.rs.
const RES_NAMES = ["wood", "stone", "grain", "fish", "meat", "fruit", "horses", "wool", "iron", "brick", "bread", "clothes", "beer", "nitrate",
  "gunpowder", "furniture", "books", "circus shows", "coal", "steel", "explosives", "canned food", "heating", "newspapers", "electricity", "oil",
  "aluminum", "radios", "uranium", "cars", "TVs"];
const R = { wood: 0, stone: 1, grain: 2, fish: 3, meat: 4, fruit: 5, horses: 6 };
// What an extractor has to stand next to, in the order of `enum Dep`.
const DEP_NAMES = ["wild fruit bushes", "a forest", "rock", "wild horses", "game", "water"];
const ORDER_TEXT = ["Idle", "Moving", "Attack-moving", "Fighting", "", "", "Building"];
// Player colours: 0 is nature, then blue, red, green, gold.
const PCOL = ["#999", "#3f86e0", "#d2452f", "#3fae5a", "#e0b23a"];
const PDARK = ["#555", "#1f4f8f", "#7f2216", "#1f6b33", "#8c6a12"];
const PLIGHT = ["#bbb", "#8cb9f0", "#ec8a77", "#86d69a", "#f2d27f"];
const PNAME = ["Nature", "Blue", "Red", "Green", "Gold"];
// Hotkeys avoid W, A, S and D, which move the camera.
const BUILD_MENU = [[K.Farm, "Q"], [K.LumberCamp, "E"], [K.Quarry, "R"], [K.FishingHut, "T"], [K.HuntingLodge, "Y"], [K.Orchard, "U"],
  [K.Pasture, "I"], [K.Barracks, "O"], [K.Range, "F"], [K.Stable, "G"], [K.Tower, "C"], [K.Wonder, "B"]];
const TRAIN_KEYS = "QERT";
const TRAINS = { [K.Capitol]: [K.Citizen], [K.Barracks]: [K.Spearman], [K.Range]: [K.Archer], [K.Stable]: [K.Horseman] };

// Small icons for the resources. Later eras' resources get a lettered disc until they have their own.
const RES_ICON = [
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="5" width="11" height="6.5" rx="1" fill="#8a5a33"/><ellipse cx="12.5" cy="8.25" rx="2.2" ry="3.25" fill="#c8995f"/><ellipse cx="12.5" cy="8.25" rx="1" ry="1.5" fill="#8a5a33"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 12l2-6 4-3 5 2 1 6-4 3H5z" fill="#9b958a"/><path d="M4 6l4-3 5 2-4 2z" fill="#c7c2b8"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 15V5" stroke="#b58f3c" stroke-width="1.3"/><g fill="#e2bd5a"><ellipse cx="8" cy="3" rx="1.3" ry="2.2"/><ellipse cx="6" cy="6" rx="1.2" ry="2" transform="rotate(-30 6 6)"/><ellipse cx="10" cy="6" rx="1.2" ry="2" transform="rotate(30 10 6)"/><ellipse cx="6.2" cy="9.4" rx="1.2" ry="2" transform="rotate(-30 6.2 9.4)"/><ellipse cx="9.8" cy="9.4" rx="1.2" ry="2" transform="rotate(30 9.8 9.4)"/></g></svg>',
  '<svg viewBox="0 0 16 16"><path d="M2 8c2.5-3.5 7-3.5 9.5 0-2.5 3.5-7 3.5-9.5 0z" fill="#7fa6bf"/><path d="M11 8l3.5-3v6z" fill="#5f87a0"/><circle cx="5" cy="7.3" r=".8" fill="#1d2a33"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M3 9c0-3.5 3-6 6.5-5.5S14 8 12.5 11 6 14 4.2 12.3C3.4 11.6 3 10.4 3 9z" fill="#b8473a"/><path d="M9 7.5c1.2 0 2 .8 2 1.8s-.8 1.7-2 1.7-2-.7-2-1.7.8-1.8 2-1.8z" fill="#ead2b5"/><path d="M2.5 13.5l2-2" stroke="#ead2b5" stroke-width="1.6" stroke-linecap="round"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M8 4.2c2.6-1.6 6 .2 6 4 0 3.4-2.7 6.6-6 6.6S2 11.6 2 8.2c0-3.8 3.4-5.6 6-4z" fill="#c9473a"/><path d="M8 4.5C8 2.8 9 1.6 10.6 1.2" stroke="#6fa046" stroke-width="1.5" fill="none"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M4 14l.6-5.5C3.5 7 3.6 4.6 5.5 3.3L7 1.5l.6 2c2.6.3 5.1 2.4 6 5.4l-1.7.8-2.2-1.4-.2 5.7z" fill="#8a5a33"/><path d="M7 1.5l.6 2-1.2 2.6-1.5-1.3z" fill="#3b2618"/><circle cx="9.6" cy="5.6" r=".7" fill="#1d1208"/></svg>',
];
const resIcon = r => RES_ICON[r] || `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#6d6455"/><text x="8" y="11" text-anchor="middle" font-size="8" fill="#efe6d1" font-family="sans-serif">${RES_NAMES[r][0].toUpperCase()}</text></svg>`;

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
  // 4 build: a hammer
  4: svgCursor(`${handle("13 13l14 14")}<path d="M3 10l7-7 9 9-7 7z" fill="#9da3ab" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 6, 6),
  // 5 rally point: a flag
  5: svgCursor(`<path d="M6 30V3" stroke="${DK}" stroke-width="4" stroke-linecap="round"/><path d="M6 30V3" stroke="#d9c9a8" stroke-width="2"/>
    <path d="M7 4l17 5-17 6z" fill="#3f86e0" stroke="${DK}" stroke-width="1.6" stroke-linejoin="round"/>`, 6, 30),
};

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
let difficulty = 1, seed = 1;
// The camera looks at map point (x, y) from `dist` away, tilted down by `pitch`,
// turned by `yaw` (middle-drag rotates).
let cam = { x: 40, y: 40, dist: 24, pitch: 0.95, yaw: 0 };
let paused = false, speed = 1, running = false;
let acc = 0, last = performance.now(), simTime = 0;
let ents = new Float32Array(0), entCount = 0;
// Entity id -> its row in `ents` this frame. Like a Map, but emptying it is
// just bumping `gen` (a Map's clear() makes garbage every frame).
const byId = {
  row: new Int32Array(1024), stamp: new Int32Array(1024), gen: 1,
  reset() { this.gen++; },
  set(id, i) {
    if (id >= this.row.length) {
      const n = Math.max(id + 1, this.row.length * 2), row = new Int32Array(n), stamp = new Int32Array(n);
      row.set(this.row); stamp.set(this.stamp); this.row = row; this.stamp = stamp;
    }
    this.row[id] = i; this.stamp[id] = this.gen;
  },
  get(id) { return id >= 0 && id < this.row.length && this.stamp[id] === this.gen ? this.row[id] : undefined; },
  has(id) { return this.get(id) !== undefined; },
};
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
// A kind's slot lists as [[resource, amount], ...]: which 0 cost, 1 makes, 2 consumes.
function slotsOf(k, which = 0) { const out = []; for (let n = 0; n < W.kind_slots_n(k, which); n++) out.push([W.kind_slots_res(k, which, n), W.kind_slots_amt(k, which, n)]); return out; }
function stat(k, i) { return W.kind_stat(k, i); }
function free(r) { return W.supply(r) - W.used(r); }
function canAfford(k) { return W.short_of(k) < 0; }
// The building that makes each resource (for "build a lumber camp" hints).
let PRODUCER = null;
function producerOf(r) {
  if (!PRODUCER) { PRODUCER = {}; for (const k of Object.values(K)) for (const [p] of slotsOf(k, 1)) if (k !== K.Capitol && PRODUCER[p] == null) PRODUCER[p] = k; }
  return PRODUCER[r];
}
// "2 Spearmen", "1 Barracks", "3 Lumber Camps".
function plural(k, n) {
  const name = NAMES[k];
  if (n === 1 || name.endsWith("s")) return `${n} ${name}`;
  return `${n} ${name.endsWith("man") ? name.slice(0, -3) + "men" : name + "s"}`;
}
function slotsHtml(list, mark = true) {
  return list.map(([r, c]) => `<span class="${mark && free(r) < c ? "short" : ""}" title="${RES_NAMES[r]}">${resIcon(r)}${c}</span>`).join("");
}
function costHtml(k) {
  const c = slotsOf(k);
  return '<div class="cost">' + (c.length ? slotsHtml(c) : '<span class="free">free</span>') + "</div>";
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
  // A clean, almost flat green, like Totally Accurate Battle Simulator's fields:
  // only broad, gentle patches. Small 3D pieces (grass clumps, flowers,
  // pebbles; render3d.js) give the detail instead of painted strokes.
  const LUSH = [90, 156, 62], DARK = [76, 138, 54], DRY = [118, 156, 66], EARTH = [130, 112, 78], ROCK = [138, 132, 118], SAND = [204, 186, 132], SEABED = [120, 132, 96];
  // `beach`: paint the sand in. The 3D view draws its own crisp beaches in
  // the ground shader (render3d.js), so only the minimap wants it.
  const colourAt = (x, y, beach = true) => {
    const t = ter[Math.min(MH - 1, y | 0) * MW + Math.min(MW - 1, x | 0)];
    const n1 = vnoise(x / 9, y / 9, 3), n2 = vnoise(x / 3.5, y / 3.5, 11), n3 = vnoise(x * 1.3, y * 1.3, 29);
    let c = mixc(LUSH, DARK, Math.max(0, Math.min(1, (n1 - 0.45) * 2.0)));
    c = mixc(c, DRY, Math.max(0, Math.min(1, (n2 - 0.66) * 2)) * 0.6);
    const sl = slopeAt(x, y), ht = hAt(x, y);
    c = mixc(c, EARTH, Math.max(0, Math.min(1, (sl - 0.18) * 4)));
    c = mixc(c, ROCK, Math.max(0, Math.min(1, (sl - 0.38) * 4)));
    c = mixc(c, [c[0] * 1.08, c[1] * 1.05, c[2] * 0.95], Math.max(0, Math.min(1, ht - 0.8))); // sunnier up high
    // Beaches follow the (smooth) height near the water, not the square tiles.
    if (beach) c = mixc(c, SAND, Math.max(0, Math.min(1, (0.2 - ht) / 0.14)) * 0.9);
    if (t === 1) c = mixc(SAND, SEABED, Math.min(1, -ht));
    const k = 0.98 + n3 * 0.04;
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
    const c = colourAt((px + 0.5) / MID, (py + 0.5) / MID, false);
    mi.data.set([c[0], c[1], c[2], 255], (py * mid.width + px) * 4);
  }
  mc.putImageData(mi, 0, 0);
  terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = MW * TILE; terrainCanvas.height = MH * TILE;
  const tc = terrainCanvas.getContext("2d");
  tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = "high";
  tc.drawImage(mid, 0, 0, MW * TILE, MH * TILE);

  // Detail on top: only pebbles on rocky slopes. Grass gets its detail from
  // 3D clumps instead (render3d.js), and sand from the ground shader.
  for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) {
    if (slopeAt(tx + 0.5, ty + 0.5) <= 0.35) continue;
    for (let k = 0; k < 4; k++) {
      const hx = hash2(tx * 7 + k, ty * 13 - k), hy = hash2(ty * 11 + k, tx * 5 + k);
      const x = (tx + hx) * TILE, y = (ty + hy) * TILE;
      tc.fillStyle = k % 2 ? "rgba(70,62,50,.35)" : "rgba(200,192,176,.3)";
      tc.beginPath(); tc.ellipse(x, y, 1.5 + hx * 2.5, 1 + hy * 1.5, hx * 3, 0, 7); tc.fill();
    }
  }

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
// The buffers' views into wasm memory are made again only when the buffer
// moved (Rust grew it, or wasm memory grew) or got longer: making them every
// frame is garbage the browser has to clean up.
const views = {};
function viewOf(name, ptr, n) {
  const v = views[name];
  if (v && v.buffer === mem.buffer && v.byteOffset === ptr && v.length >= n) return v;
  return (views[name] = f32(ptr, Math.max(n, 64)));
}
function readWorld() {
  entCount = W.render();
  ents = viewOf("ents", W.ents_ptr(), entCount * ENT_STRIDE);
  resCount = W.res_count();
  resBuf = viewOf("res", W.res_ptr(), resCount * 5);
  projCount = W.proj_count();
  projBuf = viewOf("proj", W.proj_ptr(), projCount * 4);
  byId.reset();
  for (let i = 0; i < entCount; i++) byId.set(ents[i * ENT_STRIDE], i);
}
const E = (i, f) => ents[i * ENT_STRIDE + f];
// field offsets
// flags: 1 selected, 2 under construction, 4 visible, 8 just hit, 16 unsupplied (yours only).
// Fields 12 and 13 are free (they were what a citizen carried).
const F = { id: 0, kind: 1, owner: 2, x: 3, y: 4, px: 5, py: 6, hp: 7, maxhp: 8, flags: 9, prog: 10, anim: 11, face: 14, order: 15, rx: 16, ry: 17 };

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
    const sel = E(i, F.flags) & 1, f = E(i, F.hp) / E(i, F.maxhp), bld = isBld(E(i, F.kind)), short = E(i, F.flags) & 16;
    if (!sel && !short && (f >= 1 || bld)) continue;
    const p = entScreen(i, true);
    if (!p || p.behind) continue;
    if (short) { // unsupplied: a small amber warning sign above the bar
      octx.fillStyle = "#e3b23c"; octx.strokeStyle = "rgba(0,0,0,.7)"; octx.lineWidth = 1.5;
      octx.beginPath(); octx.moveTo(p.x, p.y - 22); octx.lineTo(p.x + 6, p.y - 12); octx.lineTo(p.x - 6, p.y - 12); octx.closePath(); octx.stroke(); octx.fill();
      octx.fillStyle = "#1a140c"; octx.fillRect(p.x - 0.75, p.y - 19, 1.5, 4); octx.fillRect(p.x - 0.75, p.y - 14, 1.5, 1.2);
    }
    const w = bld ? 46 : 22;
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
  // One colour at a time (setting the colour for every dot is slow and makes garbage).
  // Deposit kinds (defs::Dep): fruit bushes, forest, stone, horses, game.
  const RES_DOT = ["#d04848", "#24451f", "#b8b2a6", "#a0703f", "#c8a26a"], dot = Math.max(1.5, s);
  for (let kd = 0; kd < 5; kd++) {
    mctx.fillStyle = RES_DOT[kd];
    for (let i = 0; i < resCount; i++) if (resBuf[i * 5 + 2] === kd) mctx.fillRect(resBuf[i * 5] * s, resBuf[i * 5 + 1] * s, dot, dot);
  }
  mctx.drawImage(fogCanvas, 0, 0, mini.width, mini.height);
  for (let i = 0; i < entCount; i++) {
    const k = E(i, F.kind), o = E(i, F.owner);
    mctx.fillStyle = (E(i, F.flags) & 1) ? "#fff" : PLIGHT[o];
    if (isBld(k)) { const z = stat(k, 6) * s; mctx.fillRect(E(i, F.x) * s - z / 2, E(i, F.y) * s - z / 2, z, z); }
    else mctx.fillRect(E(i, F.x) * s - 1.5, E(i, F.y) * s - 1.5, 3, 3);
  }
  // What the camera sees is a trapezoid on the ground.
  const q = viewQuad();
  if (q.length === 4) {
    mctx.strokeStyle = "#efe6d1"; mctx.lineWidth = 1;
    mctx.beginPath();
    for (let n = 0; n < 4; n++) { const x = q[n][0] * s, y = q[n][1] * s; if (n) mctx.lineTo(x, y); else mctx.moveTo(x, y); }
    mctx.closePath(); mctx.stroke();
  }
}

// ===========================================================================
// HUD
// The resource bar: a chip for every resource the player makes or holds,
// showing free slots and supply. Rebuilt only when that set of resources
// changes; otherwise only its numbers change, so the hover tooltip doesn't
// flicker.
function setupTopBar(shown = []) {
  const bar = $("res");
  bar.replaceChildren();
  const chips = [];
  for (const r of shown) {
    const c = document.createElement("span");
    c.className = "chip"; c.tabIndex = 0; c.dataset.r = r;
    c.innerHTML = `${resIcon(r)}<b></b><small></small>`;
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
  topBar = { chips, pop, era, wonder, key: shown.join(",") };
}
let topBar = null, resTipFor = -1;
// Buildings the player has already been told they can build.
let knownUnlocked = new Set();

function eraIndex() {
  let e = 0;
  ERAS.forEach((era, i) => { if (era.kinds.some(k => W.has_built(k))) e = i; });
  return e;
}

function renderTopBar() {
  // Every resource the player makes or holds, in table order.
  const shown = [];
  for (let r = 0; r < W.n_res(); r++) if (W.supply(r) || W.used(r)) shown.push(r);
  if (!topBar || topBar.key !== shown.join(",")) setupTopBar(shown);
  $("res").hidden = !!observe && !observe.view;
  for (const c of topBar.chips) {
    const r = +c.dataset.r, f = free(r);
    c.querySelector("b").textContent = f;
    const sm = c.querySelector("small");
    sm.textContent = `/ ${W.supply(r)}`;
    c.classList.toggle("over", f < 0);
  }
  const hungry = W.unsupplied();
  topBar.pop.className = "chip pop" + (hungry ? " full" : "");
  topBar.pop.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="8" cy="4.5" r="2.8" fill="#d9c9a8"/><path d="M2.5 15c0-3.6 2.4-6 5.5-6s5.5 2.4 5.5 6z" fill="#d9c9a8"/></svg>${W.pop()}${hungry ? ` · ${hungry} unsupplied` : ""}`;
  topBar.era.textContent = `${ERAS[eraIndex()].name} era`;
  const ew = W.enemy_wonder();
  topBar.wonder.hidden = ew < 0;
  if (ew >= 0) topBar.wonder.textContent = `Rival Wonder ${Math.floor(ew * 100)}%`;
  $("clock").textContent = fmtTime(W.game_time());
  if (resTipFor >= 0) renderResTip();
}

// Where a resource's slots come from and what holds them.
function renderResTip() {
  const tip = $("restip"), r = resTipFor;
  const chipEl = topBar && topBar.chips.find(c => +c.dataset.r === r);
  if (r < 0 || !chipEl) { tip.hidden = true; return; }
  const line = (label, v, cls = "") => `<div class="row ${cls}"><span>${label}</span><b>${v}</b></div>`;
  const name = RES_NAMES[r][0].toUpperCase() + RES_NAMES[r].slice(1);
  let html = `<h4>${name}</h4>`;
  let made = 0, held = 0;
  for (const k of Object.values(K)) {
    const n = k === K.Capitol ? W.count(k) : W.count_built(k);
    const m = slotsOf(k, 1).find(([p]) => p === r);
    if (n && m) { html += line(`${plural(k, n)} × ${m[1]}`, `+${n * m[1]}`, "pos"); made += n * m[1]; }
  }
  for (const k of Object.values(K)) {
    const n = W.count(k), c = slotsOf(k).find(([p]) => p === r);
    if (n && c) { html += line(`${plural(k, n)} × ${c[1]}`, `−${n * c[1]}`, "neg"); held += n * c[1]; }
  }
  if (W.used(r) > held) html += line("In training", `−${W.used(r) - held}`, "neg");
  if (W.supply(r) !== made) html += line("Handicap", `${W.supply(r) - made >= 0 ? "+" : "−"}${Math.abs(W.supply(r) - made)}`);
  html += `<div class="row total"><span>Free</span><b>${free(r)}</b></div>`;
  if (free(r) < 0) html += `<p class="bad">You hold more ${RES_NAMES[r]} than you make: your newest units that need it are losing health.</p>`;
  const p = producerOf(r);
  html += `<p class="note">Slots are borrowed, not spent: whatever holds them gives them back when it's gone.${p != null ? ` A ${NAMES[p]} makes more.` : ""}</p>`;
  tip.innerHTML = html;
  const chip = chipEl.getBoundingClientRect(), app = $("app").getBoundingClientRect();
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
  let freeSig = ""; for (let r = 0; r < 7; r++) freeSig += free(r) + ",";
  const sig = sel.map(i => `${E(i, F.id)}:${Math.ceil(E(i, F.hp))}:${E(i, F.order)}:${E(i, F.flags) & 18}:${Math.floor(E(i, F.prog) * 40)}:${W.queue_len(E(i, F.id))}`).join(",") + `|${placing}|${amode}|${ERAS.flatMap(e => e.kinds).map(k => W.has_built(k)).join("")}|${freeSig}`;
  if (!force && sig === selKey) return;
  selKey = sig;
  const panel = $("sel");
  panel.replaceChildren();
  if (sel.length === 0 && observe) {
    const d = document.createElement("div");
    d.className = "tips";
    d.innerHTML = observe.kind === "replay"
      ? `<h3>Replay</h3>Play, pause and jump with the bar above. Click a player's name to see the game as they saw it, fog and all; <b>Whole map</b> lifts the fog. Click anything to look at it.`
      : `<h3>Watching</h3>Click a player's name to see the game as they see it, fog and all; <b>Whole map</b> lifts the fog. Click anything to look at it.`;
    panel.append(d);
  } else if (sel.length === 0) {
    const d = document.createElement("div");
    d.className = "tips";
    d.innerHTML = `<h3>Outlast your rivals</h3>Nothing is gathered or spent here: buildings <b>make</b> resources, and everything you have <b>holds</b> some while it exists. Select a citizen and build a <b>Lumber Camp</b> by a forest, a <b>Quarry</b> by rock, <b>Farms</b> for grain. Then a <b>Barracks</b>, <b>Archery Range</b> or <b>Stable</b> for an army. Lose a producer and your newest units that need it start losing health. Press <kbd class="k">.</kbd> to find idle citizens.`;
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
  if (!isBld(k)) {
    if (owner === ME || observe) html += `<div class="statline">${ORDER_TEXT[E(i, F.order)]}</div>`;
    if (E(i, F.flags) & 16) html += `<div class="statline bad">Unsupplied: losing health. Make more ${slotsOf(k).map(([r]) => RES_NAMES[r]).join(" and ")}.</div>`;
  } else if (E(i, F.flags) & 2) {
    html += `<div class="statline">Under construction · ${Math.floor(E(i, F.prog) * 100)}%</div><div class="bar prog"><i style="width:${E(i, F.prog) * 100}%"></i></div>`;
  } else if (slotsOf(k, 1).length) {
    html += `<div class="statline">Makes <span class="cost inline">${slotsHtml(slotsOf(k, 1), false)}</span></div>`;
  }
  info.innerHTML = html;
  if (isBld(k) && (owner === ME || observe) && W.queue_len(id) > 0) {
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
  if (!mine.length || observe) return;
  const kinds = new Set(mine.map(i => E(i, F.kind)));
  const add = (b, key, fn) => { box.append(b); if (key) cmdKeys[key.toLowerCase()] = fn; };
  const unitTip = k => {
    let h = `<h4>${NAMES[k]}</h4>${costHtml(k)}<p>${DESC[k] || ""}</p>`;
    if (slotsOf(k, 1).length) h += `<p>Makes <span class="cost inline">${slotsHtml(slotsOf(k, 1), false)}</span></p>`;
    const dep = W.kind_deposit(k);
    if (dep >= 0) h += `<p>Build it next to ${DEP_NAMES[dep]}.</p>`;
    const needs = []; for (let n = 0, q; (q = W.requires(k, n)) >= 0; n++) needs.push(q);
    if (needs.length) h += `<p>Needs ${needs.map(q => `<span class="${W.has_built(q) ? "" : "short"}">${NAMES[q]}</span>`).join(" and ")}.</p>`;
    return h;
  };

  if (kinds.has(K.Citizen)) {
    for (const [k, key] of BUILD_MENU) {
      const fn = () => startPlacing(k);
      const locked = isBld(k) && !W.unlocked(k);
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
  const hasUnits = mine.some(i => !isBld(E(i, F.kind)));
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
// Error codes from Rust (`CmdError::code` in game.rs).
function explain(code) {
  if (code >= 2000) return `Build a ${NAMES[code - 2000]} first`;
  if (code >= 1000) {
    const r = code - 1000, p = producerOf(r);
    return `Not enough ${RES_NAMES[r]}` + (p != null ? `: build another ${NAMES[p]}` : "");
  }
  if (code >= 20 && code < 30) return `It has to be next to ${DEP_NAMES[code - 20]}`;
  return { 10: "That queue is full", 11: "Select a building that can train this", 12: "Can't build there" }[code] || "Can't do that";
}
// Why `k` can't be had right now, as an error code, or 0.
function shortCode(k) { const r = W.short_of(k); return r >= 0 ? 1000 + r : 0; }

// ===========================================================================
// Commands. Everything the player tells the game goes through `issue`, as a
// small plain object: {c: code, ids: [...], x, y, a}. It runs at once. In
// multiplayer it's also handed to the client (net.js), which sends it to the
// host, stamped with this tick. (Codes: see `command` in lib.rs.)
// On the wire, and everywhere after `issue`, a command is a flat array of
// numbers: [code, arg, x, y, ...ids]. Compact (it has to fit, with others,
// into 4 KiB messages) and shallow. x and y are rounded to 1/100 of a tile
// once, here, so every computer applies exactly the same numbers.
function issue(cmd) {
  const r2 = v => Math.round((v || 0) * 100) / 100;
  if (observe) return 0; // watching: nothing to command
  const arr = [cmd.c, cmd.a || 0, r2(cmd.x), r2(cmd.y), ...(cmd.ids || []).slice(0, 60)];
  const code = applyCmd(ME, arr);
  if (mp) mp.queue(arr); // multiplayer records the confirmed order instead (mpHooks.confirmed)
  else Rec.mine(arr);
  return code;
}
// Run one command on whichever copy of the game is current. No sounds, no
// messages: multiplayer also uses this to replay commands.
function applyCmd(owner, arr) {
  const [c, a, x, y] = arr, ids = arr.slice(4);
  if (c === 7 && owner !== 0) return 0; // only the host's system messages may do that
  const p = W.scratch_ptr() >>> 2, buf = new Uint32Array(mem.buffer);
  ids.forEach((id, n) => { buf[p + n] = id; });
  return W.command(owner, c, ids.length, x, y, a);
}
// How the multiplayer client (net.js) reaches the game.
const mpHooks = {
  apply: applyCmd,
  // Carry the selection over a correction: same ids, and say whether any of
  // them now means something else. Units the correction moved slide to
  // their new place instead of jumping (R3.nudges, used in render3d.js).
  keep() { readWorld(); return selection().map(i => [E(i, F.id), E(i, F.kind)]); },
  restore(kept, alpha) {
    readWorld();
    const t = performance.now();
    for (let i = 0; i < entCount; i++) {
      if (isBld(E(i, F.kind))) continue;
      const id = E(i, F.id), o = R3.objs.get(id);
      if (!o || o.x === undefined) continue;
      const dx = o.x - (E(i, F.px) + (E(i, F.x) - E(i, F.px)) * alpha);
      const dy = o.y - (E(i, F.py) + (E(i, F.y) - E(i, F.py)) * alpha);
      if (Math.abs(dx) + Math.abs(dy) > 0.01 && Math.abs(dx) + Math.abs(dy) < 4) R3.nudges.set(id, { dx, dy, t });
    }
    setSelection(kept.map(k => k[0]));
    const now = new Map(selection().map(i => [E(i, F.id), E(i, F.kind)]));
    return kept.some(([id, k]) => now.has(id) && now.get(id) !== k) || now.size !== kept.length;
  },
  system(cmd) { if (cmd[0] === 7) toast(`${PNAME[cmd[1]] || "A player"} left. The computer takes over their people.`); },
  // A tick's commands in their final order: what replays and spectators get.
  confirmed(k, bundle) { Rec.bundle(k, bundle); },
};
// Commands arriving from the network are someone else's input: check the shape.
function cleanCmd(arr) {
  if (!Array.isArray(arr) || arr.length < 4 || arr.length > 64) return null;
  if (!arr.every(v => typeof v === "number" && Number.isFinite(v))) return null;
  const c = arr[0] | 0;
  if (c < 1 || c > 8) return null;
  return [c, arr[1] >>> 0, arr[2], arr[3], ...arr.slice(4).map(v => v >>> 0)];
}
const myIds = (buildings = null) => selection().filter(i => E(i, F.owner) === ME && (buildings === null || isBld(E(i, F.kind)) === buildings)).map(i => E(i, F.id));

function doTrain(k) {
  if (!canAfford(k)) { toast(explain(shortCode(k)), "bad"); Sfx.ui("error"); return; }
  const code = issue({ c: 4, ids: myIds(true), a: k });
  if (code) { toast(explain(code), "bad"); Sfx.ui("error"); } else Sfx.ui("queued");
  selKey = "";
}
function startPlacing(k) {
  if (isBld(k) && !W.unlocked(k)) { let n = 0, q; while ((q = W.requires(k, n++)) >= 0) if (!W.has_built(q)) break; toast(explain(2000 + q), "bad"); Sfx.ui("error"); return; }
  if (!canAfford(k)) { toast(explain(shortCode(k)), "bad"); Sfx.ui("error"); return; }
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
    (isBld(k) ? buildings : units).push(E(i, F.id));
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
  if (!W.can_place(placing, spot.tx, spot.ty)) {
    const dep = W.kind_deposit(placing);
    toast(explain(dep >= 0 && W.can_place_ignoring_deposit(placing, spot.tx, spot.ty) ? 20 + dep : 12), "bad"); Sfx.ui("error"); return;
  }
  if (!canAfford(placing)) { toast(explain(shortCode(placing)), "bad"); Sfx.ui("error"); return; }
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
  if (e.key === "F8") { e.preventDefault(); toggleTrace(); return; }
  if (e.key === "Enter" && Chat.available() && !e.repeat) { e.preventDefault(); Chat.show(); return; }
  if (SCROLL_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (e.key === "Escape" && !$("techScreen").hidden) { $("techScreen").hidden = true; return; }
  if (!$("loadScreen").hidden) { if (e.key === "Escape") closeLoadScreen(); return; }
  if (!$("outScreen").hidden) return; // choose first: watch or leave
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
const EV = { Alert: 1, Trained: 2, Built: 3, Lost: 4, Death: 5, Melee: 6, Shoot: 7, Hammer: 9, ArrowHit: 11, Short: 12, WonderBegun: 13, Eliminated: 14 };
function handleEvents() {
  const n = W.take_events();
  if (!n) return;
  // Copy out: playing sounds reads fog memory, and wasm memory could move.
  const ev = f32(W.events_ptr(), n).slice();
  for (let j = 0; j < n; j += 4) {
    const type = ev[j], x = ev[j + 1], y = ev[j + 2], d = ev[j + 3];
    // Watching: the sounds of the world, but none of the messages meant for a player.
    if (observe) {
      if (type === EV.Eliminated) toast(`${PNAME[d]} is out of the game.`);
      else if (type === EV.WonderBegun) toast(`${PNAME[d]} has begun a Wonder.`);
      if (type <= 4 || type >= 12) continue;
    }
    switch (type) {
      case EV.Alert:
        toast(isBld(d) ? `Your ${NAMES[d]} is under attack. Space to view.` : "Your people are under attack. Space to view.", "bad");
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
        if (isBld(kind)) Sfx.at("crumble", x, y, 200);
        else Sfx.at("death", x, y, 90, kind === K.Horseman);
        break; }
      case EV.Melee: Sfx.at("melee", x, y, 45, d); break;
      case EV.Shoot: Sfx.at("bow", x, y, 60, isBld(d)); break;
      case EV.ArrowHit: Sfx.at("arrowHit", x, y, 50, d === 1); break;
      case EV.Hammer: Sfx.at("hammer", x, y, 90); break;
      case EV.WonderBegun:
        if (d !== ME) { toast(`${PNAME[d]} has begun a Wonder! Destroy it before it's finished.`, "bad"); Sfx.ui("horn"); lastAlert = { x, y, t: performance.now() }; }
        else toast("Wonder begun. Put many citizens on it, and protect it.", "good");
        break;
      case EV.Eliminated:
        if (d !== ME) toast(`${PNAME[d]} has been eliminated.`, "good");
        break;
      case EV.Short: {
        const p = producerOf(d);
        toast(`You hold more ${RES_NAMES[d]} than you make. Your newest units that need it are losing health` + (p != null ? `: build a ${NAMES[p]}.` : "."), "bad");
        Sfx.ui("starving");
        break; }
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
  Watchers.pump(performance.now()); // spectators, also after the game has ended
  if (mp && Trace.cur && last) Trace.cur.maxFrameGap = Math.max(Trace.cur.maxFrameGap, Math.round(now - last));
  last = now;
  if (running) {
    const f0 = performance.now();
    scrollCamera(dt);
    if (mp) pumpMultiplayer(performance.now(), false);
    else if (watcher) { if (watcher.pump()) handleEvents(); }
    else if (Replay.on) { if (Replay.pump(dt)) handleEvents(); }
    else if (!paused) {
      acc += dt * 1000 * speed;
      let steps = 0;
      const most = Math.max(8, speed * 4);
      while (acc >= SIM_MS && steps < most) { W.tick(); simTick++; acc -= SIM_MS; steps++; }
      if (steps === most) acc = 0;
      if (steps) handleEvents();
      if (!Rec.done) Rec.ticks = simTick;
    }
    const f1 = performance.now();
    readWorld();
    if (frame % 3 === 0) updateFog();
    // How far between the last tick and the next one we are. In multiplayer,
    // count the time since the clock last moved, so motion stays smooth.
    const along = mp ? mp.alpha() * SIM_MS : acc;
    const f2 = performance.now();
    render3d(paused && !mp ? 1 : Math.min(1, along / SIM_MS), now, dt);
    const f3 = performance.now();
    drawOverlay();
    updateHoverCursor(now);
    if (frame % 4 === 0) drawMinimap();
    if (frame % 6 === 0) { renderTopBar(); renderSelection(false); renderScoreboard(false); }
    syncObserverUi();
    if (mp) frameTrace(now, f1 - f0, f2 - f1, Math.max(0, f3 - f2 - R3.gpuMs), R3.gpuMs, performance.now() - f3);
    // Is the game over? For a player, from their own point of view; for
    // someone only watching, once anyone has won.
    // (Multiplayer decides in pumpMultiplayer, on the confirmed copy.)
    if (observe && observe.kind !== "out") { if (W.winner_player()) observerOver(); }
    else if (running && !mp && W.state_of(ME) !== 0) endGame();
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

// In multiplayer the game is stepped by whichever comes first: an animation
// frame (smooth, up to 60 times a second, but browsers pause them in a
// background tab), or a tiny Web Worker that ticks every 50 ms (workers keep
// running in the background, so one player's hidden tab doesn't stall
// everyone). Both call pumpMultiplayer, which measures time from the same
// clock, so calling it twice just means a smaller step.
let workerClock = false, lastPump = 0;
try {
  const src = "setInterval(() => postMessage(0), 50);";
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  workerClock = true;
  worker.onmessage = () => {
    if (running && mp) pumpMultiplayer(performance.now(), true);
    else if (running && watcher && document.hidden) { if (watcher.pump()) handleEvents(); }
  };
} catch { /* no workers here: background tabs will just be slow */ }

function pumpMultiplayer(now, fromWorker) {
  if (fromWorker && Trace.cur && lastPump) Trace.cur.maxClockGap = Math.max(Trace.cur.maxClockGap, Math.round(now - lastPump));
  lastPump = now;
  for (const look of roomLookers) look();
  stepMultiplayer(now);
  Watchers.pump(now);
  // The game is over only once the confirmed copy says so (then the
  // recording, and what spectators get, has the ending too).
  if (mp && mp.finalState !== 0) endGame(mp.finalState);
}

// Multiplayer stepping: the client does the work (net.js).
function stepMultiplayer(now) {
  const { steps, stalled } = mp.pump();
  if (!mp) return; // the game ended in there (drift found)
  simTick = mp.live;
  if (steps) handleEvents();
  if (Trace.cur) Trace.cur.ticks += steps;
  if (stalled) {
    if (!stalledSince) { stalledSince = now; Trace.event("stall", { live: mp.live, final: mp.final }); }
  } else if (stalledSince) {
    const ms = Math.round(now - stalledSince);
    if (Trace.cur) Trace.cur.stallMs += ms;
    Trace.event("resume", { ms });
    stalledSince = 0;
  }
  if (Trace.roll(now, mp.snapshot())) renderTrace();
  if (!mp) return;
  // Say so if we've been waiting a while; give up if they're gone.
  const h = $("netWait");
  h.hidden = !(stalledSince && now - stalledSince > 700);
  if (!h.hidden) h.textContent = ME === 1 ? "Waiting for the other players…" : "Waiting for the host…";
  if (!mp.server && now - mp.lastHeard > 15000) endMultiplayer("Lost contact with the host.");
  if (mp && mp.server) for (const s of mp.server.silent(20000)) dropPlayer(s);
}

// ---- where frames' time goes (for the trace) ----
// A frame that comes late was held up either by our own work in the frame
// before (the game, drawing, the HUD), or by something outside the page:
// the browser cleaning up memory, another tab, the computer. So each frame's
// work is timed, part by part, and a late frame is recorded with the work of
// the frame before it. Where the browser tells (Chrome, Edge), the memory in
// use is noted too: a sudden drop means it just cleaned up.
let lastWork = null, lastFrameNow = 0, lastHeap = 0, lastPrograms = 0;
function frameTrace(now, sim, world, draw, gpu, hud) {
  const c = Trace.cur;
  const work = { sim: Math.round(sim), world: Math.round(world), draw: Math.round(draw), gpu: Math.round(gpu), hud: Math.round(hud) };
  const total = sim + world + draw + gpu + hud;
  const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const programs = R3.renderer.info.programs ? R3.renderer.info.programs.length : 0;
  if (c) {
    c.maxWork = Math.max(c.maxWork || 0, Math.round(total));
    if (heap && lastHeap - heap > 512 * 1024) { c.cleanups = (c.cleanups || 0) + 1; c.freedMB = Math.round(((c.freedMB || 0) + (lastHeap - heap) / 1048576) * 10) / 10; }
  }
  const gap = lastFrameNow ? now - lastFrameNow : 0;
  if (gap > 70 && lastWork) {
    const ours = lastWork.sim + lastWork.world + lastWork.draw + lastWork.gpu + lastWork.hud;
    Trace.event("slow frame", {
      gap: Math.round(gap), ourWork: ours, outside: Math.max(0, Math.round(gap - ours)), before: lastWork, now: work,
      newShaders: programs - lastPrograms || undefined,
      heapMB: heap ? Math.round(heap / 104857.6) / 10 : undefined,
      freedMB: heap && lastHeap > heap ? Math.round((lastHeap - heap) / 104857.6) / 10 : undefined,
    });
  }
  lastWork = work; lastFrameNow = now; lastHeap = heap; lastPrograms = programs;
}
// Chrome and Edge report tasks that block the page for over 50 ms.
try {
  new PerformanceObserver(list => { if (mp) for (const e of list.getEntries()) Trace.event("long task", { ms: Math.round(e.duration) }); }).observe({ type: "longtask", buffered: false });
} catch { /* not in this browser */ }

// ---- the trace panel (F8) ----
function renderTrace() {
  const box = $("netTrace");
  if (box.hidden || !mp) return;
  const s = Trace.samples[Trace.samples.length - 1];
  if (!s) { $("netTraceBody").textContent = "Measuring…"; return; }
  const ms = n => n == null ? "?" : `${n} ms`;
  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : "–";
  const st = s.stats, tick = NET.TICK_MS;
  const lines = [];
  lines.push(`You: ${s.role} (${PNAME[ME]}) · ${Trace.info.transport} · window ${s.window} ticks (${s.window * tick} ms)`);
  const sign = n => n == null ? "?" : `${n > 0 ? "+" : ""}${n} ms`;
  if (s.server) {
    for (const [slot, g] of Object.entries(s.server.guests)) lines.push(`${PNAME[slot]}: ${g.active ? "" : "(left) "}ping ${ms(g.rtt)} ±${g.dev ?? "?"} · clock ${sign(g.clockErr)} · late commands ${g.late} · heard ${ms(g.heardAgo)} ago`);
  } else {
    lines.push(`Ping to host: ${ms(s.rtt)} ±${s.dev} · my clock ${sign(s.clockErr)} (as the host sees it) · heard ${ms(s.heardAgo)} ago`);
  }
  lines.push(`Live runs ${s.ahead} ticks ahead of confirmed · unconfirmed commands: mine ${s.pending}, friends' ${s.foreign}`);
  lines.push(`Predictions right: whole game ${pct(st.matched, st.compared)}, my own things ${pct(st.mineMatched, st.compared)} (of ${st.compared} ticks)`);
  lines.push(`Corrections ${st.corrections} (friend early ${st.early}, friend in bundle ${st.remote}, moved ${st.moved}, system ${st.system}, behind ${st.behind}) · re-ran ${st.resimTicks} ticks`);
  lines.push(`…that changed my own things ${st.mineChanged} · moved my selection ${st.selChanged}`);
  lines.push(`Friends' commands seen ${ms(s.friendsSeenAfter)} after given · unexplained ${st.unexplained} · drift (desync) ${st.desyncs}`);
  lines.push(`Ticks ${s.ticks}/s · stalled ${s.stallMs} ms`);
  lines.push(`Messages in ${s.inMsgs}/s (${(s.inBytes / 1024).toFixed(1)} KB, longest gap ${ms(s.maxInGap)}) · out ${s.outMsgs}/s (${(s.outBytes / 1024).toFixed(1)} KB)`);
  lines.push(`Longest frame ${ms(s.maxFrameGap)} (our work at most ${ms(s.maxWork)}) · longest clock gap ${ms(s.maxClockGap)}`);
  const slow = Trace.events.filter(e => e.kind === "slow frame");
  if (slow.length) { const e = slow[slow.length - 1]; lines.push(`Slow frames ${slow.length}; last: ${e.gap} ms, of which ours ${e.ourWork} ms (game ${e.before.sim}, drawing ${e.before.draw}, graphics card ${e.before.gpu}, HUD ${e.before.hud})${e.newShaders ? `, ${e.newShaders} new shaders` : ""}${e.freedMB ? `, browser freed ${e.freedMB} MB` : ""}`); }
  if (s.cleanups) lines.push(`Browser memory clean-ups: ${s.cleanups} this second (${s.freedMB} MB)`);
  $("netTraceBody").textContent = lines.join("\n");
}
function toggleTrace(show = $("netTrace").hidden) {
  $("netTrace").hidden = !show || !mp;
  renderTrace();
}
$("netBtn").onclick = () => toggleTrace();
$("netTraceClose").onclick = () => toggleTrace(false);
$("netTraceCopy").onclick = () => {
  const text = Trace.dump(), btn = $("netTraceCopy");
  const showIt = () => { const t = $("netTraceText"); t.hidden = false; t.value = text; t.focus(); t.select(); btn.textContent = "Press Ctrl+C"; };
  try { navigator.clipboard.writeText(text).then(() => { btn.textContent = `Copied (${Math.round(text.length / 1024)} KB)`; setTimeout(() => { btn.textContent = "Copy trace"; }, 2000); }, showIt); }
  catch { showIt(); }
};
document.addEventListener("visibilitychange", () => { if (mp) Trace.event(document.hidden ? "tab hidden" : "tab shown", {}); });

// Start a game. Single player: `players` is you plus the computer players.
// Multiplayer: `local` is the slot this computer plays (1 is the host).
function newGame(seedArg, local = 0, players = 2) {
  seed = seedArg ?? ((Math.random() * 1e9) >>> 0);
  W.init(seed, difficulty, players);
  if (local) W.setup_multiplayer(local);
  enterWorld(local);
}

// Set the page up for whatever game the wasm side now holds: a new one, or
// one just loaded from a save.
function enterWorld(local = 0) {
  ME = W.local_player();
  simTick = 0; stalledSince = 0; outShown = false; surrendered = false;
  stopObserving();
  $("outScreen").hidden = true;
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
  if (local || speed > 2) { speed = 1; $("speedBtn").textContent = "1×"; }
  renderTopBar(); renderSelection(true);
  // Start recording (a replay, and what spectators are sent). Single player:
  // me against the computer. Multiplayer fills in who's who when it starts.
  const who = {};
  for (let p = 1; p <= W.n_players(); p++) who[p] = p === ME ? "human" : "computer";
  Rec.begin({ who, mp: !!local });
}

let outShown = false;   // the "you're out" card has been shown for this game
let surrendered = false; // I gave up (for the wording)
function endGame(st = W.state_of(ME)) {
  // Out of the running while others play on: watch the rest, or leave.
  if (st === 5) {
    if (!outShown && !observe) {
      outShown = true;
      $("outTitle").textContent = surrendered ? "You surrendered" : "Defeat";
      $("outWhy").textContent = (surrendered ? "" : "Your Capitol has fallen. ") +
        (mp && mp.server ? "The others play on. You're the host: if you leave, the game ends for everyone." : "The others play on.");
      $("outScreen").hidden = false;
      if (!mp && !paused) togglePause(); // single player waits for you to choose
      Sfx.ui("fanfare", false);
    }
    return;
  }
  showEnd(st);
}
// The game is over for me: the end screen.
function showEnd(st) {
  running = false;
  $("outScreen").hidden = true;
  const won = st === 1 || st === 3;
  $("endTitle").textContent = won ? "Victory" : surrendered ? "Surrendered" : "Defeat";
  const winner = PNAME[W.winner_player()] || "Someone";
  $("endWhy").textContent = {
    1: "All your rivals have fallen.",
    2: surrendered ? `You surrendered. ${winner} wins.` : `${winner} has conquered the land.`,
    3: "Your Wonder stands complete. Your people will be remembered.",
    4: `${winner} finished a Wonder.`,
    5: surrendered ? "You surrendered." : "Your Capitol has fallen.",
  }[st];
  Rec.finish(won ? `${PNAME[ME]} won` : W.winner_player() ? `${winner} won${W.by_wonder() ? " with a Wonder" : ""}` : surrendered ? `${PNAME[ME]} surrendered` : `${PNAME[ME]} was out`);
  Sfx.ui("fanfare", won);
  stopObserving();
  showEndStats();
  if (mp) finishMultiplayer();
}
// From the "you're out" card, or the bar while watching: leave this game.
function leaveOut() {
  $("outScreen").hidden = true;
  if (paused && !mp) togglePause();
  showEnd(5);
}
function showEndStats(opts = {}) {
  const ps = [...Array(W.n_players())].map((_, i) => i + 1);
  const head = ps.map(p => `<th style="color:${PLIGHT[p]}">${p === ME && ME ? "You" : PNAME[p]}</th>`).join("");
  const row = (label, f) => `<tr><th>${label}</th>${ps.map(p => `<td>${f(p)}</td>`).join("")}</tr>`;
  $("endStats").innerHTML = `<tr><th></th>${head}</tr>` +
    row("Units trained", p => W.player_stat(p, 0)) +
    row("Units and buildings lost", p => W.player_stat(p, 1)) +
    row("Buildings built", p => W.player_stat(p, 2)) +
    `<tr><th>Game time</th><td colspan="${ps.length}">${fmtTime(W.game_time())}</td></tr>`;
  $("againBtn").textContent = mp || lastWasMultiplayer ? "Back to menu" : "Play again";
  $("againBtn").hidden = !!opts.watching;
  $("toMenuBtn").textContent = opts.watching ? "Stop watching" : "Change difficulty";
  $("replayBtn").hidden = !Rec.replay;
  $("endScreen").hidden = false;
}

function togglePause() {
  if (mp || watcher) return;
  paused = !paused;
  $("pauseBtn").setAttribute("aria-pressed", String(paused));
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
}


// The connection status line on claude.ai: what the room says right now. Helps
// tell "blocked by the browser" from "not invited" from "nobody else here".
function renderNetStatus() {
  const el = $("netStatus");
  if (!el || $("startScreen").hidden) return;
  const d = Net.diag;
  if (!d.onClaude) { el.textContent = ""; return; }
  let t = `Online: ${d.room}`;
  if (Net.room) {
    const c = Net.room.connected ? Net.room.connected() : null;
    t += c === true ? ", connected" : c === false ? ", not connected yet" : "";
    if (pageRoom && pageRoom.count) { const n = pageRoom.count(); t += ` · ${n} other ${n === 1 ? "person" : "people"} on this page`; }
  }
  if (d.errors.length) t += ` · problems: ${d.errors.join("; ")}`;
  el.textContent = t;
}

// ===========================================================================
// The lobby. Opening the page makes you the host of your own lobby with four
// seats: yours, and three that each hold a computer player or are left open.
// Friends join with an invite link (this page's address plus #CODE) and take
// an open seat, or a computer's if none is open. Begin with no friends seated
// is an ordinary single-player game; with friends, it's multiplayer.
//
// The lobby lives in a network room named after its code, and the game then
// runs in that same room. The host's presence there carries the seat list,
// which is how guests see it.
//
// A seat is a string, which is also how it travels: "host", "ai", "open", or
// "f:<token>" for a friend.
let seats = ["host", "ai", "open", "open"];
let room = null;        // the lobby's room (and then the game's)
let roomCode = null;    // my own lobby's code, kept for the whole visit so my link keeps working
let guestOf = null;     // as a guest: { code, host (the host's presence, or null), lostAt }
let pageRoom = null;    // claude.ai only: the page-wide room where lobbies are listed
let lobbyGen = 0;       // bumped on every lobby switch, so late answers from an old one are ignored
let netOk = false;      // can this page go online at all?
let lastPlayers = 2, lastWasMultiplayer = false, startTimer = 0;
const kicked = new Set();  // friends the host removed: they don't get a seat again
const played = new Set();  // games already played, so a leftover "start" never restarts one
const myToken = Math.random().toString(36).slice(2, 10); // who I am in a room
const mpStatus = (text, bad = false) => { const s = $("mpStatus"); s.textContent = text; s.classList.toggle("bad", bad); };
const randomCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const okToken = t => typeof t === "string" && /^[a-z0-9]{4,12}$/.test(t);
const isFriend = s => typeof s === "string" && s.startsWith("f:");
// The code at the end of an invite link (or a bare code).
const codeIn = text => { const m = String(text || "").trim().toUpperCase().match(/(?:^|#)([A-Z0-9]{6})$/); return m ? m[1] : null; };
const inGame = () => $("startScreen").hidden;

// The player number a seat gets: open seats are skipped.
function slotOf(i, list) {
  if (list[i] === "open") return 0;
  let n = 0;
  for (let k = 0; k <= i; k++) if (list[k] !== "open") n++;
  return n;
}

function inviteLink() {
  if (!room || guestOf || Net.room) return null; // on claude.ai, lobbies are listed instead
  return location.href.split("#")[0] + "#" + roomCode;
}

function renderLobby() {
  const guest = !!guestOf;
  const list = guest ? (guestOf.host ? guestOf.host.seats : []) : seats;
  const ol = $("seats");
  ol.replaceChildren();
  list.forEach((s, i) => {
    const slot = slotOf(i, list);
    const li = document.createElement("li");
    li.className = "seat" + (slot ? "" : " closed");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = slot ? PCOL[slot] : "transparent";
    if (!slot) sw.style.border = "1px dashed var(--line)";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = s === "host" ? (guest ? "Host" : "You")
      : s === "f:" + myToken ? "You"
      : isFriend(s) ? "Friend"
      : s === "ai" ? "Computer"
      : room ? "Open for a friend" : "Empty";
    if (slot) who.style.color = PLIGHT[slot];
    li.append(sw, who);
    if (!guest && i > 0) {
      // The host decides who sits where.
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `Seat ${i + 1}`);
      const opts = isFriend(s) ? [["friend", "Friend"], ["ai", "Give to computer"], ["open", "Remove"]]
        : [["ai", "Computer"], ["open", room ? "Open" : "Empty"]];
      for (const [v, label] of opts) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        o.selected = v === s || (v === "friend" && isFriend(s));
        sel.append(o);
      }
      sel.onchange = () => setSeat(i, sel.value);
      li.append(sel);
    } else if (slot) {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = PNAME[slot];
      li.append(tag);
    }
    ol.append(li);
  });
  const active = list.filter(s => s !== "open").length;
  const friends = list.filter(isFriend).length;
  const btn = $("startBtn");
  btn.hidden = guest;
  $("leaveLobbyBtn").hidden = !guest;
  btn.disabled = active < 2;
  btn.textContent = active < 2 ? "Add an opponent to begin" : friends ? `Start game (${active} players)` : "Begin";
  const link = inviteLink();
  $("inviteRow").hidden = !link;
  $("lobbyWatchLink").hidden = !link;
  if (link && $("inviteLink").value !== link) $("inviteLink").value = link;
  const diff = guest && guestOf.host ? guestOf.host.diff : difficulty;
  for (const b of $("diff").children) { b.disabled = guest; b.setAttribute("aria-pressed", String(+b.dataset.d === diff)); }
}

function setSeat(i, v) {
  const s = seats[i];
  if (isFriend(s)) { if (v === "friend") return; kicked.add(s.slice(2)); }
  seats[i] = v;
  lobbyChanged();
}
function lobbyChanged() { publishLobby(); renderLobby(); }
function publishLobby() {
  if (!room || guestOf) return;
  room.presence({ role: "host", v: NET.PROTOCOL, token: myToken, seats, diff: difficulty, playing: inGame(), kicked: [...kicked].slice(-20) });
}

// The host's view of the room: seat whoever has arrived, free the seats of
// whoever has gone. During a game, anyone gone is handed to the computer.
function onHostPeers(peers) {
  setWatchCount(countWatchers(peers));
  Chat.setOthers(peers.length);
  const here = new Set();
  for (const p of peers) {
    const pr = p.presence || {};
    if (pr.role !== "guest" || pr.v !== NET.PROTOCOL || !okToken(pr.token)) continue;
    here.add(pr.token);
    if (mp && mp.server) {
      if (pr.playing === mp.server.gameId) mp.server.seenPlaying.add(pr.token);
      else if (mp.server.seenPlaying.has(pr.token)) here.delete(pr.token); // was in the game, now back in the lobby
    }
  }
  if (mp && mp.server) { for (const [slot, t] of mp.server.tokens) if (!here.has(t)) dropPlayer(slot); return; }
  if (mp) return;
  let changed = false;
  seats.forEach((s, i) => { if (isFriend(s) && !here.has(s.slice(2))) { seats[i] = "open"; changed = true; } });
  for (const t of here) {
    if (kicked.has(t) || seats.includes("f:" + t)) continue;
    let i = seats.indexOf("open");
    if (i < 0) i = seats.lastIndexOf("ai");
    if (i < 0) break; // full
    seats[i] = "f:" + t;
    changed = true;
    if (!inGame()) Sfx.ui("trained");
  }
  if (changed) lobbyChanged();
}

// Leave whatever room we're in.
function closeRoom() {
  clearInterval(startTimer);
  if (room) room.leave();
  room = null; mp = null;
  setWatchCount(0);
  Chat.setOthers(0);
  $("watchHostBtn").hidden = true;
  if (pageRoom) pageRoom.presence({ hosting: null });
}

// Be the host of my own lobby (what the page does when it opens).
async function openOwnLobby(note = "", bad = false) {
  const gen = ++lobbyGen;
  closeRoom();
  guestOf = null;
  leaveWatching();
  if (codeIn(location.hash) || watchIn(location.hash)) try { history.replaceState(null, "", location.href.split("#")[0]); } catch { /* not allowed here */ }
  seats = seats.map(s => isFriend(s) ? "open" : s);
  renderLobby();
  mpStatus(note, bad);
  if (!netOk) return;
  roomCode = roomCode || randomCode();
  try {
    const r = await Net.game(roomCode);
    if (gen !== lobbyGen) { r.leave(); return; }
    room = r;
    Watchers.attach(room);
    Chat.attach(room);
    room.onPeers(onHostPeers);
    publishLobby();
    if (pageRoom) pageRoom.presence({ hosting: roomCode, v: NET.PROTOCOL });
    renderLobby();
  } catch (e) {
    if (gen !== lobbyGen) return;
    mpStatus(Net.room ? String(e.message || e) : "Playing with friends needs the relay server, which isn't reachable. You can still play against the computer.", !!Net.room);
  }
}

// Sit in someone else's lobby.
async function joinLobby(code) {
  if (!code || code === roomCode && !guestOf) return;
  const gen = ++lobbyGen;
  closeRoom();
  leaveWatching();
  guestOf = { code, host: null, lostAt: performance.now() };
  renderLobby();
  if (!netOk) { openOwnLobby("This page can't go online, so it can't join that game.", true); return; }
  mpStatus("Looking for the game…");
  try {
    const r = await Net.game(code);
    if (gen !== lobbyGen) { r.leave(); return; }
    room = r;
    Chat.attach(room);
    room.presence({ role: "guest", v: NET.PROTOCOL, token: myToken, playing: null });
    room.on("start", onStart);
    room.onPeers(onGuestPeers);
  } catch (e) {
    if (gen === lobbyGen) openOwnLobby(`Couldn't join that game: ${e.message || e}`, true);
  }
}

function onGuestPeers(peers) {
  if (!guestOf) return;
  setWatchCount(mp ? countWatchers(peers) : 0);
  Chat.setOthers(peers.length);
  const host = peers.map(p => p.presence || {}).find(pr => pr.role === "host" && pr.v === NET.PROTOCOL && okToken(pr.token) && Array.isArray(pr.seats));
  if (mp) { if (!host || host.token !== mp.hostToken) endMultiplayer("The host left the game."); return; }
  if (!host) { if (guestOf.host) { guestOf.host = null; guestOf.lostAt = performance.now(); } renderLobby(); return; }
  guestOf.host = host;
  if (Array.isArray(host.kicked) && host.kicked.includes(myToken)) { openOwnLobby("The host gave your seat away. Here's your own game.", true); return; }
  const seated = host.seats.includes("f:" + myToken);
  mpStatus(!seated ? "No free seat right now. You'll get one if the host opens a seat."
    : host.playing ? "The host is in a game. You'll play together when they're back. Meanwhile you can watch it."
    : "You're in. Waiting for the host to start…");
  $("watchHostBtn").hidden = !host.playing || !!Net.room;
  renderLobby();
}

// Once a second: a guest whose host is gone for good goes back to their own lobby.
function lobbyTick() {
  if (guestOf && !mp && !guestOf.host && performance.now() - guestOf.lostAt > 8000)
    openOwnLobby("That game isn't open any more. Here's your own.", true);
}

// A guest: the host started the game.
function onStart(d) {
  if (mp || !guestOf || !d || d.v !== NET.PROTOCOL || typeof d.seed !== "number" || !d.slots || typeof d.id !== "string" || played.has(d.id)) return;
  const slot = d.slots[myToken];
  if (typeof slot !== "number") return;
  played.add(d.id);
  const client = new Client(slot, room, myToken, mpHooks, endMultiplayer);
  client.hostToken = d.host;
  room.presence({ playing: d.id }); // tells the host I'm in this game
  startMultiplayer(slot, d, client);
}

// The host pressed Begin.
function beginGame() {
  if (guestOf || mp) return;
  const active = seats.filter(s => s !== "open");
  if (active.length < 2) return;
  if (!room || !active.some(isFriend)) {
    lastWasMultiplayer = false; lastPlayers = active.length;
    $("startScreen").hidden = true;
    newGame(undefined, 0, active.length);
    running = true; Rec.real = true;
    publishLobby(); // friends who arrive now wait for the next game
    return;
  }
  const slots = {}, ai = [];
  active.forEach((s, k) => { if (isFriend(s)) slots[s.slice(2)] = k + 1; else if (s === "ai") ai.push(k + 1); });
  const settings = { v: NET.PROTOCOL, id: randomCode() + Date.now(), seed: (Math.random() * 1e9) >>> 0, n: active.length, slots, ai, diff: difficulty, host: myToken };
  // Keep telling the guests until all of them have answered.
  const send = () => room && room.emit("start", settings);
  send();
  startTimer = setInterval(() => {
    if (!(mp && mp.server)) return clearInterval(startTimer);
    if (mp.server.waitingForStart()) send(); else clearInterval(startTimer);
  }, 400);
  if (pageRoom) pageRoom.presence({ hosting: null });
  // The host runs the server and, like everyone, a client.
  const client = new Client(1, null, myToken, mpHooks, endMultiplayer);
  client.server = new Server(room, Object.entries(slots).map(([t, s]) => [s, t]), client, endMultiplayer);
  client.server.gameId = settings.id; client.server.seenPlaying = new Set();
  startMultiplayer(1, settings, client);
}

function startMultiplayer(me, d, seq) {
  const n = Math.max(2, Math.min(4, d.n | 0));
  difficulty = [0, 1, 2].includes(d.diff) ? d.diff : 1;
  $("startScreen").hidden = true;
  newGame(d.seed >>> 0, me, n);
  const ai = (Array.isArray(d.ai) ? d.ai : []).filter(s => Number.isInteger(s) && s >= 1 && s <= n);
  for (const s of ai) W.set_ai(s, 1);
  // Record from here: the start everyone shares, then the confirmed bundles.
  const who = {};
  for (let p = 1; p <= n; p++) who[p] = ai.includes(p) ? "computer" : "human";
  Rec.begin({ who, mp: true });
  Rec.real = true;
  W.mp_save(); // the confirmed copy starts out identical
  mp = seq;
  lastPump = 0;
  // Building the map can take a few seconds: the host's clock starts now.
  if (mp.server) mp.server.t0 = performance.now();
  Trace.start({ role: me === 1 ? "host" : "guest", me, players: n, transport: room && room.kind === "socket" ? "relay" : "claude.ai room", relay: room && room.kind === "socket" ? Net.relayUrl : undefined });
  $("netBtn").hidden = false;
  // Building the map can take a few seconds on a slow computer: only start
  // the "haven't heard from you" clocks once we're ready to play.
  mp.lastHeard = performance.now();
  if (mp.server) for (const s of mp.server.heard.keys()) mp.server.heard.set(s, performance.now());
  lastWasMultiplayer = true;
  running = true;
  publishLobby();
  toast(`You are ${PNAME[me]}. ${n} players.`, "good");
}

// A guest left: the computer takes over their people (in the next frame).
function dropPlayer(slot) {
  if (!(mp && mp.server) || !mp.server.active.has(slot)) return;
  mp.server.drop(slot);
}

function endMultiplayer(reason) {
  if (!mp) return;
  running = false;
  stopObserving(); $("outScreen").hidden = true;
  Rec.finish(reason);
  $("endTitle").textContent = "Game over";
  $("endWhy").textContent = reason;
  showEndStats();
  finishMultiplayer();
}

// The game is over (or we left it). We stay in the room: back in the lobby,
// everyone can go again together.
function finishMultiplayer() {
  clearInterval(startTimer);
  if (mp) { Trace.event("end", {}); W.mp_end(); }
  mp = null;
  $("netBtn").hidden = true; $("netTrace").hidden = true;
  $("netWait").hidden = true;
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
  if (mp || observe || !running || saving || W.state_of(ME) !== 0) return;
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

function downloadSave(save, kind = "") {
  const d = new Date(save.saved), pad = v => String(v).padStart(2, "0");
  const name = `vibecraft-${kind ? kind + "-" : ""}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.vibecraft`;
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
  finishMultiplayer(); lastWasMultiplayer = false;
  leaveWatching(); Replay.close();
  if (guestOf) openOwnLobby(); // we were waiting in someone's lobby: we're playing alone now
  u8(W.load_buffer(bytes.length), bytes.length).set(bytes);
  if (!W.load_game(bytes.length)) { toast("That save is damaged, or from another version of the game.", "bad"); return; }
  seed = W.game_seed(); difficulty = W.game_difficulty();
  enterWorld(0);
  if (save.cam) { Object.assign(cam, save.cam); clampCam(); }
  if (save.groups) groups = save.groups;
  for (const id of ["loadScreen", "menuScreen", "startScreen", "endScreen"]) $(id).hidden = true;
  running = true; Rec.real = true;
  lastPlayers = W.n_players(); // for Restart and Play again
  publishLobby(); // friends who open our link now wait for the next game
  toast(`Loaded: ${fmtTime(W.game_time())} into the game`);
}

let loadReturn = "menuScreen";
function openLoadScreen(from) {
  loadReturn = from;
  $(from).hidden = true;
  renderSaveList();
  renderReplayList();
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
function syncSoundBtn() {
  $("soundBtn").textContent = Sfx.muted ? "Sound off" : "Sound on";
  $("volume").value = String(Math.round(Sfx.volume * 100));
  $("volume").classList.toggle("off", Sfx.muted);
}
$("soundBtn").onclick = () => { Sfx.setMuted(!Sfx.muted); syncSoundBtn(); };
$("volume").addEventListener("input", e => {
  Sfx.setVolume(e.target.value / 100);
  if (Sfx.muted && Sfx.volume > 0) Sfx.setMuted(false); // dragging the slider means you want sound
  syncSoundBtn();
});
// Let go of the slider and a short sound plays at the new level.
$("volume").addEventListener("change", e => { Sfx.init(); Sfx.ui("queued"); e.target.blur(); });
syncSoundBtn();
$("diff").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || guestOf) return;
  difficulty = +b.dataset.d;
  lobbyChanged();
});
// Back to the lobby: a host reopens theirs (which also clears what the last
// game left in the room); a guest goes back to their host's.
const toMenu = () => {
  if (watcher) return stopWatching();
  const wasGuestOf = guestOf && guestOf.code;
  if (running && !observe) Rec.finish();
  Replay.close(); stopObserving(); $("outScreen").hidden = true;
  finishMultiplayer(); lastWasMultiplayer = false; running = false; titleSpin = true;
  $("endScreen").hidden = true; $("menuScreen").hidden = true; $("startScreen").hidden = false;
  if (wasGuestOf) joinLobby(wasGuestOf); else openOwnLobby();
};
$("startBtn").onclick = beginGame;
$("leaveLobbyBtn").onclick = () => openOwnLobby();
$("againBtn").onclick = () => { if (lastWasMultiplayer) return toMenu(); $("endScreen").hidden = true; newGame(undefined, 0, lastPlayers); running = true; Rec.real = true; };
$("toMenuBtn").onclick = toMenu;
$("pauseBtn").onclick = togglePause;
// Watching the rest of a single-player game, it can go faster.
$("speedBtn").onclick = () => {
  const steps = observe ? [1, 2, 4, 8] : [1, 1.5, 2];
  speed = steps[(steps.indexOf(speed) + 1) % steps.length];
  $("speedBtn").textContent = `${speed}×`;
};
$("menuBtn").onclick = () => {
  if (!running) return;
  if (!paused && !mp && !watcher) togglePause();
  const playing = !observe && W.state_of(ME) === 0;
  $("menuTitle").textContent = mp || watcher ? "Menu" : "Paused";
  $("saveBtn").hidden = $("menuLoadBtn").hidden = !!mp || !!observe;
  $("restartBtn").hidden = !!mp || !!observe;
  $("surrenderBtn").hidden = !playing;
  delete $("surrenderBtn").dataset.sure; $("surrenderBtn").textContent = "Surrender";
  $("watchLinkBtn").hidden = !watchLink() || !!observe && observe.kind !== "out";
  $("quitBtn").textContent = watcher ? "Stop watching" : Replay.on ? "Exit replay" : mp ? "Leave game" : "New game";
  $("menuScreen").hidden = false;
};
// Two clicks, so a slip doesn't end your game.
$("surrenderBtn").onclick = e => {
  const b = e.currentTarget;
  if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Really surrender?"; return; }
  $("menuScreen").hidden = true;
  if (paused) togglePause();
  surrendered = true;
  issue({ c: 8 });
};
$("outWatchBtn").onclick = () => { $("outScreen").hidden = true; startObserving("out"); if (paused && !mp) togglePause(); };
$("outLeaveBtn").onclick = leaveOut;
$("saveBtn").onclick = () => saveGame();
$("menuLoadBtn").onclick = () => openLoadScreen("menuScreen");
$("startLoadBtn").onclick = () => openLoadScreen("startScreen");
$("loadClose").onclick = () => closeLoadScreen();
$("loadFileBtn").onclick = () => $("loadFile").click();
$("loadFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d && d.kind === "replay") await Replay.open(d); else await loadSave(d);
  } catch { toast("That file isn't a VibeCraft save or replay.", "bad"); }
};
$("resumeBtn").onclick = () => { $("menuScreen").hidden = true; if (paused) togglePause(); };
$("restartBtn").onclick = () => { $("menuScreen").hidden = true; newGame(undefined, 0, lastPlayers); Rec.real = true; };
$("quitBtn").onclick = toMenu;
// Copy the invite link. Some app views refuse the clipboard: then select it
// so it can be copied by hand.
$("copyLink").onclick = () => {
  const input = $("inviteLink"), btn = $("copyLink");
  const selectIt = () => { input.focus(); input.select(); btn.textContent = "Press Ctrl+C"; };
  try {
    navigator.clipboard.writeText(input.value).then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy link"; }, 1500); }, selectIt);
  } catch { selectIt(); }
};
$("inviteLink").onfocus = e => e.target.select();
const joinTyped = () => { const c = codeIn($("joinLink").value); if (c) joinLobby(c); else mpStatus("That doesn't look like an invite link.", true); };
$("joinBtn").onclick = joinTyped;
$("joinLink").addEventListener("keydown", e => { if (e.key === "Enter") joinTyped(); });
$("relayUrl").addEventListener("change", () => { Net.relayUrl = $("relayUrl").value.trim(); openOwnLobby(); });
// Opening an invite link in a tab that already has the game open.
window.addEventListener("hashchange", () => {
  const w = watchIn(location.hash);
  if (w && !(running && !observe)) { startWatching(w); return; }
  const c = codeIn(location.hash); if (c && !inGame()) joinLobby(c);
});
$("techClose").onclick = () => { $("techScreen").hidden = true; };

// ---- start ----
// The loading screen (#boot, in index.html) is up from the first paint.
// Starting is a few heavy steps; between them the page pauses for a frame,
// so the screen can show how far along we are.
const Boot = {
  step(text, part) { $("bootStep").textContent = text; $("bootFill").style.transform = `scaleX(${part})`; },
  // Let the browser paint. (Animation frames stop in a background tab, so
  // don't wait for one forever.)
  breathe() {
    return new Promise(done => {
      let went = false;
      const go = () => { if (!went) { went = true; setTimeout(done, 0); } };
      requestAnimationFrame(go); setTimeout(go, 120);
    });
  },
  fail(text) { this.step(text, 1); $("bootStep").style.color = "var(--bad)"; $("bootTip").textContent = ""; },
  // Fade out once the title scene has really been drawn.
  done() {
    this.step("Ready", 1);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $("boot").classList.add("gone");
      setTimeout(() => $("boot").remove(), 700);
    }));
  },
};
(async () => {
  if (!window.THREE) {
    Boot.fail("The 3D library (three.js) didn't load. It comes from cdn.jsdelivr.net: check your internet connection and reload.");
    return;
  }
  $("boot").classList.add("busy"); // see #boot.busy in index.html
  Boot.step("Waking the engine…", 0.12);
  await Boot.breathe();
  await loadWasm();
  initWatchUi();
  initChatUi();
  Boot.step("Carving the models…", 0.3);
  await Boot.breathe();
  initRenderer();
  resizeView();
  Boot.step("Shaping the land…", 0.55);
  await Boot.breathe();
  // A live map behind the title screen.
  newGame();
  running = false; titleSpin = true;
  renderLobby();
  Boot.step("Lighting the scene…", 0.8);
  await Boot.breathe();
  // Compile the shaders before the first frame, in the background where the
  // browser can (otherwise the first frame does it, and the page freezes).
  readWorld();
  try { await Promise.race([R3.renderer.compileAsync(R3.scene, R3.camera), new Promise(r => setTimeout(r, 4000))]); } catch { /* the first frame will */ }
  requestAnimationFrame(loop);
  Boot.done();
  setInterval(() => { renderNetStatus(); lobbyTick(); }, 1000);
  // On claude.ai the page talks to other viewers through claude.ai. Elsewhere
  // it goes through a relay server: served from a web server, assume the relay
  // sits next to the page at ./relay; a copy opened as a file has to be told.
  const onClaude = !!(window.claude && window.claude.use);
  const onSite = /^https?:$/.test(location.protocol) && !onClaude;
  if (onSite) $("relayUrl").value = new URL("relay", location.href.split("#")[0]).href.replace(/^http/, "ws");
  const hasRoom = await Net.init($("relayUrl").value.trim());
  netOk = hasRoom || !onClaude;
  $("relayRow").hidden = onClaude || onSite;
  // Where opening a link doesn't work (claude.ai, a file), paste it instead.
  $("joinRow").hidden = !netOk || onSite;
  if (hasRoom) {
    // On claude.ai everyone here was invited by the page's owner: list their lobbies.
    pageRoom = await Net.lobby();
    pageRoom.onPeers(peers => {
      const box = $("openGames");
      box.replaceChildren();
      for (const p of peers) {
        const code = p.presence && p.presence.hosting;
        if (typeof code !== "string" || !/^[A-Z0-9]{6}$/.test(code) || code === roomCode || p.presence.v !== NET.PROTOCOL) continue;
        const b = document.createElement("button");
        b.className = "ghost"; b.textContent = `Join game ${code}`;
        b.onclick = () => joinLobby(code);
        box.append(b);
      }
    });
  } else if (onClaude) {
    mpStatus(Net.diag.room === "no answer from claude.ai"
      ? "Playing with friends can't reach claude.ai from this page. Your browser may be blocking it: in Firefox, turn off Enhanced Tracking Protection for this site (the shield in the address bar), or pause your ad blocker here, then reload."
      : "Playing with friends isn't available in this view. You need to be signed in to claude.ai and invited to this game (the owner adds you with Share).", true);
  }
  const invited = codeIn(location.hash), toWatch = watchIn(location.hash);
  if (toWatch && netOk) startWatching(toWatch);
  else if (invited && netOk) joinLobby(invited);
  else if (netOk) openOwnLobby($("mpStatus").textContent, $("mpStatus").classList.contains("bad"));
})();
