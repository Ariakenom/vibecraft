// ===========================================================================
// 3D rendering with three.js.
//
// The simulation is still flat 2D in Rust: map tile (x, y). Here that becomes
// three.js world (x, height, z) with z = map y, so one tile is one unit.
// Hills are only visual: units walk on the same flat grid, and we just set
// their height from the terrain under them.

// How long a unit takes to slide to where a multiplayer correction put it.
const NUDGE_MS = 150;
const R3 = {
  gpuMs: 0,
  mark: 0,
  nudges: new Map(), // unit id -> { dx, dy, t }: offset to fade out (see mpHooks.restore in main.js)
  renderer: null, scene: null, camera: null, sun: null,
  terrain: null, water: null, heights: null,
  fowTex: null, fowData: null,
  objs: new Map(), // entity id -> { root, body, tool, kind, owner, face, ... }
  dying: [],
  res: null, // instanced meshes for resources
  resKey: "",
  arrows: null,
  ring: null, ringBig: null,
  ghost: null, ghostKind: -1, footprint: null,
  rally: null,
  markers: [],
  raycaster: null,
  pickables: [],
};

// --- Fog of war -------------------------------------------------------------
// One texture, a texel per tile,, sampled in every material's fragment shader to darken
// what you can't see. three.js lets us patch its built-in shaders with
// `onBeforeCompile`, so we keep normal lighting and shadows for free.
const fowUniforms = { uFow: { value: null }, uMapSize: { value: null } };
// Time in seconds, shared by the water and the swaying grass, trees and flags.
const timeUniform = { value: 0 };
// How much things move in the wind (0 on the Low graphics setting).
const swayUniform = { value: 1 };
function withFow(mat, extra) {
  // three.js reuses a compiled shader for any material whose onBeforeCompile
  // has the same source text. This wrapper's text is the same for every
  // material, so each patch needs its own key, or (say) the swaying trees
  // would silently get the plain shader of whichever material compiled first.
  const key = "fow:" + (extra ? extra.cacheKey || extra.toString() : "");
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = sh => {
    if (extra) extra(sh);
    sh.uniforms.uFow = fowUniforms.uFow;
    sh.uniforms.uMapSize = fowUniforms.uMapSize;
    sh.vertexShader = "varying vec2 vFowW;\n" + sh.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
      vec4 fowP = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        fowP = instanceMatrix * fowP;
      #endif
      vFowW = (modelMatrix * fowP).xz;`);
    sh.uniforms.uCloudT = timeUniform;
    let fs = sh.fragmentShader.replace("#include <dithering_fragment>", `#include <dithering_fragment>
      gl_FragColor.rgb *= texture2D(uFow, vFowW / uMapSize).r;`);
    if (fs.includes("#include <lights_fragment_begin>")) {
      fs = fs.replace("#include <lights_fragment_begin>", THREE.ShaderChunk.lights_fragment_begin.replace(
        "getDirectionalLightInfo( directionalLight, directLight );",
        "getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cloudShade(vFowW);"));
    }
    sh.fragmentShader = "uniform sampler2D uFow;\nuniform vec2 uMapSize;\nvarying vec2 vFowW;\n" + NOISE_GLSL + CLOUD_GLSL + fs;
  };
  return mat;
}

// --- Wind ----------------------------------------------------------------------
// Everything that moves in the wind is moved by the vertex shader, so it costs
// no JavaScript per frame. The wind blows from the west-southwest, in gusts
// that roll across the map.
const WIND_GLSL = `
  uniform float uTime;
  uniform float uSway;
  const vec2 WIND = vec2(0.82, 0.57);
  // 0.4 .. 1: how strong the wind is at this spot right now.
  float gustAt(vec2 p) { return 0.7 + 0.3 * sin(dot(p, WIND) * 0.18 - uTime * 0.9) * sin(p.y * 0.07 + uTime * 0.23); }
`;

// Flags: entity models carry an `aWave` attribute (0 except on flag cloth,
// where it's the distance from the pole) and the cloth ripples sideways.
function flagPatch(sh) {
  sh.uniforms.uTime = timeUniform;
  sh.uniforms.uSway = swayUniform;
  sh.vertexShader = "attribute float aWave;\n" + WIND_GLSL + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
    if (aWave > 0.0) {
      vec2 at = vec2(modelMatrix[3][0], modelMatrix[3][2]);
      float ph = uTime * 6.0 - aWave * 4.5 + at.x * 1.7 + at.y * 1.3;
      transformed.z += sin(ph) * 0.07 * aWave * uSway * gustAt(at);
      transformed.y += sin(ph * 0.5 + 1.0) * 0.015 * aWave * uSway;
    }`);
}

// Trees bend from the trunk, more toward the top, leaning downwind with a
// slow sway; the leaves add a quick flutter. Each tree is turned at random,
// so the world-space wind is turned into the tree's own frame first.
const TREE_SWAY_GLSL = `#include <begin_vertex>
  #ifdef USE_INSTANCING
    vec2 base = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
    mat3 toLocal = transpose(mat3(instanceMatrix));
    float sc = length(instanceMatrix[0].xyz);
    toLocal /= sc * sc;
  #else
    vec2 base = vec2(0.0);
    mat3 toLocal = mat3(1.0);
  #endif
  float g = gustAt(base);
  float bendH = max(position.y - 0.2, 0.0);
  float bend = bendH * bendH * uSway;
  float sway = 0.5 + 0.4 * sin(uTime * 1.4 + base.x * 0.9 + base.y * 0.7) + 0.1 * sin(uTime * 2.3 + base.y * 1.1); // 0..1
  vec3 push = vec3(WIND.x, 0.0, WIND.y) * (0.025 + 0.045 * sway) * g * bend;
  push.y -= dot(push, push) * 2.0; // keep the top on its arc instead of stretching
  transformed += toLocal * push;
  float leaf = smoothstep(0.45, 0.8, position.y) * uSway * g;
  transformed += vec3(sin(uTime * 7.0 + position.y * 23.0 + base.x * 3.0), 0.0, cos(uTime * 6.3 + position.x * 19.0 + base.y * 3.0)) * 0.012 * leaf;`;
function treePatch(sh) {
  sh.uniforms.uTime = timeUniform;
  sh.uniforms.uSway = swayUniform;
  sh.vertexShader = WIND_GLSL + sh.vertexShader.replace("#include <begin_vertex>", TREE_SWAY_GLSL);
}

// --- Surface detail in the shaders -------------------------------------------------
// Smooth 3D value noise, for detail computed per pixel: the shoreline, sand
// grain, stone and gold veins. Per pixel stays sharp however close the camera
// gets, where a painted texture would blur.
const NOISE_GLSL = `
  #ifndef VC_NOISE
  #define VC_NOISE
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float vnoise2(vec2 p) { return vnoise3(vec3(p, 0.37)); }
  #endif
`;

// --- Sky and clouds -------------------------------------------------------------------
// One sun for everything: the light, the sky's glow, the glints on water.
const SUN_DIR = new THREE.Vector3(-17, 21, 11).normalize();
const SKY_GLSL = `
  #ifndef VC_SKY
  #define VC_SKY
  const vec3 SUN_DIR = vec3(${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.y.toFixed(4)}, ${SUN_DIR.z.toFixed(4)});
  // The colour of the sky in a direction (world space, normalized), in linear light.
  vec3 skyColor(vec3 d) {
    vec3 zenith = vec3(0.1, 0.27, 0.62), horizon = vec3(0.42, 0.56, 0.68), below = vec3(0.05, 0.16, 0.24);
    float h = d.y;
    vec3 c = h > 0.0 ? mix(horizon, zenith, pow(min(h * 1.4, 1.0), 0.55)) : mix(horizon, below, min(-h * 5.0, 1.0));
    float s = max(dot(d, SUN_DIR), 0.0);
    c += vec3(1.0, 0.72, 0.4) * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.6);   // warm glow around the sun
    c = mix(c, c * vec3(1.1, 1.0, 0.88), (1.0 - abs(h)) * 0.4);             // and a warm haze low down
    return c;
  }
  #endif
`;
// Cloud shadows: patches of shade drifting across the land with the wind.
// Computed per pixel in every lit material, as a dimmer on the sunlight only,
// so shaded ground still gets the sky's light.
const CLOUD_GLSL = `
  uniform float uCloudT;
  float cloudShade(vec2 p) {
    vec2 q = p * 0.045 + vec2(0.82, 0.57) * uCloudT * 0.012;
    float n = vnoise2(q) * 0.62 + vnoise2(q * 2.3 + 5.0) * 0.28 + vnoise2(q * 5.1 + 9.0) * 0.1;
    return 1.0 - 0.55 * smoothstep(0.5, 0.66, n);
  }
`;
// Pass the world position of each pixel to the fragment shader as vGW.
function worldPosPatch(sh) {
  sh.vertexShader = "varying vec3 vGW;\n" + sh.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
    vec4 gwP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      gwP = instanceMatrix * gwP;
    #endif
    vGW = (modelMatrix * gwP).xyz;`);
  sh.fragmentShader = "varying vec3 vGW;\n" + NOISE_GLSL + sh.fragmentShader;
}

// The ground: beaches are drawn here from each pixel's height, so the line
// between grass and sand is crisp, a little ragged, and darker where the sand
// is wet. Grass and sand get a fine grain. The painted texture only provides
// the broad colours (meadow patches, earth and rock on slopes).
function groundPatch(sh) {
  worldPosPatch(sh);
  sh.fragmentShader = sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
    {
      vec2 g = vGW.xz;
      float gn = vnoise2(g * 0.8) * 0.6 + vnoise2(g * 2.6) * 0.3 + vnoise2(g * 7.0) * 0.1;
      float line = 0.13 + (gn - 0.5) * 0.18;               // the height where grass gives way to sand
      float sandAmt = 1.0 - smoothstep(line - 0.008, line + 0.008, vGW.y);
      float grain = vnoise2(g * 40.0), grain2 = vnoise2(g * 13.0);
      vec3 dry = vec3(0.60, 0.49, 0.24), wet = vec3(0.33, 0.25, 0.12);
      vec3 sand = mix(dry, wet, smoothstep(${(WATER_Y + 0.14).toFixed(3)}, ${(WATER_Y + 0.01).toFixed(3)}, vGW.y));
      sand *= 0.9 + 0.12 * grain + 0.08 * grain2;
      // Below the waterline the painted seabed shows through.
      sandAmt *= smoothstep(${(WATER_Y - 0.3).toFixed(3)}, ${(WATER_Y - 0.08).toFixed(3)}, vGW.y);
      // A slightly darker rim of grass along the beach makes the edge read.
      float rim = smoothstep(line + 0.008, line + 0.02, vGW.y) * (1.0 - smoothstep(line + 0.03, line + 0.07, vGW.y));
      vec3 grass = diffuseColor.rgb * (1.0 - 0.14 * rim);   // flat: the 3D clumps carry the detail
      diffuseColor.rgb = mix(grass, sand, sandAmt);
    }`);
}

// Stone: keeps its flat facets, with a stony surface painted on per pixel:
// mottled tone, faint layers, hairline cracks and dark specks. Gold ore is the
// same stone with branching gold veins over about half of it, which catch the
// light.
function rockPatch(gold) {
  const patch = sh => {
    worldPosPatch(sh);
    sh.fragmentShader = sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      vec3 rp = vGW * 5.0;
      float n1 = vnoise3(rp), n2 = vnoise3(rp * 3.1), n3 = vnoise3(rp * 9.7);
      float layers = 0.5 + 0.5 * sin(vGW.y * 26.0 + n1 * 5.0);
      diffuseColor.rgb *= 0.8 + 0.24 * n1 + 0.1 * n2 + 0.06 * layers;
      float crack = 1.0 - smoothstep(0.0, 0.025, abs(vnoise3(rp * 1.6 + 4.0) - 0.5));
      diffuseColor.rgb *= 1.0 - 0.4 * crack - 0.35 * smoothstep(0.8, 0.86, n3);
      float vein = 0.0;
      ${gold ? `
      // Two networks of thin lines (where a noise field crosses 0.5) make
      // branching veins; together they cover about half the stone.
      float va = vnoise3(vGW * 6.0) * 0.7 + vnoise3(vGW * 14.0 + 2.0) * 0.3;
      float vb = vnoise3(vGW * 5.0 + 7.0) * 0.7 + vnoise3(vGW * 12.0 + 9.0) * 0.3;
      vein = max(1.0 - smoothstep(0.045, 0.07, abs(va - 0.5)), 1.0 - smoothstep(0.035, 0.06, abs(vb - 0.5)));
      vec3 goldCol = vec3(0.82, 0.5, 0.07) * (0.7 + 0.5 * n2);
      diffuseColor.rgb = mix(diffuseColor.rgb, goldCol, vein);` : ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      ${gold ? `totalEmissiveRadiance += vec3(0.5, 0.32, 0.04) * vein * (0.15 + 0.85 * smoothstep(0.8, 0.9, vnoise3(vGW * 30.0)));` : ""}`);
  };
  patch.cacheKey = gold ? "gold" : "stone";
  return patch;
}

// A big sphere around the camera, painted with the sky colour, the sun's
// glow and drifting clouds. Drawn first, behind everything.
function buildSky(scene) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCloudT: timeUniform },
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: NOISE_GLSL + SKY_GLSL + `
      uniform float uCloudT; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyColor(d);
        if (d.y > 0.0) {
          // Clouds on a flat layer above: the same pattern that shades the ground.
          vec2 p = d.xz / (d.y + 0.08) * 40.0;
          vec2 q = p * 0.045 + vec2(0.82, 0.57) * uCloudT * 0.012;
          float n = vnoise2(q) * 0.62 + vnoise2(q * 2.3 + 5.0) * 0.28 + vnoise2(q * 5.1 + 9.0) * 0.1;
          float cl = smoothstep(0.48, 0.7, n) * smoothstep(0.0, 0.25, d.y);
          vec3 lit = vec3(1.0, 0.95, 0.88) * (0.85 + 0.4 * pow(max(dot(d, SUN_DIR), 0.0), 4.0));
          c = mix(c, lit, cl * 0.85);
        }
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  R3.sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), mat);
  R3.sky.renderOrder = -10;
  R3.sky.frustumCulled = false;
  scene.add(R3.sky);
}

// --- Model building ----------------------------------------------------------
// Every unit and building is made of simple shapes (boxes, cylinders, cones)
// merged into ONE geometry with per-vertex colours. One mesh per model means
// one draw call, which matters with hundreds of units on screen.
class Model {
  constructor() { this.parts = []; }
  // Add a shape. `geo` is already rotated/scaled as wanted; this places it.
  add(geo, color, x = 0, y = 0, z = 0, ry = 0, wave = null) {
    geo = geo.index ? geo.toNonIndexed() : geo;
    if (ry) geo.rotateY(ry);
    // How far each vertex is from the flagpole (0..1), before it's moved into place.
    const w = wave ? Array.from({ length: geo.attributes.position.count }, (_, i) => wave(geo.attributes.position.getX(i))) : null;
    geo.translate(x, y, z);
    this.parts.push([geo, new THREE.Color(color), w]);
    return this;
  }
  // A cloth flag hanging from a pole at its left edge. It waves in the wind:
  // the material's vertex shader moves each vertex by its distance from the pole.
  flag(w, h, color, x, y, z) {
    return this.add(box(w, h, 0.02), color, x, y, z, 0, px => (px + w / 2) / w);
  }
  build() {
    let n = 0;
    for (const [g] of this.parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), wav = new Float32Array(n);
    let o = 0;
    for (const [g, c, w] of this.parts) {
      const p = g.attributes.position.array, q = g.attributes.normal.array;
      pos.set(p, o * 3); nor.set(q, o * 3);
      for (let i = 0; i < g.attributes.position.count; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
      if (w) wav.set(w, o);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    out.setAttribute("color", new THREE.BufferAttribute(col, 3));
    out.setAttribute("aWave", new THREE.BufferAttribute(wav, 1));
    out.computeBoundingSphere();
    return out;
  }
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r, h, seg = 8) => new THREE.ConeGeometry(r, h, seg);
const ball = (r, d = 1) => new THREE.IcosahedronGeometry(r, d);
// A pitched roof: a box turned 45° on its long axis and squashed.
function roof(len, width, height) {
  const g = box(len, width / Math.SQRT2, width / Math.SQRT2);
  g.rotateX(Math.PI / 4); g.scale(1, height / (width / 2), 1);
  return g;
}
// Units are drawn bigger than their real footprint so they read well from
// a distance. This is only visual: the simulation doesn't change.
const UNIT_SCALE = 1.5;
// Aircraft fly this high above the ground (tiles).
const AIR_ALT = 2.6;
const SKIN = "#e0b48c", WOOD = "#7a5532", DARKWOOD = "#4e3420", STONE = "#a39a88", STONE2 = "#8a8272", IRON = "#9da3ab";

// Units face +x. Feet at y = 0. The tool (weapon or axe) is a separate mesh
// so it can swing.
function unitModel(kind, owner) {
  const team = PCOL[owner], dark = PDARK[owner];
  const m = new Model(), t = new Model();
  const legs = (y, col) => { m.add(box(0.08, 0.22, 0.08), col, 0, y, 0.055).add(box(0.08, 0.22, 0.08), col, 0, y, -0.055); };
  if (kind === K.Horseman) {
    // horse
    m.add(box(0.56, 0.22, 0.2), "#7a5232", 0, 0.42, 0);
    for (const [x, z] of [[0.2, 0.07], [0.2, -0.07], [-0.2, 0.07], [-0.2, -0.07]]) m.add(box(0.07, 0.32, 0.07), "#5d3e25", x, 0.16, z);
    const neck = box(0.12, 0.3, 0.12); neck.rotateZ(-0.6); m.add(neck, "#6e4a2c", 0.3, 0.6, 0);
    m.add(box(0.2, 0.1, 0.1), "#6e4a2c", 0.42, 0.72, 0);
    const tail = box(0.05, 0.22, 0.05); tail.rotateZ(0.5); m.add(tail, "#3a2716", -0.32, 0.4, 0);
    m.add(box(0.22, 0.05, 0.24), team, 0, 0.55, 0); // saddle cloth
    // rider
    m.add(box(0.13, 0.22, 0.17), team, -0.02, 0.69, 0);
    m.add(ball(0.065, 1), SKIN, -0.02, 0.86, 0);
    m.add(new THREE.SphereGeometry(0.07, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), IRON, -0.02, 0.875, 0);
    // lance
    const lance = cyl(0.015, 0.015, 0.8, 5); lance.rotateZ(-1.2); t.add(lance, WOOD, 0.3, 0.12, 0);
    const tip = cone(0.03, 0.1, 5); tip.rotateZ(-1.2 - Math.PI); t.add(tip, IRON, 0.68, 0.26, 0);
    return { body: m.build(), tool: t.build(), pivot: [0, 0.7, 0.11], height: 0.95 };
  }
  legs(0.11, DARKWOOD);
  const bodyCol = kind === K.Archer ? "#5d6a3a" : kind === K.Worker ? "#b89a6c" : team;
  m.add(box(0.14, 0.24, 0.2), bodyCol, 0, 0.34, 0);
  m.add(box(0.15, 0.05, 0.21), kind === K.Spearman ? dark : team, 0, 0.27, 0); // belt
  m.add(ball(0.072, 1), SKIN, 0, 0.53, 0);
  const cap = new THREE.SphereGeometry(0.078, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  if (kind === K.Spearman) {
    m.add(cap, IRON, 0, 0.545, 0);
    const shield = cyl(0.11, 0.11, 0.03, 10); shield.rotateX(Math.PI / 2); m.add(shield, dark, 0.02, 0.36, -0.13);
    m.add(cyl(0.03, 0.03, 0.035, 6).rotateX(Math.PI / 2), "#c99a45", 0.02, 0.36, -0.15);
    t.add(cyl(0.015, 0.015, 0.95, 5), WOOD, 0, 0.12, 0);
    t.add(cone(0.035, 0.12, 5), IRON, 0, 0.65, 0);
    return { body: m.build(), tool: t.build(), pivot: [0.06, 0.34, 0.12], height: 0.7, toolTilt: 0.25 };
  }
  if (kind === K.Archer) {
    m.add(cap, dark, 0, 0.55, 0);
    m.add(box(0.06, 0.24, 0.07), DARKWOOD, -0.09, 0.4, 0.04); // quiver
    const bow = new THREE.TorusGeometry(0.2, 0.013, 4, 14, Math.PI * 0.9); bow.rotateZ(-Math.PI * 0.45);
    t.add(bow, "#6b4a2a", 0.06, 0, 0);
    return { body: m.build(), tool: t.build(), pivot: [0.04, 0.38, 0.1], height: 0.66 };
  }
  // worker
  m.add(cap, team, 0, 0.545, 0);
  t.add(cyl(0.013, 0.013, 0.36, 5), WOOD, 0, 0.0, 0);
  t.add(box(0.05, 0.05, 0.11), IRON, 0, 0.17, 0.03);
  return { body: m.build(), tool: t.build(), pivot: [0.05, 0.36, 0.11], height: 0.66 };
}

// Buildings are centred on their footprint; y = 0 is the ground.
function buildingModel(kind, owner) {
  const team = PCOL[owner], dark = PDARK[owner];
  const m = new Model();
  const s = stat(kind, 6);
  // A plinth that reaches into the ground hides slopes under the building.
  if (kind !== K.Farm) m.add(box(s * 0.94, 0.5, s * 0.94), "#6f6553", 0, -0.2, 0);
  const banner = (x, z, h) => {
    m.add(cyl(0.02, 0.02, h, 5), DARKWOOD, x, h / 2, z);
    m.flag(0.3, 0.18, team, x + 0.15, h - 0.12, z);
  };
  const hall = (w, h, d, wall, roofCol, y0 = 0) => {
    m.add(box(w, h, d), wall, 0, y0 + h / 2, 0);
    for (let i = -1; i <= 1; i += 2) m.add(box(0.08, h, 0.08), DARKWOOD, i * (w / 2 - 0.02), y0 + h / 2, d / 2 - 0.02).add(box(0.08, h, 0.08), DARKWOOD, i * (w / 2 - 0.02), y0 + h / 2, -d / 2 + 0.02);
    m.add(roof(w + 0.16, d + 0.16, h * 0.7), roofCol, 0, y0 + h, 0);
    m.add(box(0.26, h * 0.6, 0.02), DARKWOOD, 0, y0 + h * 0.3, d / 2 + 0.01); // door
  };
  switch (kind) {
    case K.Capitol: {
      m.add(box(2.85, 0.3, 2.85), STONE2, 0, 0.15, 0);
      m.add(box(1.8, 1.1, 1.8), STONE, 0, 0.85, 0);
      const pyr = cone(1.4, 1.0, 4); pyr.rotateY(Math.PI / 4); m.add(pyr, team, 0, 1.9, 0);
      for (const [x, z] of [[1.15, 1.15], [-1.15, 1.15], [1.15, -1.15], [-1.15, -1.15]]) {
        m.add(cyl(0.25, 0.28, 1.4, 10), STONE, x, 0.7, z);
        m.add(cone(0.32, 0.45, 10), dark, x, 1.62, z);
      }
      for (let i = -3; i <= 3; i++) { m.add(box(0.14, 0.14, 0.14), STONE, i * 0.33, 0.37, 1.35).add(box(0.14, 0.14, 0.14), STONE, i * 0.33, 0.37, -1.35); }
      m.add(box(0.4, 0.6, 0.04), DARKWOOD, 0, 0.6, 0.91);
      m.add(cyl(0.025, 0.025, 1.0, 5), DARKWOOD, 0, 2.6, 0);
      m.flag(0.5, 0.28, team, 0.25, 2.95, 0);
      break;
    }
    case K.Barracks:
      hall(2.3, 0.85, 1.6, "#a07a4f", "#8a3e2a");
      m.add(box(0.5, 0.05, 0.05).rotateZ(0.7), IRON, -0.6, 0.6, 0.82).add(box(0.5, 0.05, 0.05).rotateZ(-0.7), IRON, -0.6, 0.6, 0.82);
      banner(1.2, 1.1, 1.4); banner(-1.2, 1.1, 1.4);
      break;
    case K.Range:
      hall(2.1, 0.75, 1.3, "#a68b5c", "#7c7a3c");
      for (const [r, c] of [[0.28, "#efe6d1"], [0.2, team], [0.1, "#efe6d1"]]) { const d = cyl(r, r, 0.04 + (0.28 - r) * 0.1, 14); d.rotateX(Math.PI / 2); m.add(d, c, 0.9, 0.55, 1.0 + (0.28 - r) * 0.05); }
      m.add(box(0.06, 0.5, 0.06), DARKWOOD, 0.9, 0.25, 0.97);
      banner(-1.25, 1.1, 1.3);
      break;
    case K.Stable:
      hall(2.4, 0.8, 1.1, "#9b7a4a", "#b59a52", 0);
      for (let i = 0; i < 7; i++) m.add(box(0.06, 0.4, 0.06), DARKWOOD, -1.2 + i * 0.4, 0.2, 1.3);
      m.add(box(2.45, 0.05, 0.04), WOOD, 0, 0.32, 1.3).add(box(2.45, 0.05, 0.04), WOOD, 0, 0.18, 1.3);
      banner(1.25, -0.9, 1.4);
      break;
    case K.Tower:
      m.add(cyl(0.55, 0.7, 2.2, 10), STONE, 0, 1.1, 0);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; m.add(box(0.18, 0.2, 0.18), STONE2, Math.cos(a) * 0.55, 2.28, Math.sin(a) * 0.55, -a); }
      m.add(cone(0.5, 0.7, 10), team, 0, 2.7, 0);
      m.add(box(0.1, 0.25, 0.03), "#2a2219", 0, 1.4, 0.6);
      break;
    case K.HuntingLodge:
      hall(1.2, 0.6, 1.0, "#b79d74", "#6d5d48");
      m.add(box(0.14, 0.42, 0.14), STONE2, 0.3, 0.86, -0.2); // chimney (smoke comes out of it)
      m.add(box(0.05, 0.5, 0.05), DARKWOOD, -0.2, 0.25, 0.75).add(box(0.05, 0.5, 0.05), DARKWOOD, 0.3, 0.25, 0.75).add(box(0.6, 0.04, 0.04), DARKWOOD, 0.05, 0.48, 0.75);
      m.add(box(0.2, 0.28, 0.02), "#a87b52", 0.05, 0.3, 0.76); // a hide drying on the rack
      m.add(box(0.3, 0.3, 0.3), "#8a6438", 0.7, 0.15, 0.55).add(box(0.25, 0.25, 0.25), "#946c3e", -0.65, 0.12, 0.6);
      m.add(cyl(0.14, 0.14, 0.3, 8), "#7a5532", 0.7, 0.15, -0.55);
      banner(-0.75, -0.6, 1.1);
      break;
    case K.LumberCamp: {
      hall(1.3, 0.6, 0.9, "#9a7448", "#6b4d2d");
      // log piles
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - i; j++) {
        const lg = cyl(0.09, 0.09, 0.8, 7); lg.rotateX(Math.PI / 2);
        m.add(lg, j % 2 ? "#7d5631" : "#8c6238", 0.75, 0.09 + i * 0.16, -0.45 + (j + i * 0.5) * 0.19);
      }
      const blade = cyl(0.22, 0.22, 0.03, 16); blade.rotateX(Math.PI / 2); m.add(blade, IRON, -0.7, 0.35, 0.55);
      banner(-0.8, -0.6, 1.0);
      break;
    }
    case K.Quarry:
      hall(1.2, 0.6, 0.9, STONE, "#6f6a62");
      for (const [x, z, sz] of [[0.65, 0.5, 0.26], [0.75, 0.15, 0.22], [0.55, -0.4, 0.3], [0.85, -0.65, 0.2], [0.6, 0.5, 0.18]]) m.add(box(sz, sz * 0.8, sz), STONE2, x, sz * 0.4 + (x === 0.6 ? 0.26 : 0), z);
      banner(-0.75, 0.65, 1.0);
      break;
    case K.Hut: {
      // A round hut: daub walls, a thatched cone with a smoke hole, a door.
      m.add(cyl(0.62, 0.66, 0.55, 12), "#b8a07a", 0, 0.28, 0);
      m.add(cone(0.86, 0.75, 12), "#b8913f", 0, 0.92, 0);
      m.add(cone(0.12, 0.12, 8), "#7a5f2a", 0, 1.32, 0);
      m.add(box(0.22, 0.36, 0.04), DARKWOOD, 0, 0.18, 0.65);
      m.add(box(0.26, 0.18, 0.22), "#8a6438", 0.62, 0.09, 0.45); // a woodpile
      m.add(cyl(0.02, 0.02, 0.8, 5), DARKWOOD, -0.72, 0.4, 0.55); m.flag(0.24, 0.15, team, -0.6, 0.72, 0.55);
      break;
    }
    case K.FishingHut: {
      hall(1.0, 0.5, 0.8, "#a38a63", "#5f6b6f");
      // A jetty of planks and a rack of drying fish.
      for (let i = 0; i < 5; i++) m.add(box(0.14, 0.05, 0.7), i % 2 ? WOOD : "#8a6a42", -0.3 + i * 0.15, 0.06, 0.75);
      m.add(box(0.04, 0.45, 0.04), DARKWOOD, 0.55, 0.22, -0.3).add(box(0.04, 0.45, 0.04), DARKWOOD, 0.55, 0.22, 0.3).add(box(0.04, 0.04, 0.64), DARKWOOD, 0.55, 0.44, 0);
      for (let i = 0; i < 4; i++) m.add(box(0.03, 0.14, 0.06), "#b9c4c9", 0.55, 0.34, -0.22 + i * 0.15);
      banner(-0.65, -0.55, 1.0);
      break;
    }
    case K.Orchard: {
      // A shed and four small fruit trees.
      m.add(box(1.85, 0.06, 1.85), "#5e7a3a", 0, 0.03, 0);
      m.add(box(0.5, 0.4, 0.4), "#9a7448", -0.55, 0.2, -0.6).add(roof(0.6, 0.5, 0.25), "#6b4d2d", -0.55, 0.4, -0.6);
      for (const [x, z] of [[0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) {
        m.add(cyl(0.04, 0.05, 0.4, 5), DARKWOOD, x, 0.2, z);
        m.add(ball(0.28, 0), "#4d7f38", x, 0.55, z);
        for (let i = 0; i < 4; i++) { const a = i * 1.7 + x; m.add(ball(0.05, 0), "#d8573e", x + Math.cos(a) * 0.2, 0.5 + (i % 2) * 0.12, z + Math.sin(a) * 0.2); }
      }
      m.add(box(0.06, 0.6, 0.06), DARKWOOD, -0.85, 0.3, 0.85); m.flag(0.26, 0.16, team, -0.72, 0.52, 0.85);
      break;
    }
    case K.Pasture: {
      // A fenced paddock with a shelter and a water trough.
      m.add(box(2.9, 0.06, 2.9), "#7a9a44", 0, 0.03, 0);
      for (let i = 0; i <= 6; i++) {
        const t = -1.4 + i * (2.8 / 6);
        for (const [x, z] of [[t, -1.4], [t, 1.4], [-1.4, t], [1.4, t]]) m.add(box(0.07, 0.42, 0.07), DARKWOOD, x, 0.21, z);
      }
      for (const h of [0.18, 0.34]) {
        m.add(box(2.85, 0.04, 0.04), WOOD, 0, h, -1.4).add(box(2.85, 0.04, 0.04), WOOD, 0, h, 1.4);
        m.add(box(0.04, 0.04, 2.85), WOOD, -1.4, h, 0).add(box(0.04, 0.04, 2.85), WOOD, 1.4, h, 0);
      }
      m.add(box(1.0, 0.55, 0.6), "#9b7a4a", -0.75, 0.28, -0.85).add(roof(1.15, 0.75, 0.3), "#b59a52", -0.75, 0.55, -0.85);
      m.add(box(0.6, 0.14, 0.22), WOOD, 0.7, 0.07, 0.8).add(box(0.52, 0.03, 0.15), "#4f87a0", 0.7, 0.13, 0.8);
      m.add(cyl(0.025, 0.025, 1.0, 5), DARKWOOD, 1.25, 0.5, -1.25); m.flag(0.3, 0.18, team, 1.4, 0.88, -1.25);
      break;
    }
    case K.Farm:
      m.add(box(2.9, 0.08, 2.9), "#6e5232", 0, 0.03, 0);
      for (let i = 0; i < 7; i++) m.add(box(2.6, 0.14, 0.16), i % 2 ? "#a7b44a" : "#93a541", 0, 0.12, -1.2 + i * 0.4);
      for (const [x, z] of [[1.45, 1.45], [-1.45, 1.45], [1.45, -1.45], [-1.45, -1.45]]) m.add(box(0.08, 0.35, 0.08), team, x, 0.17, z);
      break;
  }
  return m.build();
}

// Trees, bushes and rocks, used through InstancedMesh (one draw call each).
function resourceModels() {
  const pine = new Model();
  pine.add(cyl(0.06, 0.08, 0.5, 6), DARKWOOD, 0, 0.25, 0);
  pine.add(cone(0.42, 0.7, 7), "#1f4428", 0, 0.75, 0).add(cone(0.34, 0.6, 7), "#285333", 0, 1.1, 0).add(cone(0.24, 0.5, 7), "#33653c", 0, 1.42, 0);
  const oak = new Model();
  oak.add(cyl(0.07, 0.1, 0.6, 6), DARKWOOD, 0, 0.3, 0);
  oak.add(ball(0.42, 0), "#2c5426", 0, 0.85, 0).add(ball(0.32, 0), "#3d6e30", 0.12, 1.12, 0.05).add(ball(0.26, 0), "#4d7f38", -0.12, 1.05, -0.1);
  const bush = new Model();
  bush.add(ball(0.26, 0), "#3e6a2f", 0, 0.2, 0).add(ball(0.2, 0), "#46783a", 0.15, 0.17, 0.1);
  for (let i = 0; i < 9; i++) { const a = i * 2.4; bush.add(ball(0.04, 0), "#c9353f", Math.cos(a) * 0.2, 0.18 + (i % 3) * 0.08, Math.sin(a) * 0.2); }
  // Grazing animals for horse and game deposits. The horse is the
  // horseman's horse from assets/models.py (`horseman()`), shape for shape
  // and in its colours, without saddle or rider, scaled like every unit by
  // UNIT_SCALE: horses look the same wherever they are. Deer are the same
  // animal, smaller and lighter, with antlers. `herd` places them on a tile:
  // [x, z, turn] each.
  const animal = (col, dark, hair, size, antlers, herd) => {
    const b = new Model(), k = size * UNIT_SCALE;
    const sph = (r, sx, sy, sz, rz = 0) => new THREE.SphereGeometry(r, 10, 6).scale(sx, sy, sz).rotateZ(rz);
    // A capsule hanging down from its top: a leg.
    const limb = (r, len) => { const g = new THREE.CapsuleGeometry(r, len, 3, 6); g.translate(0, -len / 2, 0); return g; };
    for (const [hx, hz, a] of herd) {
      const put = (geo, color, x, y, z) => {
        geo.scale(k, k, k).rotateY(-a);
        const c = Math.cos(a), sn = Math.sin(a);
        b.add(geo, color, hx + (x * c - z * sn) * k, y * k, hz + (x * sn + z * c) * k);
      };
      put(sph(0.17, 1.7, 0.9, 0.85), col, 0, 0.44, 0);                       // barrel
      for (const [x, z] of [[0.17, -0.07], [0.17, 0.07], [-0.17, -0.07], [-0.17, 0.07]]) {
        put(limb(0.045, 0.27), col, x, 0.36, z);                              // leg
        put(new THREE.CylinderGeometry(0.05, 0.055, 0.05, 8), hair, x, 0.045, z); // hoof
      }
      const neck = limb(0.075, 0.2); neck.rotateZ(Math.PI - 0.6); put(neck, col, 0.22, 0.5, 0);
      put(sph(0.085, 1.5, 0.85, 0.85, -0.35), col, 0.42, 0.75, 0);            // head
      put(sph(0.05, 1.1, 0.9, 1.3), dark, 0.53, 0.71, 0);                     // muzzle
      for (const z of [-0.04, 0.04]) put(new THREE.ConeGeometry(0.02, 0.08, 5), col, 0.36, 0.86, z); // ears
      if (antlers) for (const z of [-0.05, 0.05]) { const an = new THREE.CylinderGeometry(0.008, 0.014, 0.2, 4); an.rotateX(z * 6); put(an, "#d9c9a8", 0.37, 0.95, z); }
      else { const mane = box(0.3, 0.06, 0.035); mane.rotateZ(-0.95); put(mane, hair, 0.3, 0.7, 0); }
      const tail = new THREE.CylinderGeometry(0.04, 0.015, antlers ? 0.1 : 0.26, 6); tail.rotateZ(0.5); put(tail, hair, -0.33, 0.4, 0);
    }
    return b.build();
  };
  const rock = (gold) => {
    const r = new Model();
    for (const [x, z, s] of [[0, 0, 0.32], [0.22, 0.12, 0.22], [-0.18, -0.14, 0.2]]) r.add(new THREE.DodecahedronGeometry(s, 0), gold ? "#8c7136" : "#7f7a70", x, s * 0.6, z);
    if (gold) for (const [x, y, z] of [[0.1, 0.35, 0.2], [-0.15, 0.2, 0.2], [0.25, 0.25, -0.05], [-0.05, 0.4, -0.15]]) r.add(ball(0.05, 0), "#f4d462", x, y, z);
    return r.build();
  };
  // Medieval deposits (the Blender ones replace these when loaded).
  const iron = new Model();
  for (const [x, z, s] of [[0, 0, 0.3], [0.22, 0.12, 0.21], [-0.18, -0.14, 0.19]]) iron.add(new THREE.DodecahedronGeometry(s, 0), "#6e655c", x, s * 0.6, z);
  for (const [x, y, z] of [[0.1, 0.33, 0.18], [-0.15, 0.2, 0.18], [0.25, 0.22, -0.05]]) iron.add(ball(0.05, 0), "#9a4a2c", x, y, z);
  const clay = new Model();
  clay.add(cyl(0.42, 0.38, 0.05, 10), "#8a5236", 0, 0.025, 0).add(cyl(0.3, 0.27, 0.03, 10), "#6e3e28", 0, 0.05, 0);
  for (const [x, z] of [[0.2, 0.15], [-0.18, 0.2], [0.05, -0.22]]) clay.add(box(0.12, 0.08, 0.08), "#b9764a", x, 0.1, z);
  const sheep = new Model();
  for (const [x, z] of [[-0.12, -0.08], [0.18, 0.14]]) {
    for (const [lx, lz] of [[0.08, 0.04], [0.08, -0.04], [-0.07, 0.04], [-0.07, -0.04]]) sheep.add(box(0.025, 0.1, 0.025), "#2a221c", x + lx, 0.05, z + lz);
    sheep.add(ball(0.12, 1).scale(1.35, 0.85, 0.95), "#ece6d6", x, 0.16, z).add(ball(0.055, 1), "#2a221c", x + 0.16, 0.19, z);
  }
  return { pine: pine.build(), oak: oak.build(), bush: bush.build(), stone: rock(false), gold: rock(true), horse: animal("#8a5c36", "#6a4528", "#2a1e14", 1, false, [[0, 0, 0]]),
    deer: animal("#a87d4f", "#7a5a3a", "#5a4026", 0.62, true, [[-0.18, -0.12, 0.4], [0.22, 0.18, 2.6]]),
    iron: iron.build(), clay: clay.build(), sheep: sheep.build(), nitrate: rock(false), coal: rock(false), oil: rock(false), bauxite: rock(false), uranium: rock(false) };
}

// --- Models made in Blender ------------------------------------------------------
// assets/models.py builds the models in Blender and exports web/models.glb;
// build.sh puts that file in the page here as base64. Without it (or if it
// won't load) the game falls back to the models built in code above.
//
// Blender marks team-coloured parts magenta (TEAM) or dark magenta (TEAM_DARK),
// and they're painted in each player's colours here. Vertex colour alpha holds
// ambient occlusion baked in Blender: shading in corners, under eaves and
// where things meet the ground.
const MODELS_B64 = "/*MODELS_BASE64*/";
// Which Blender model each kind uses. Some new buildings borrow an older
// model that fits (the sawmill makes a fine lumber camp); kinds with no
// entry use the models built in code above. Made on first use: `K` lives
// in main.js, which loads after this file.
let GLB_NAMES = null;
function glbName(kind) {
  GLB_NAMES ??= { [K.Worker]: "Citizen", [K.Spearman]: "Spearman", [K.Archer]: "Archer", [K.Horseman]: "Horseman", [K.Capitol]: "Capitol", [K.Barracks]: "Barracks",
    [K.Range]: "Range", [K.Stable]: "Stable", [K.Tower]: "Tower", [K.Farm]: "Farm",
    [K.LumberCamp]: "Sawmill", [K.Quarry]: "Mason", [K.HuntingLodge]: "Settlement",
    [K.Swordsman]: "Swordsman", [K.Crossbowman]: "Crossbowman", [K.Knight]: "Knight", [K.Trebuchet]: "Trebuchet",
    [K.Cottage]: "Cottage", [K.SheepFarm]: "SheepFarm", [K.IronMine]: "IronMine", [K.Brickworks]: "Brickworks", [K.Bakery]: "Bakery",
    [K.Weaver]: "Weaver", [K.Brewery]: "Brewery", [K.SiegeWorkshop]: "SiegeWorkshop",
    [K.Musketeer]: "Musketeer", [K.Dragoon]: "Dragoon", [K.Cannon]: "Cannon", [K.Townhouse]: "Townhouse", [K.SaltpeterWorks]: "SaltpeterWorks",
    [K.PowderMill]: "PowderMill", [K.Carpenter]: "Carpenter", [K.Printer]: "Printer", [K.Circus]: "Circus",
    [K.Rifleman]: "Rifleman", [K.MachineGunner]: "MachineGunner", [K.FieldGun]: "FieldGun", [K.Tenement]: "Tenement", [K.CoalMine]: "CoalMine",
    [K.SteelMill]: "SteelMill", [K.ExplosivesWorks]: "ExplosivesWorks", [K.Cannery]: "Cannery", [K.CoalYard]: "CoalYard", [K.Press]: "Press", [K.Factory]: "Factory",
    [K.Infantry]: "Infantry", [K.Tank]: "Tank", [K.Fighter]: "Fighter", [K.Bomber]: "Bomber", [K.Apartment]: "Apartment", [K.OilWell]: "OilWell",
    [K.BauxiteMine]: "BauxiteMine", [K.PowerPlant]: "PowerPlant", [K.HaberBosch]: "HaberBosch", [K.RadioFactory]: "RadioFactory", [K.TankWorks]: "TankWorks", [K.Airfield]: "Airfield",
    [K.RocketArtillery]: "RocketArtillery", [K.Jet]: "Jet", [K.TowerBlock]: "TowerBlock", [K.UraniumMine]: "UraniumMine", [K.Reactor]: "Reactor",
    [K.CarPlant]: "CarPlant", [K.TvPlant]: "TvPlant", [K.MissileSilo]: "MissileSilo",
    [K.Sawmill]: "Lumbermill", [K.Stoneworks]: "Stoneworks", [K.Kiln]: "Kiln", [K.AirDefense]: "AirDefense" };
  return GLB_NAMES[kind];
}
const AO_STRENGTH = 0.9;
let glbModels = null; // name -> { geo, team, ao, tool, pivot }

function loadGlbModels() {
  if (MODELS_B64.startsWith("/*")) return; // not built in
  try {
    const raw = atob(MODELS_B64), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    glbModels = parseGlb(bytes.buffer);
  } catch (e) {
    console.warn("Couldn't load models.glb; using the built-in models.", e);
    glbModels = null;
  }
}

// A small reader for the glTF Binary files Blender writes: meshes with
// positions, normals, colours and custom attributes, in a node tree.
function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");
  const jlen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
  const bin = 20 + jlen + 8;
  const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const READ = { 5120: ["getInt8", 1, 127], 5121: ["getUint8", 1, 255], 5122: ["getInt16", 2, 32767], 5123: ["getUint16", 2, 65535], 5125: ["getUint32", 4, 0], 5126: ["getFloat32", 4, 0] };
  // An accessor's values as floats (normalized integers scaled to 0..1 or -1..1).
  const read = i => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], n = SIZE[a.type];
    const [fn, bytes, max] = READ[a.componentType];
    const stride = bv.byteStride || n * bytes, base = bin + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float32Array(a.count * n);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
      let v = dv[fn](base + k * stride + c * bytes, true);
      if (a.normalized) v = Math.max(v / max, -1);
      out[k * n + c] = v;
    }
    return { data: out, n, count: a.count };
  };
  const meshGeo = mi => {
    const prim = json.meshes[mi].primitives[0], at = prim.attributes;
    const pos = read(at.POSITION), count = pos.count;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos.data, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(read(at.NORMAL).data, 3));
    const col = at.COLOR_0 != null ? read(at.COLOR_0) : null;
    const rgb = new Float32Array(count * 3), ao = new Float32Array(count), team = new Uint8Array(count);
    for (let k = 0; k < count; k++) {
      const r = col ? col.data[k * col.n] : 1, g = col ? col.data[k * col.n + 1] : 1, b = col ? col.data[k * col.n + 2] : 1;
      ao[k] = col && col.n === 4 ? 1 - (1 - col.data[k * 4 + 3]) * AO_STRENGTH : 1;
      // TEAM is linear (1, 0, 1); TEAM_DARK is #800080, linear (0.216, 0, 0.216).
      team[k] = g < 0.02 && Math.abs(r - b) < 0.02 ? (r > 0.6 ? 1 : r > 0.1 ? 2 : 0) : 0;
      rgb[k * 3] = r * ao[k]; rgb[k * 3 + 1] = g * ao[k]; rgb[k * 3 + 2] = b * ao[k];
    }
    geo.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
    geo.setAttribute("aWave", new THREE.BufferAttribute(at._WAVE != null ? read(at._WAVE).data : new Float32Array(count), 1));
    if (prim.indices != null) geo.setIndex(Array.from(read(prim.indices).data));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    // Units: which bone each vertex follows (see RIG_BONES).
    const bone = at._BONE != null ? read(at._BONE).data : null;
    return { geo, team, ao, bone };
  };
  const out = {};
  const children = new Set();
  for (const nd of json.nodes) for (const c of nd.children || []) children.add(c);
  json.nodes.forEach((nd, i) => {
    if (children.has(i) || nd.mesh == null) return;
    const m = meshGeo(nd.mesh);
    for (const c of nd.children || []) {
      const cn = json.nodes[c];
      if (cn.mesh != null && /\.tool$/.test(cn.name)) { m.tool = meshGeo(cn.mesh); m.pivot = cn.translation || [0, 0, 0]; }
      else if (cn.mesh == null) (m.pivots ||= {})[cn.name.slice(cn.name.lastIndexOf(".") + 1)] = cn.translation || [0, 0, 0];
    }
    out[nd.name] = m;
  });
  return out;
}

// A copy of a Blender model's geometry painted in a player's colours.
function teamGeo(m, owner) {
  const geo = m.geo.clone();
  const col = geo.attributes.color.array;
  const c1 = new THREE.Color(PCOL[owner]), c2 = new THREE.Color(PDARK[owner]);
  for (let k = 0; k < m.team.length; k++) {
    if (!m.team[k]) continue;
    const c = m.team[k] === 1 ? c1 : c2, a = m.ao[k];
    col[k * 3] = c.r * a; col[k * 3 + 1] = c.g * a; col[k * 3 + 2] = c.b * a;
  }
  if (m.bone) {
    // Rigid skinning: every vertex follows exactly one bone.
    const n = m.bone.length, idx = new Uint16Array(n * 4), wgt = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) { idx[k * 4] = Math.round(m.bone[k]); wgt[k * 4] = 1; }
    geo.setAttribute("skinIndex", new THREE.BufferAttribute(idx, 4));
    geo.setAttribute("skinWeight", new THREE.BufferAttribute(wgt, 4));
  }
  return geo;
}

function glbModel(kind, owner) {
  const m = glbModels && glbModels[glbName(kind)];
  if (!m) return null;
  if (isBld(kind)) return { body: teamGeo(m, owner) };
  if (!m.tool) return null;
  // Keep the code model's settings (tool tilt), swap the shapes.
  const code = unitModel(kind, owner);
  code.body.dispose(); code.tool.dispose();
  const out = Object.assign(code, { body: teamGeo(m, owner), tool: teamGeo(m.tool, owner), pivot: m.pivot, height: m.geo.boundingBox.max.y });
  // A rigged unit: the game animates its skeleton (see animateRig).
  if (m.bone && m.pivots) out.rig = { pivots: m.pivots, toolAt: m.pivot, toolBone: kind === K.Archer ? "armL" : "armR" };
  return out;
}

// --- Setup -------------------------------------------------------------------
let entMat, ghostMat, hitMat, treeMat, treeDepthMat, stoneMat, goldMat;
const modelCache = new Map();
function cachedModel(kind, owner) {
  const key = kind * 8 + owner;
  if (!modelCache.has(key)) modelCache.set(key, glbModel(kind, owner) || (isBld(kind) ? { body: buildingModel(kind, owner) } : unitModel(kind, owner)));
  return modelCache.get(key);
}

function initRenderer() {
  const r = new THREE.WebGLRenderer({ canvas: view, antialias: true });
  r.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic tone mapping rolls bright sunlit faces off gently instead of
  // clipping them, and deepens the shade, for a richer, less flat picture.
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.25;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  R3.renderer = r;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#12303f"); // under the sky dome; only seen if it fails
  // A light, sky-coloured haze in the distance gives the view depth, and
  // melts the far sea into the horizon.
  scene.fog = new THREE.Fog(new THREE.Color().setRGB(0.44, 0.56, 0.66), 60, 200);
  buildSky(scene);
  R3.scene = scene;
  R3.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);

  // A cool sky fill and a warm, fairly low afternoon sun: long shadows and
  // warm light against cool shade.
  scene.add(new THREE.HemisphereLight("#cfe1f2", "#54462f", 1.35));
  const sun = new THREE.DirectionalLight("#ffe4bd", 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  R3.sun = sun;

  entMat = withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), flagPatch);
  // Swapped in for a moment when something is hit: a warm glow, not a size change.
  hitMat = withFow(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: "#ff7a4d", emissiveIntensity: 0.55 }), flagPatch);
  // Trees and bushes sway. The shadow pass gets the same sway, or the
  // shadows would stand still under moving trees.
  treeMat = withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), treePatch);
  treeDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  treeDepthMat.onBeforeCompile = treePatch;
  stoneMat = withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), rockPatch(false));
  goldMat = withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), rockPatch(true));
  ghostMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
  R3.raycaster = new THREE.Raycaster();

  // Selection rings, shared geometry; each selected thing gets a mesh.
  R3.ringGeo = new THREE.RingGeometry(0.85, 1, 28).rotateX(-Math.PI / 2);
  R3.ringMats = [null, new THREE.MeshBasicMaterial({ color: "#9cf27f", transparent: true, opacity: 0.9, depthWrite: false }), new THREE.MeshBasicMaterial({ color: "#ff8a6e", transparent: true, opacity: 0.9, depthWrite: false })];

  // Arrows: one instanced mesh, up to 256 in flight.
  const ag = new THREE.BoxGeometry(0.42, 0.025, 0.025);
  R3.arrows = new THREE.InstancedMesh(ag, withFow(new THREE.MeshLambertMaterial({ color: "#e9dfc6" })), 256);
  R3.arrows.frustumCulled = false;
  scene.add(R3.arrows);
  // Stones from trebuchets: the same flight, a boulder instead of an arrow.
  R3.stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.13, 0), withFow(new THREE.MeshLambertMaterial({ color: "#7d766c" })), 64);
  R3.stones.frustumCulled = false;
  scene.add(R3.stones);
  // Missiles from air defenses: a white body with a dark nose.
  const mg = new THREE.CylinderGeometry(0.05, 0.05, 0.55, 8).rotateZ(Math.PI / 2);
  R3.missiles = new THREE.InstancedMesh(mg, withFow(new THREE.MeshLambertMaterial({ color: "#f2f1ea", emissive: "#3a3020" })), 32);
  R3.missiles.frustumCulled = false;
  scene.add(R3.missiles);
  // Rockets from rocket artillery: an olive body, a red nose, fins and a
  // burning tail, nose first along +x like the arrows.
  const rk = new Model();
  rk.add(cyl(0.045, 0.045, 0.42, 8), "#6b6f52", 0, 0, 0).add(cone(0.045, 0.12, 8), "#b23a2a", 0, 0.27, 0);
  for (let k = 0; k < 4; k++) rk.add(box(0.012, 0.1, 0.09).rotateY(k * Math.PI / 2), "#3e4146", Math.cos(k * Math.PI / 2) * 0.04, -0.17, Math.sin(k * Math.PI / 2) * 0.04);
  rk.add(cone(0.035, 0.16, 8).rotateX(Math.PI), "#ffb347", 0, -0.29, 0);
  R3.rockets = new THREE.InstancedMesh(rk.build().rotateZ(-Math.PI / 2), withFow(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: "#2a1a08" })), 64);
  R3.rockets.frustumCulled = false;
  scene.add(R3.rockets);
  // Powder smoke: white puffs that swell, drift up and shrink away.
  R3.puffMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), withFow(new THREE.MeshLambertMaterial({ color: "#e8e6e0" })), 192);
  R3.puffMesh.frustumCulled = false; R3.puffMesh.count = 0;
  scene.add(R3.puffMesh);
  R3.puffs = [];

  // Rally flag
  const rm = new Model();
  rm.add(cyl(0.02, 0.02, 0.9, 5), DARKWOOD, 0, 0.45, 0).flag(0.32, 0.2, PCOL[1], 0.16, 0.78, 0);
  R3.rally = new THREE.Mesh(rm.build(), entMat);
  R3.rallyFor = 1;
  R3.rally.visible = false;
  scene.add(R3.rally);

  loadGlbModels();
  R3.resGeo = resourceModels();
  if (glbModels) for (const [k, name] of [["pine", "Pine"], ["oak", "Oak"], ["bush", "Bush"], ["stone", "Stone"], ["gold", "Gold"], ["iron", "IronOre"], ["clay", "ClayPit"], ["sheep", "Sheep"], ["nitrate", "Saltpeter"], ["coal", "CoalSeam"], ["oil", "OilField"], ["bauxite", "Bauxite"], ["uranium", "UraniumOre"]]) {
    if (glbModels[name]) { R3.resGeo[k].dispose(); R3.resGeo[k] = glbModels[name].geo; }
  }
  buildSmoke();
  addGraphicsControls();
  applyGraphics();
}

function resizeRenderer() {
  if (!R3.renderer) return;
  R3.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, GFX.pixelRatio));
  R3.renderer.setSize(view._w, view._h, false);
  R3.camera.aspect = view._w / Math.max(1, view._h);
  R3.camera.updateProjectionMatrix();
}

// --- Terrain -----------------------------------------------------------------
// Height in world units for a tile's noise value (0..1). Water sits low.
function elevOf(ht) {
  if (ht < 0.34) return -0.3 - (0.34 - ht) * 4;
  let e = (ht - 0.36) * 2.6;
  if (ht > 0.58) e += (ht - 0.58) * 4; // hills rise a little faster
  return e;
}

// Heights live on tile CORNERS: (MW+1) × (MH+1) of them. Called before the
// terrain texture is painted, so the painter can colour slopes as rock.
function computeHeights() {
  const ter = u8(W.terrain_ptr(), MW * MH), shade = u8(W.shade_ptr(), MW * MH);
  const cw = MW + 1, ch = MH + 1;
  let h = new Float32Array(cw * ch);
  const wet = new Uint8Array(cw * ch);
  // How much of each corner's ground is land (0..1): the shore runs where
  // land meets water, so a corner half and half sits at the waterline.
  const landShare = new Float32Array(cw * ch);
  for (let cy = 0; cy <= MH; cy++) for (let cx = 0; cx <= MW; cx++) {
    let sum = 0, n = 0, land = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const tx = cx + dx, ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) continue;
      sum += elevOf(shade[ty * MW + tx] / 255); n++;
      if (ter[ty * MW + tx] === 1) wet[cy * cw + cx] = 1; else land++;
    }
    h[cy * cw + cx] = n ? sum / n : -1;
    landShare[cy * cw + cx] = n ? land / n : 0;
  }
  // Two blur passes turn the blocky per-tile steps into rolling hills.
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(h.length);
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
        const wgt = dx || dy ? 1 : 2;
        sum += h[y * cw + x] * wgt; n += wgt;
      }
      o[cy * cw + cx] = sum / n;
    }
    h = o;
  }
  // Keep water below the surface and land above it. A corner on the shore
  // (water and land both) sits at the waterline, a little above where it's
  // mostly land, a little below where it's mostly water. (Pulling every
  // corner that touched water down to the seabed drew beaches half a tile
  // into the sea, and sank thin strips of land you could still walk on.)
  for (let i = 0; i < h.length; i++) {
    const l = landShare[i];
    h[i] = l === 0 ? Math.min(h[i], -0.4) : l === 1 ? Math.max(h[i], 0.02) : WATER_Y + (l - 0.5) * 0.3;
  }
  R3.heights = h;
  R3.wet = wet;
}

// Slope (0 flat .. ~1 steep) at a map position, from the corner heights.
function slopeAt(x, y) {
  const e = 0.5;
  const dx = hAt(x + e, y) - hAt(x - e, y), dy = hAt(x, y + e) - hAt(x, y - e);
  return Math.hypot(dx, dy);
}

const WATER_Y = -0.12;

function buildWorld() {
  const scene = R3.scene;
  for (const o of R3.objs.values()) scene.remove(o.root);
  R3.objs.clear();
  for (const d of R3.dying) scene.remove(d.root);
  R3.dying = [];
  for (const k of ["terrain", "shore", "water", "tufts", "flowers", "pebbles"]) if (R3[k]) { scene.remove(R3[k]); R3[k].geometry.dispose(); R3[k] = null; }
  if (R3.res) for (const m of Object.values(R3.res)) scene.remove(m);
  R3.resKey = "";
  R3.flattened = new Set();

  const h = R3.heights, cw = MW + 1;
  const geo = new THREE.PlaneGeometry(MW, MH, MW, MH);
  geo.rotateX(-Math.PI / 2);
  geo.translate(MW / 2, 0, MH / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const cx = Math.round(pos.getX(i)), cz = Math.round(pos.getZ(i));
    pos.setY(i, h[cz * cw + cx]);
  }
  geo.computeVertexNormals();
  const tex = new THREE.CanvasTexture(terrainCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = R3.renderer.capabilities.getMaxAnisotropy();
  const terrain = new THREE.Mesh(geo, withFow(new THREE.MeshLambertMaterial({ map: tex }), groundPatch));
  terrain.receiveShadow = true;
  scene.add(terrain);
  R3.terrain = terrain;

  buildShore();
  buildWater();
  // The rally flag wears this player's colour.
  if (R3.rallyFor !== ME) {
    const rm = new Model();
    rm.add(cyl(0.02, 0.02, 0.9, 5), DARKWOOD, 0, 0.45, 0).flag(0.32, 0.2, PCOL[ME], 0.16, 0.78, 0);
    R3.rally.geometry.dispose();
    R3.rally.geometry = rm.build();
    R3.rallyFor = ME;
  }
  buildTufts();

  // Fog-of-war texture: one texel per tile, smoothly filtered.
  R3.fowData = new Uint8Array(MW * MH * 4);
  R3.fowTex = new THREE.DataTexture(R3.fowData, MW, MH, THREE.RGBAFormat);
  R3.fowTex.magFilter = THREE.LinearFilter; R3.fowTex.minFilter = THREE.LinearFilter;
  fowUniforms.uFow.value = R3.fowTex;
  fowUniforms.uMapSize.value = new THREE.Vector2(MW, MH);

  // Resource instanced meshes, sized for the most there could be.
  // Room for every resource on the map. (Sizing this from the resources
  // explored so far was a bug: trees discovered later had no room and vanished.)
  const n = W.res_total() + 16;
  const mk = (g, cnt, sways, mat) => {
    const m = new THREE.InstancedMesh(g, mat || (sways ? treeMat : entMat), cnt);
    if (sways) m.customDepthMaterial = treeDepthMat;
    m.castShadow = true; m.receiveShadow = true; m.count = 0; scene.add(m); return m;
  };
  R3.res = { pine: mk(R3.resGeo.pine, n, true), oak: mk(R3.resGeo.oak, n, true), bush: mk(R3.resGeo.bush, n, true), stone: mk(R3.resGeo.stone, n, false, stoneMat), gold: mk(R3.resGeo.gold, n, false, goldMat),
    horse: mk(R3.resGeo.horse, n, false), deer: mk(R3.resGeo.deer, n, false),
    iron: mk(R3.resGeo.iron, n, false), clay: mk(R3.resGeo.clay, n, false), sheep: mk(R3.resGeo.sheep, n, false), nitrate: mk(R3.resGeo.nitrate, n, false), coal: mk(R3.resGeo.coal, n, false), oil: mk(R3.resGeo.oil, n, false), bauxite: mk(R3.resGeo.bauxite, n, false), uranium: mk(R3.resGeo.uranium, n, false) };
}

// --- The coast around the map ---------------------------------------------------
// The playable map is an island. Past its edge the ground keeps going and
// slopes down into open sea, with a slightly ragged coastline, so the edge
// of the world looks like a shore instead of a cliff.
const SHORE_PAD = 24;
function heightAnywhere(x, z) {
  const out = Math.hypot(Math.max(0, -x, x - MW), Math.max(0, -z, z - MH));
  if (out <= 0) return hAt(x, z);
  const ragged = out + (vnoise(x / 4, z / 4, 5) - 0.5) * 1.6;
  const drop = Math.max(0, ragged) * 0.6 + Math.max(0, ragged) ** 2 * 0.05;
  return Math.max(-2.5, Math.min(hAt(x, z), 0.6) - drop);
}
function buildShore() {
  const P = SHORE_PAD, w = MW + 2 * P, hgt = MH + 2 * P, vw = w + 1;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  const small = terrainSmall.getContext("2d").getImageData(0, 0, MW, MH).data;
  for (let j = 0; j <= hgt; j++) for (let i = 0; i <= w; i++) {
    const x = i - P, z = j - P, y = heightAnywhere(x, z);
    pos.push(x, y, z);
    // Start from the colour of the nearest map-edge tile, fade to sand, then seabed.
    const tx = Math.max(0, Math.min(MW - 1, Math.floor(x))), tz = Math.max(0, Math.min(MH - 1, Math.floor(z)));
    const k = (tz * MW + tx) * 4;
    c.setRGB(small[k] / 255, small[k + 1] / 255, small[k + 2] / 255, THREE.SRGBColorSpace);
    const sand = new THREE.Color().setRGB(204 / 255, 186 / 255, 132 / 255, THREE.SRGBColorSpace);
    const bed = new THREE.Color().setRGB(110 / 255, 122 / 255, 92 / 255, THREE.SRGBColorSpace);
    // Land outside the map is only ever a strip of beach.
    const outside = x < 0 || z < 0 || x > MW || z > MH;
    c.lerp(sand, outside ? 0.9 : Math.max(0, Math.min(1, (0.25 - y) / 0.25)));
    c.lerp(bed, Math.max(0, Math.min(1, (WATER_Y - y) / 0.8)));
    col.push(c.r, c.g, c.b);
  }
  // Only the quads outside the map: inside, the real terrain mesh is drawn.
  for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) {
    const x0 = i - P, z0 = j - P;
    if (x0 >= 0 && x0 + 1 <= MW && z0 >= 0 && z0 + 1 <= MH) continue;
    const a = j * vw + i, b = a + 1, d = a + vw, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const shore = new THREE.Mesh(geo, withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), groundPatch));
  shore.receiveShadow = true;
  R3.scene.add(shore);
  R3.shore = shore;
}

// --- Water ---------------------------------------------------------------------
// A plane with two vertices per tile. Each vertex knows how deep the water is
// there, so the shader can shade shallows turquoise, deeps blue, and draw
// lapping foam along the shore. Waves move the surface and wobble the normal,
// which makes the sun glint.
function buildWater() {
  const pad = 40, res = 2;
  const geo = new THREE.PlaneGeometry(MW + pad * 2, MH + pad * 2, (MW + pad * 2) * res, (MH + pad * 2) * res);
  geo.rotateX(-Math.PI / 2);
  geo.translate(MW / 2, WATER_Y, MH / 2);
  const pos = geo.attributes.position, depth = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // Outside the map, the sea floor keeps sloping down from the map's edge.
    depth[i] = Math.max(-0.2, WATER_Y - heightAnywhere(x, z));
  }
  geo.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
  // The ground's height under the water, 4 samples per tile, so the shader
  // knows the depth at every pixel: the foam line then follows the real
  // shoreline crisply instead of smearing across the mesh's coarse vertices.
  const HR = 4, hw = (MW + pad * 2) * HR, hh = (MH + pad * 2) * HR, hdata = new Uint16Array(hw * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) hdata[j * hw + i] = THREE.DataUtils.toHalfFloat(heightAnywhere((i + 0.5) / HR - pad, (j + 0.5) / HR - pad));
  const htex = new THREE.DataTexture(hdata, hw, hh, THREE.RedFormat, THREE.HalfFloatType);
  htex.magFilter = htex.minFilter = THREE.LinearFilter;
  htex.needsUpdate = true;
  R3.heightTex = htex;
  const mat = new THREE.MeshPhongMaterial({ color: "#2b6f8c", specular: "#5d7a88", shininess: 180, transparent: true, opacity: 0.88, depthWrite: false });
  withFow(mat, sh => {
    sh.uniforms.uTime = timeUniform;
    sh.uniforms.uHeight = { value: htex };
    sh.vertexShader = "attribute float aDepth;\nuniform float uTime;\nvarying float vDepth;\nvarying vec2 vWPos;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vDepth = aDepth;
      vWPos = position.xz;
      transformed.y += (sin(position.x * 1.3 + uTime * 1.1) + cos(position.z * 1.1 + uTime * 0.8)) * 0.02 * clamp(aDepth * 3.0, 0.0, 1.0);`);
    sh.fragmentShader = "uniform float uTime;\nuniform sampler2D uHeight;\nvarying float vDepth;\nvarying vec2 vWPos;\n" + sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ground = texture2D(uHeight, (vWPos + ${pad}.0) / vec2(${MW + pad * 2}.0, ${MH + pad * 2}.0)).r;
        float dRaw = ${WATER_Y.toFixed(3)} - ground;
        if (dRaw < -0.01) discard;
        float d = clamp(dRaw, 0.0, 2.0);
        vec3 shallow = vec3(0.13, 0.42, 0.43), deep = vec3(0.05, 0.18, 0.3);
        diffuseColor.rgb = mix(shallow, deep, smoothstep(0.05, 1.1, d));
        // A crisp line of foam where the water meets the sand, and a wave of
        // foam washing in and out just beyond it.
        float edge = 1.0 - smoothstep(0.0, 0.012, d);
        float wash = sin(uTime * 1.5 - d * 70.0 + sin(vWPos.x * 1.7) * 1.5 + cos(vWPos.y * 1.3) * 1.5);
        float wave = smoothstep(0.75, 0.95, wash) * (1.0 - smoothstep(0.015, 0.07, d));
        float foam = max(edge, wave * 0.7);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.94, 0.93), foam);
        diffuseColor.a = mix(0.7, 0.95, smoothstep(0.0, 0.5, d));
        diffuseColor.a = max(diffuseColor.a, foam * 0.92);`)
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
        vec2 wp = vWPos * 3.2;
        // Small waves fade out with distance: there they're finer than a pixel and would shimmer in stripes.
        float waveAmt = 1.0 - smoothstep(25.0, 70.0, length(vViewPosition));
        normal = normalize(normal + waveAmt * vec3(
          sin(wp.x + uTime * 1.3) * 0.12 + sin(wp.y * 1.9 - uTime * 0.9) * 0.08,
          cos(wp.y + uTime * 1.1) * 0.12 + cos(wp.x * 1.7 + uTime * 0.7) * 0.08, 0.0));`)
      // The water mirrors the sky, more so at a glancing angle (Fresnel).
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        {
          vec3 V = normalize(vViewPosition);
          vec3 R = (vec4(reflect(-V, normal), 0.0) * viewMatrix).xyz;   // to world space
          R.y = abs(R.y);
          float fres = 0.04 + 0.96 * pow(1.0 - max(dot(normal, V), 0.0), 5.0);
          totalEmissiveRadiance += skyColor(normalize(R)) * fres * 0.55 * (1.0 - foam);
        }`);
    sh.fragmentShader = SKY_GLSL + sh.fragmentShader;
  });
  const water = new THREE.Mesh(geo, mat);
  water.renderOrder = 1;
  water.receiveShadow = true;
  // Open sea out to the horizon: four big flat quads around the detailed
  // water, with the same material (the height texture reads as deep there).
  const far = 1500, x0 = -pad, x1 = MW + pad, z0 = -pad, z1 = MH + pad;
  const ring = [], quad = (ax, az, bx, bz) => ring.push(ax, WATER_Y, az, bx, WATER_Y, az, bx, WATER_Y, bz, ax, WATER_Y, az, bx, WATER_Y, bz, ax, WATER_Y, bz);
  quad(-far, -far, far, z0); quad(-far, z1, far, far); quad(-far, z0, x0, z1); quad(x1, z0, far, z1);
  const rg = new THREE.BufferGeometry();
  rg.setAttribute("position", new THREE.Float32BufferAttribute(ring, 3));
  rg.setAttribute("aDepth", new THREE.Float32BufferAttribute(new Array(ring.length / 3).fill(2), 1));
  rg.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(ring.length / 3).fill(0).flatMap(() => [0, 1, 0]), 3));
  // wind the triangles to face up
  const pa = rg.attributes.position.array;
  for (let i = 0; i < pa.length; i += 9) for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
  const sea = new THREE.Mesh(rg, mat);
  sea.renderOrder = 1;
  water.add(sea);
  R3.scene.add(water);
  R3.water = water;
}

// --- Grass tufts and flowers ----------------------------------------------------
// A few thousand little clumps of blades, one instanced mesh. The vertex
// shader bends each blade by its height so the meadow sways in the wind.
// A clump of grass: a fan of broad, pointed blades in two greens, a shade
// apart from the ground so the clumps read against the flat field.
function tuftGeometry() {
  const m = new Model();
  for (let k = 0; k < 6; k++) {
    const g = new THREE.BufferGeometry();
    const w = 0.05 - (k % 3) * 0.008, hgt = 0.17 + (k % 3) * 0.06;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, 0.015, hgt, 0]), 3));
    g.computeVertexNormals();
    g.rotateZ((k - 2.5) * 0.18);
    g.rotateY(k * 1.05);
    const a = k * 1.05;
    m.add(g, ["#6aa83c", "#4d8a2e", "#86bf4c"][k % 3], Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03);
  }
  return m.build();
}
function swayPatch(sh) {
  sh.uniforms.uTime = timeUniform;
  sh.uniforms.uSway = swayUniform;
  sh.vertexShader = "uniform float uTime;\nuniform float uSway;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
    #ifdef USE_INSTANCING
      vec2 base = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
    #else
      vec2 base = vec2(0.0);
    #endif
    float bend = position.y * position.y * 4.0 * uSway;
    transformed.x += sin(uTime * 1.7 + base.x * 0.6 + base.y * 0.3) * 0.05 * bend;
    transformed.z += cos(uTime * 1.3 + base.y * 0.5) * 0.03 * bend;`);
}
function buildTufts() {
  const ter = u8(W.terrain_ptr(), MW * MH);
  const spots = [];
  for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) {
    const t = ter[ty * MW + tx];
    if (t !== 0 && t !== 3) continue;
    // Up to 3 tufts a tile. They're drawn in a shuffled order, so the
    // graphics setting can draw any share of them and still cover the map evenly.
    for (let k = 0; k < 3; k++) spots.push([tx + 0.1 + hash2(tx * 7 + k, ty) * 0.8, ty + 0.1 + hash2(ty * 11 + k, tx * 3) * 0.8, hash2(tx + k * 13, ty * 17), hash2(tx * 5 + k * 29, ty * 3 + 11)]);
  }
  spots.sort((a, b) => a[3] - b[3]);
  R3.tuftSpots = spots;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  withFow(mat, swayPatch);
  R3.tufts = new THREE.InstancedMesh(tuftGeometry(), mat, spots.length);
  R3.tufts.receiveShadow = true;
  const fl = spots.filter(s => s[2] < 0.12);
  R3.flowerSpots = fl;
  const fmat = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  withFow(fmat, swayPatch);
  R3.flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.05, 0).scale(1, 0.6, 1).translate(0.02, 0.26, 0), fmat, Math.max(1, fl.length));
  const palette = ["#f2efe4", "#f3d55b", "#c58ad8", "#e98a5e"].map(c => new THREE.Color(c));
  fl.forEach((s, i) => R3.flowers.setColorAt(i, palette[Math.floor(s[2] * 33) % 4]));
  // A few pebbles in the grass, with the stone surface.
  R3.pebbleSpots = spots.filter(s => s[2] > 0.95);
  const pg = new THREE.DodecahedronGeometry(0.06, 0).scale(1, 0.55, 0.8).translate(0, 0.015, 0);
  pg.setAttribute("color", new THREE.Float32BufferAttribute(new Array(pg.attributes.position.count * 3).fill(0.3), 3));
  R3.pebbles = new THREE.InstancedMesh(pg, stoneMat, Math.max(1, R3.pebbleSpots.length));
  R3.pebbles.receiveShadow = true;
  placeTufts();
  applyGrass();
  R3.scene.add(R3.tufts, R3.flowers, R3.pebbles);
}
// (Re)position all tufts: called after the ground under a building is levelled.
function placeTufts() {
  const blocked = t => { const b = R3.flattened; return b && b.has(t); };
  const put = (mesh, spots) => {
    spots.forEach((s, i) => {
      // no grass on the beach (the ground shader turns low ground to sand)
      const hidden = blocked((Math.floor(s[1]) * MW + Math.floor(s[0]))) || hAt(s[0], s[1]) < 0.24;
      _p.set(s[0], hAt(s[0], s[1]) - 0.01, s[1]);
      _q.setFromAxisAngle(_up, s[2] * 40);
      _s.setScalar(hidden ? 0 : (mesh === R3.pebbles ? 0.7 : 1.0) + s[2] * 0.6);
      _m4.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  };
  put(R3.tufts, R3.tuftSpots);
  put(R3.flowers, R3.flowerSpots);
  if (R3.pebbles) put(R3.pebbles, R3.pebbleSpots);
}

// Level the ground under a building so it sits flat instead of hovering on a
// slope. We move the terrain's corner heights (which everything samples) and
// the mesh vertices, and blend the ring around it so there's no cliff.
function flattenUnder(cx, cy, s) {
  const h = R3.heights, cw = MW + 1;
  const x0 = Math.round(cx - s / 2), y0 = Math.round(cy - s / 2);
  // Corners at the water's edge stay where they are: a fishing hut by a
  // pond mustn't fill it in.
  const wet = R3.wet;
  let sum = 0, n = 0;
  for (let y = y0; y <= y0 + s; y++) for (let x = x0; x <= x0 + s; x++) if (!wet || !wet[y * cw + x]) { sum += h[y * cw + x]; n++; }
  const base = Math.max(0.02, n ? sum / n : 0.02);
  const pos = R3.terrain.geometry.attributes.position;
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x > MW || y > MH || (wet && wet[y * cw + x])) return;
    h[y * cw + x] = v;
    pos.setY(y * cw + x, v); // PlaneGeometry vertices are laid out row by row, like `h`
  };
  for (let y = y0 - 1; y <= y0 + s + 1; y++) for (let x = x0 - 1; x <= x0 + s + 1; x++) {
    if (x < 0 || y < 0 || x > MW || y > MH) continue;
    const ring = x < x0 || y < y0 || x > x0 + s || y > y0 + s;
    set(x, y, ring ? (h[y * cw + x] + base) / 2 : base);
  }
  for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) R3.flattened.add(y * MW + x);
  pos.needsUpdate = true;
  R3.terrain.geometry.computeVertexNormals();
  R3.resKey = "";
  placeTufts();
  return base;
}

function updateFowTexture() {
  if (!R3.fowData) return;
  const fog = u8(W.fog_ptr(), MW * MH), d = R3.fowData;
  for (let i = 0; i < MW * MH; i++) d[i * 4] = fog[i] === 2 ? 255 : fog[i] === 1 ? 105 : 0;
  R3.fowTex.needsUpdate = true;
}

// Terrain height at a map position, interpolated between tile corners.
function hAt(x, y) {
  const h = R3.heights; if (!h) return 0;
  const cw = MW + 1;
  x = Math.max(0, Math.min(MW - 0.001, x)); y = Math.max(0, Math.min(MH - 0.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = h[y0 * cw + x0], b = h[y0 * cw + x0 + 1], c = h[(y0 + 1) * cw + x0], d = h[(y0 + 1) * cw + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
const groundAt = (x, y) => Math.max(hAt(x, y), WATER_Y + 0.02);

// --- Camera ------------------------------------------------------------------
function placeCamera() {
  const c = R3.camera;
  const gy = Math.max(0, hAt(cam.x, cam.y));
  const horiz = Math.cos(cam.pitch) * cam.dist, up = Math.sin(cam.pitch) * cam.dist;
  c.position.set(cam.x + Math.sin(cam.yaw) * horiz, gy + up, cam.y + Math.cos(cam.yaw) * horiz);
  c.lookAt(cam.x, gy, cam.y);
  c.updateMatrixWorld();
  // The sun's shadow camera follows the view so shadows stay sharp.
  const s = R3.sun, ext = cam.dist * 1.1 + 6;
  s.position.set(cam.x - 17, gy + 21, cam.y + 11);
  // Haze starts past what you're looking at, so it only softens the far distance.
  R3.scene.fog.near = cam.dist * 1.6; R3.scene.fog.far = cam.dist * 5 + 40;
  if (R3.sky) R3.sky.position.copy(c.position);
  s.target.position.set(cam.x, gy, cam.y);
  s.target.updateMatrixWorld();
  const sc = s.shadow.camera;
  if (sc.right !== ext) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 80; sc.updateProjectionMatrix(); }
}

// Screen pixel -> the -1..1 coordinates three.js wants. One vector, reused:
// raycasting runs often, and every new object is garbage to clean up later.
const _ndc = new THREE.Vector2();
function ndc(sx, sy) { return _ndc.set((sx / view._w) * 2 - 1, -(sy / view._h) * 2 + 1); }

// Screen pixel -> map position on the ground (or null if off the map).
function screenToGround(sx, sy) {
  R3.raycaster.setFromCamera(ndc(sx, sy), R3.camera);
  const hit = R3.terrain && R3.raycaster.intersectObject(R3.terrain, false)[0];
  if (hit) return { x: hit.point.x, y: hit.point.z };
  const p = new THREE.Vector3();
  if (R3.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return { x: p.x, y: p.z };
  return null;
}

// Map position (+ height) -> screen pixels.
const _v = new THREE.Vector3();
function worldToScreen(x, y, h) {
  _v.set(x, h, y).project(R3.camera);
  return { x: (_v.x + 1) / 2 * view._w, y: (1 - _v.y) / 2 * view._h, behind: _v.z > 1 };
}

// What's under the cursor? Units are small, so we pick them in screen space
// (closest to the cursor within a few pixels), which is far more forgiving
// than a ray. Buildings and resources use a ray against their meshes.
function pickAt(sx, sy) {
  let best = null, bd = 20 * 20;
  for (let i = 0; i < entCount; i++) {
    const k = E(i, F.kind); if (isBld(k)) continue;
    const o = R3.objs.get(E(i, F.id)); if (!o) continue;
    const p = worldToScreen(o.root.position.x, o.root.position.z, o.root.position.y + o.height * 0.5);
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d < bd) { bd = d; best = { x: E(i, F.x), y: E(i, F.y), id: E(i, F.id), what: "unit" }; }
  }
  if (best) return best;
  R3.raycaster.setFromCamera(ndc(sx, sy), R3.camera);
  const targets = [];
  for (const o of R3.objs.values()) if (isBld(o.kind)) targets.push(o.body);
  if (R3.res) targets.push(...Object.values(R3.res));
  if (R3.terrain) targets.push(R3.terrain);
  const hit = R3.raycaster.intersectObjects(targets, false)[0];
  if (!hit) return screenToGround(sx, sy);
  if (hit.object === R3.terrain) return { x: hit.point.x, y: hit.point.z, what: "ground" };
  if (hit.object.isInstancedMesh) {
    const r = hit.object.userData.res[hit.instanceId];
    return { x: r[0] + 0.5, y: r[1] + 0.5, what: "res" };
  }
  const o = hit.object.userData.obj;
  return { x: o.x, y: o.y, id: o.id, what: "building" };
}

// The ground area the camera sees, as 4 map points (for the minimap).
const _quad = { p: new THREE.Vector3(), plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3), pts: [[0, 0], [0, 0], [0, 0], [0, 0]], out: [] };
function viewQuad() {
  const Q = _quad, out = Q.out;
  out.length = 0;
  for (let n = 0; n < 4; n++) {
    const sx = n === 1 || n === 2 ? view._w : 0, sy = n >= 2 ? view._h : 0;
    R3.raycaster.setFromCamera(ndc(sx, sy), R3.camera);
    if (R3.raycaster.ray.intersectPlane(Q.plane, Q.p)) { const pt = Q.pts[out.length]; pt[0] = Q.p.x; pt[1] = Q.p.z; out.push(pt); }
  }
  return out;
}

// --- Per-frame update --------------------------------------------------------
// The Capitol's gathering spot, where free workers wait and newcomers turn
// up: a town square in front of its door (+z; CAMPFIRE_AHEAD in people.rs).
// Paving fills the area (CAMPFIRE_AREA) where a worker counts as free, with
// a statue on a stepped plinth in the middle, holding a torch whose flame
// flickers (`updateCampfires`). (Named for the campfire it replaced.)
const CAMPFIRE = [0, 0.1, 3.2], CAMPFIRE_AREA = 3.0;
let campfireGeo = null, flameMat = null;
function campfire() {
  if (!campfireGeo) {
    const m = new Model();
    // Paving: a dark kerb, light stone inside, a paler inner ring, and
    // eight spokes between the two.
    m.add(cyl(CAMPFIRE_AREA, CAMPFIRE_AREA, 0.08, 40), "#7d766a", 0, 0.04, 0);
    m.add(cyl(CAMPFIRE_AREA - 0.14, CAMPFIRE_AREA - 0.14, 0.1, 40), "#bdb29d", 0, 0.05, 0);
    m.add(cyl(1.55, 1.55, 0.12, 32), "#a29a88", 0, 0.06, 0);
    m.add(cyl(1.4, 1.4, 0.14, 32), "#d3c9b4", 0, 0.07, 0);
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2, r = (1.55 + CAMPFIRE_AREA - 0.14) / 2;
      m.add(box(0.12, 0.13, CAMPFIRE_AREA - 0.14 - 1.55), "#a29a88", Math.sin(a) * r, 0.065, Math.cos(a) * r, a);
    }
    // Stone bollards round the edge, between the spokes.
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) / 8 * Math.PI * 2;
      m.add(cyl(0.08, 0.1, 0.3, 8), "#8f887b", Math.sin(a) * (CAMPFIRE_AREA - 0.3), 0.2, Math.cos(a) * (CAMPFIRE_AREA - 0.3));
    }
    // The plinth: two round steps, a square block, a cap.
    m.add(cyl(0.95, 1.0, 0.1, 20), "#b5ab98", 0, 0.19, 0);
    m.add(cyl(0.7, 0.78, 0.12, 16), "#a89f8c", 0, 0.3, 0);
    m.add(box(0.62, 0.62, 0.62), "#d8cfbb", 0, 0.66, 0);
    m.add(box(0.76, 0.1, 0.76), "#bfb6a2", 0, 1.02, 0);
    // The statue, in bronze: a robed figure with one arm up, holding a torch.
    m.add(cone(0.3, 0.8, 10), "#a67c3d", 0, 1.47, 0);
    m.add(cyl(0.12, 0.17, 0.3, 8), "#b98b45", 0, 1.8, 0);
    m.add(ball(0.12, 1), "#c29650", 0, 2.05, 0);
    const arm = box(0.07, 0.34, 0.07); arm.rotateZ(-0.35);
    m.add(arm, "#b98b45", 0.2, 2.04, 0);
    m.add(cyl(0.03, 0.03, 0.34, 6), "#6e4a26", 0.3, 2.28, 0);
    m.add(cyl(0.07, 0.04, 0.08, 8), "#8a6330", 0.3, 2.46, 0);
    campfireGeo = m.build();
    flameMat = new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.9 });
  }
  const g = new THREE.Group();
  g.position.set(CAMPFIRE[0], 0, CAMPFIRE[2]);
  const square = new THREE.Mesh(campfireGeo, entMat); square.castShadow = true; square.receiveShadow = true; g.add(square);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 7), flameMat);
  flame.position.set(0.3, 2.65, 0); flame.userData.flame = true; g.add(flame);
  (R3.flames ??= []).push(flame);
  return g;
}
function updateCampfires(now) {
  if (!R3.flames) return;
  R3.flames = R3.flames.filter(f => f.parent && f.parent.parent && f.parent.parent.parent);
  for (const f of R3.flames) { const s = 0.85 + 0.2 * Math.sin(now * 0.017 + f.id) + 0.1 * Math.sin(now * 0.041); f.scale.set(1, s, 1); f.rotation.y = now * 0.002; }
}

function makeObj(i) {
  const kind = E(i, F.kind), owner = E(i, F.owner), id = E(i, F.id);
  const mdl = cachedModel(kind, owner);
  const root = new THREE.Group();
  const body = new THREE.Mesh(mdl.body, entMat);
  body.castShadow = true; body.receiveShadow = true;
  root.add(body);
  const o = { id, kind, owner, root, body, tool: null, face: E(i, F.face), height: 0.7, x: E(i, F.x), y: E(i, F.y), lastHp: 1, ring: null };
  body.userData.obj = o;
  if (isBld(kind)) {
    const s = stat(kind, 6);
    o.baseY = flattenUnder(o.x, o.y, s);
    o.height = { [K.Farm]: 0.3, [K.Pasture]: 0.7, [K.Orchard]: 0.9, [K.FishingHut]: 1.0, [K.Tower]: 3 }[kind] || 1.6;
    if (glbModels && kind !== K.Farm) { mdl.body.computeBoundingBox(); o.height = Math.min(o.height + 0.6, mdl.body.boundingBox.max.y); }
    root.position.set(o.x, o.baseY, o.y);
    if (kind === K.Capitol) { o.campfire = campfire(); root.add(o.campfire); }
  } else if (mdl.rig) {
    root.remove(body);
    makeRigged(o, mdl);
  } else {
    const pivot = new THREE.Group();
    pivot.position.set(...mdl.pivot);
    const tool = new THREE.Mesh(mdl.tool, entMat);
    o.toolMesh = tool;
    tool.castShadow = true;
    pivot.add(tool);
    body.add(pivot);
    o.tool = pivot; o.toolTilt = mdl.toolTilt || 0;
    o.height = mdl.height * UNIT_SCALE;
    body.scale.setScalar(UNIT_SCALE);
  }
  R3.scene.add(root);
  R3.objs.set(id, o);
  return o;
}

// --- Rigged units ----------------------------------------------------------------------
// Units from Blender carry a small skeleton: every vertex follows one bone.
// The bones are animated here each frame, procedurally, for a Totally
// Accurate Battle Simulator feel: a waddling walk, a body that wobbles on a
// spring when starting and stopping, big wind-ups when working or fighting,
// a flinch when hit, and a floppy fall when killed. This is drawing only;
// the simulation doesn't know about any of it.
const RIG_BONES = ["hips", "body", "head", "armL", "armR", "legL", "legR", "legFL", "legFR", "legBL", "legBR", "neck", "tail"];
const RIG_PARENT = { body: "hips", head: "body", armL: "body", armR: "body", legL: "hips", legR: "hips",
  legFL: "hips", legFR: "hips", legBL: "hips", legBR: "hips", neck: "hips", tail: "hips" };

function makeRigged(o, mdl) {
  const pv = mdl.rig.pivots, at = n => pv[n] || pv.hips || [0, 0, 0];
  const bones = {};
  for (const n of RIG_BONES) { bones[n] = new THREE.Bone(); bones[n].name = n; }
  for (const n of RIG_BONES) {
    const p = at(n), par = RIG_PARENT[n];
    if (par) { const q = at(par); bones[n].position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]); bones[par].add(bones[n]); }
    else bones[n].position.set(p[0], p[1], p[2]);
  }
  const mesh = new THREE.SkinnedMesh(mdl.body, entMat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.add(bones.hips);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(RIG_BONES.map(n => bones[n])));
  mesh.userData.obj = o;
  o.body = mesh;
  o.root.add(mesh);
  o.bones = bones;
  o.hipsY = bones.hips.position.y;
  // The tool sits in its hand and turns with its arm.
  const tb = mdl.rig.toolBone, ta = mdl.rig.toolAt, tp = at(tb);
  const tool = new THREE.Mesh(mdl.tool, entMat);
  tool.castShadow = true;
  tool.position.set(ta[0] - tp[0], ta[1] - tp[1], ta[2] - tp[2]);
  bones[tb].add(tool);
  o.toolMesh = tool; o.toolBone = tb;
  o.height = mdl.height * UNIT_SCALE;
  mesh.scale.setScalar(UNIT_SCALE);
  Object.assign(o, { seed: (o.id * 0.6180339) % 1 * 100, lean: 0, leanV: 0, flinch: 0, flinchV: 0, wasHit: false, speed: 0, prevX: o.x, prevY: o.y });
}

// One frame of a rigged unit. anim: 0 idle, 1 walking, 2 working, 3 attacking.
function animateRig(o, kind, anim, t, dt, hit) {
  const B = o.bones;
  for (const n of RIG_BONES) B[n].rotation.set(0, 0, 0);
  B.body.scale.set(1, 1, 1);
  B.hips.position.y = o.hipsY;
  dt = Math.min(dt, 0.05);
  // How fast it's really moving, smoothed (tiles per second).
  const v = Math.hypot(o.x - o.prevX, o.y - o.prevY) / Math.max(dt, 1e-3);
  o.prevX = o.x; o.prevY = o.y;
  o.speed += (Math.min(v, 6) - o.speed) * Math.min(1, dt * 10);
  const walking = anim === 1 || o.speed > 0.4;
  // The body leans into the walk on a springy joint, so it wobbles when
  // starting and stopping.
  const leanTo = walking ? -0.2 : anim === 3 ? -0.12 : 0;
  o.leanV += ((leanTo - o.lean) * 70 - o.leanV * 8) * dt; o.lean += o.leanV * dt;
  // A flinch when hit: a kick backwards on another spring.
  if (hit && !o.wasHit) o.flinchV += 9;
  o.wasHit = hit;
  o.flinchV += (-o.flinch * 140 - o.flinchV * 11) * dt; o.flinch += o.flinchV * dt;
  const f = o.flinch;
  const T = t + o.seed;
  const horse = isMounted(kind);
  if (horse) {
    const ph = T * (walking ? 13 : 0);
    if (walking) {
      B.legFL.rotation.z = Math.sin(ph) * 0.75; B.legFR.rotation.z = Math.sin(ph + 0.7) * 0.75;
      B.legBL.rotation.z = Math.sin(ph + Math.PI) * 0.75; B.legBR.rotation.z = Math.sin(ph + Math.PI + 0.7) * 0.75;
      B.hips.position.y = o.hipsY + Math.abs(Math.sin(ph)) * 0.05;
      B.hips.rotation.z = Math.sin(ph) * 0.07;
      B.neck.rotation.z = Math.sin(ph + 0.5) * 0.15;
      B.body.rotation.z = -Math.sin(ph + 0.8) * 0.12 + o.lean * 0.6;
      B.head.rotation.z = Math.sin(ph + 1.4) * 0.12;
    } else {
      B.neck.rotation.z = Math.sin(T * 0.8) * 0.06 - 0.05;   // idle: head bobs, grazes now and then
      B.body.rotation.z = o.lean * 0.6;
    }
    B.tail.rotation.z = Math.sin(T * (walking ? 9 : 2.5)) * (walking ? 0.35 : 0.2);
    B.tail.rotation.x = Math.sin(T * 1.7) * 0.25;
    B.armL.rotation.z = 0.5; B.armL.rotation.x = 0.2;           // holding the reins
    let arm = 0.9, jab = 0;
    if (anim === 3) { jab = Math.max(0, Math.sin(T * 7)); arm = 1.0 + jab * 0.5; B.body.rotation.z -= jab * 0.25; }
    B.armR.rotation.z = arm;
    o.toolMesh.rotation.z = -arm - B.body.rotation.z + 0.12 - jab * 0.15;  // the lance stays couched, pointing forward
  } else {
    const ph = T * 10;
    const s = Math.sin(ph);
    if (walking) {
      B.legL.rotation.z = s * 0.8; B.legR.rotation.z = -s * 0.8;
      B.armL.rotation.z = -s * 0.65; B.armR.rotation.z = s * 0.65;
      B.hips.position.y = o.hipsY + Math.abs(Math.cos(ph)) * 0.035;
      B.hips.rotation.x = s * 0.13;                              // the waddle
      B.head.rotation.x = -s * 0.1;
    } else {
      B.body.scale.y = 1 + Math.sin(T * 2.2) * 0.025;            // breathing
      B.head.rotation.y = Math.sin(T * 0.7) * 0.35 * Math.max(0, Math.sin(T * 0.23));  // looks around now and then
    }
    B.armL.rotation.x += 0.12; B.armR.rotation.x -= 0.12;      // arms a little out from the body
    B.body.rotation.z = o.lean;
    B.head.rotation.z = -o.lean * 0.4;
    const tb = B[o.toolBone];
    let toolWorld = null; // the tool's angle in the unit's frame, or null to follow the arm
    if (anim === 2 || (anim === 3 && kind === K.Worker)) {
      // A big overhead chop: wind up, strike, recover.
      const c = (T * 1.5) % 1;
      const a = c < 0.55 ? 0.3 + (c / 0.55) * 2.4 : c < 0.68 ? 2.7 - ((c - 0.55) / 0.13) * 2.6 : 0.1 + ((c - 0.68) / 0.32) * 0.2;
      B.armR.rotation.z = a;
      B.body.rotation.z += c > 0.55 && c < 0.75 ? -0.3 : 0.08;
      if (!walking) { B.legL.rotation.z = 0.25; B.legR.rotation.z = -0.15; }
      o.toolMesh.rotation.z = -Math.PI / 2;                     // the head points out of the fist
    } else if (anim === 3 && (kind === K.Spearman || kind === K.Swordsman)) {
      // Jab with the spear, leaning in, shield up.
      const jab = Math.max(0, Math.sin(T * 8));
      B.armR.rotation.z = 1.2 + jab * 0.4;
      B.body.rotation.z += -jab * 0.3;
      B.armL.rotation.z = 0.9; B.armL.rotation.x = 0.4;
      if (!walking) { B.legL.rotation.z = 0.35; B.legR.rotation.z = -0.3; }
      toolWorld = -1.45 - jab * 0.1;
    } else if (anim === 3 && (kind === K.Crossbowman || kind === K.Musketeer || kind === K.Rifleman || kind === K.MachineGunner || kind === K.Infantry)) {
      // Crossbow levelled at the target in both hands; a kick when it looses.
      const kick = Math.max(0, Math.sin(T * 2.4) - 0.9) * 4;
      B.armR.rotation.z = 1.3 + kick * 0.15; B.armL.rotation.z = 1.25; B.armL.rotation.x = -0.35;
      B.body.rotation.z += -kick * 0.08;
      toolWorld = 0;
    } else if (anim === 3 && kind === K.Archer) {
      // Bow arm out front, string hand drawn back to the chest, then loose.
      const draw = Math.min(1, ((T * 0.6) % 1) * 1.6);
      B.armL.rotation.z = 1.45; B.armL.rotation.x = 0.25;
      B.armR.rotation.z = 1.2 + (1 - draw) * 0.3; B.armR.rotation.x = 0.55 * draw;
      B.body.rotation.y = 0.35;
      toolWorld = 0;
    } else {
      toolWorld = kind === K.Spearman || kind === K.Swordsman ? -0.25 : kind === K.Musketeer || kind === K.Rifleman ? 1.25 : kind === K.MachineGunner || kind === K.Infantry ? 0 : kind === K.Archer || kind === K.Crossbowman ? 0 : null;
      if (kind === K.Worker) o.toolMesh.rotation.z = -0.4;
    }
    if (toolWorld != null) o.toolMesh.rotation.z = toolWorld - tb.rotation.z - (o.toolBone === "armR" || o.toolBone === "armL" ? B.body.rotation.z : 0);
  }
  // The flinch: knocked back and squashed for a moment.
  B.body.rotation.z += f * 0.6;
  B.head.rotation.z += f * 0.5;
  B.body.scale.y *= 1 - f * 0.12;
  B.body.scale.x *= 1 + f * 0.06; B.body.scale.z *= 1 + f * 0.06;
}

// A rigged unit's death: it topples over sideways with a bounce, its limbs
// flailing and settling, lies there a moment, then sinks away.
const RIG_DEATH_MS = 3200;
function animateRigDeath(d, p, dt) {
  const B = d.o.bones, mesh = d.o.body;
  const fall = Math.min(1, p * 3.5);
  const bounce = fall < 1 ? fall * fall : 1 + Math.sin((p * 3.5 - 1) * 12) * 0.08 * Math.max(0, 1 - (p * 3.5 - 1) * 1.5);
  mesh.rotation.x = d.dir * Math.min(bounce, 1.08) * Math.PI / 2;
  const damp = Math.exp(-p * 7);
  for (const n of ["armL", "armR", "legL", "legR", "legFL", "legFR", "legBL", "legBR"]) {
    B[n].rotation.z = Math.sin(p * 38 + n.length) * 1.1 * damp + (n.startsWith("arm") ? 0.6 : 0.2);
  }
  B.head.rotation.x = Math.sin(p * 30) * 0.7 * damp + d.dir * 0.3;
  if (B.neck) B.neck.rotation.z = -0.5 * fall;
  if (p > 0.78) d.root.position.y -= dt * 0.35;
}


function setRing(o, on, size) {
  if (on && !o.ring) {
    o.ring = new THREE.Mesh(R3.ringGeo, R3.ringMats[o.owner === ME ? 1 : 2]);
    o.ring.scale.setScalar(size);
    o.ring.position.y = 0.04;
    o.ring.renderOrder = 2;
    o.root.add(o.ring);
  }
  if (o.ring) o.ring.visible = on;
}

function render3d(alpha, now, dt) {
  const t = now / 1000;
  timeUniform.value = t;
  placeCamera();
  const mark = ++R3.mark; // objects still in the world this frame get this mark

  for (let i = 0; i < entCount; i++) {
    const id = E(i, F.id), kind = E(i, F.kind);
    let o = R3.objs.get(id);
    if (o && (o.kind !== kind || o.owner !== E(i, F.owner))) { R3.scene.remove(o.root); o = null; }
    if (!o) o = makeObj(i);
    o.mark = mark;
    const flags = E(i, F.flags);
    o.lastHp = E(i, F.hp) / E(i, F.maxhp);
    o.residents = E(i, F.residents);
    // Only a player's home Capitol (their oldest finished one) has the campfire.
    if (o.campfire) o.campfire.visible = W.home_capitol(o.owner) === id;
    if (isBld(kind)) {
      const building = flags & 2;
      // Placed, but no builder there yet: only its owner sees where it will go.
      const planned = !!(flags & 512);
      o.body.visible = !planned;
      if (planned && !o.plan && E(i, F.owner) === ME) {
        const s = stat(kind, 6);
        o.plan = new THREE.Mesh(new THREE.PlaneGeometry(s, s).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: PCOL[ME], transparent: true, opacity: 0.28, depthWrite: false }));
        o.plan.position.y = 0.05; o.plan.renderOrder = 2;
        o.root.add(o.plan);
      }
      if (o.plan) o.plan.visible = planned;
      o.body.scale.y = building ? Math.max(0.12, E(i, F.prog)) : 1;
      o.body.material = (flags & 8) ? hitMat : entMat;
      setRing(o, !!(flags & 1), stat(kind, 6) * 0.78);
      continue;
    }
    let x = E(i, F.px) + (E(i, F.x) - E(i, F.px)) * alpha;
    let y = E(i, F.py) + (E(i, F.y) - E(i, F.py)) * alpha;
    // Multiplayer: a correction moved this unit; slide there instead of jumping.
    const nudge = R3.nudges.get(id);
    if (nudge) {
      const f = 1 - (now - nudge.t) / NUDGE_MS;
      if (f <= 0) R3.nudges.delete(id);
      else { x += nudge.dx * f; y += nudge.dy * f; }
    }
    o.x = x; o.y = y;
    o.root.position.set(x, groundAt(x, y) + (isAir(kind) ? AIR_ALT + Math.sin(t * 1.3 + id) * 0.08 : 0), y);
    // Turn smoothly toward the facing Rust reports (three.js turns the other way).
    let target = -E(i, F.face), d = target - o.face;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    o.face += d * Math.min(1, dt * 12);
    o.root.rotation.y = o.face;
    const anim = E(i, F.anim);
    const ph = t + id * 0.37;
    if (o.bones) animateRig(o, kind, anim, t, dt, !!(flags & 8));
    else {
      o.body.position.y = anim === 1 ? Math.abs(Math.sin(ph * 11)) * 0.035 : 0;
      o.body.rotation.z = anim === 1 ? -0.06 : 0;
    }
    if (o.tool) {
      let swing = 0;
      if (anim === 2) swing = Math.max(0, Math.sin(ph * 7)) * 1.6 - 0.4;
      else if (anim === 3) swing = kind === K.Archer ? 0.35 : kind === K.Cannon || kind === K.FieldGun || kind === K.Tank || kind === K.RocketArtillery ? -Math.max(0, Math.sin(ph * 2.5) - 0.85) * 0.6 : Math.max(0, Math.sin(ph * 9)) * 1.4 - 0.2;
      o.tool.rotation.z = -swing - o.toolTilt;
      if (isAir(kind)) { o.tool.rotation.z = 0; o.tool.rotation.x = t * 40; } // the propeller
    }
    if (isAir(kind)) { o.body.position.y = 0; o.body.rotation.z = 0; o.body.rotation.x = Math.sin(t * 0.9 + id) * 0.08; }
    const mat = (flags & 8) ? hitMat : entMat;
    o.body.material = mat;
    if (o.toolMesh) o.toolMesh.material = mat;
    setRing(o, !!(flags & 1), W.kind_radius(kind) * 1.45);
  }

  // Things that vanished: badly hurt units and buildings get a short death
  // animation; anything else just walked into the fog.
  for (const o of R3.objs.values()) { // (values(), not [id, o] pairs: no array per object per frame)
    if (o.mark === mark) continue;
    R3.objs.delete(o.id);
    if (o.ring) o.ring.visible = false;
    if (o.lastHp < 0.3) R3.dying.push({ root: o.root, t0: now, building: isBld(o.kind), o, dir: hash2(o.id, 3) < 0.5 ? 1 : -1 });
    else R3.scene.remove(o.root);
  }
  // (Kept in place rather than filtered into a new array each frame.)
  let keep = 0;
  for (const d of R3.dying) {
    const p = (now - d.t0) / (d.building ? 1600 : d.o.bones ? RIG_DEATH_MS : 1200);
    if (p >= 1) { R3.scene.remove(d.root); continue; }
    if (d.o.bones) animateRigDeath(d, p, dt);
    else if (d.building) { d.root.position.y -= dt * 1.6; d.root.rotation.z = Math.sin(p * 30) * 0.02; }
    else { d.root.children[0].rotation.x = -Math.min(1, p * 3) * Math.PI / 2; d.root.position.y -= p > 0.6 ? dt * 0.4 : 0; }
    R3.dying[keep++] = d;
  }
  R3.dying.length = keep;

  updateResources();
  updateArrows(alpha);
  updateRally();
  updateGhost();
  updateMarkers(now);
  updateSmoke();
  updateCampfires(performance.now());
  updatePuffs(performance.now());
  updateNukes(performance.now(), alpha);
  updateAimRings();
  // Timed for the trace: handing the frame to the graphics card (and
  // compiling any shader it hasn't needed before).
  const g = performance.now();
  renderScene();
  R3.gpuMs = performance.now() - g;
}

// --- The nuke ------------------------------------------------------------------
// In flight: a missile on a high arc from its silo, trailing smoke, and a red
// ring where it will fall, for everyone. When it lands (`nukeFlash`): a white
// flash over the screen, a fireball that swells and fades, a column of smoke.
// Craters: dark scorched discs, from the game's list, so saved games show them.
// Seconds per game tick, and a nuke's flight (defs.rs `NUKE_FLIGHT`).
const TICK_S = 0.05, NUKE_FLIGHT_S = 20;
function nukeMeshes() {
  if (R3.nukeMesh) return;
  const m = new Model();
  m.add(cyl(0.12, 0.12, 1.1, 8), "#d8dde3", 0, 0, 0).add(cone(0.12, 0.35, 8), "#c8453a", 0, 0.72, 0);
  for (let k = 0; k < 4; k++) m.add(box(0.03, 0.25, 0.22).rotateY(k * Math.PI / 2), "#3e4146", Math.cos(k * Math.PI / 2) * 0.1, -0.45, Math.sin(k * Math.PI / 2) * 0.1);
  R3.nukeGeo = m.build();
  R3.nukeMesh = [];
  R3.nukeRings = [];
  R3.craterMeshes = [];
  R3.fireballs = [];
}
function updateNukes(now, alpha = 0) {
  if (!R3.scene || !W) return;
  nukeMeshes();
  const n = W.nuke_count();
  while (R3.nukeMesh.length < n) {
    const mesh = new THREE.Mesh(R3.nukeGeo, entMat); mesh.scale.setScalar(1.6); R3.scene.add(mesh); R3.nukeMesh.push(mesh);
    const ring = new THREE.Mesh(new THREE.RingGeometry(W.nuke_numbers(2) - 0.25, W.nuke_numbers(2), 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ff3b2f", transparent: true, opacity: 0.7, depthWrite: false }));
    R3.scene.add(ring); R3.nukeRings.push(ring);
  }
  for (let k = 0; k < R3.nukeMesh.length; k++) {
    const mesh = R3.nukeMesh[k], ring = R3.nukeRings[k];
    mesh.visible = ring.visible = k < n;
    if (k >= n) continue;
    const tx = W.nuke_info(k, 0), ty = W.nuke_info(k, 1), sx = W.nuke_info(k, 2), sy = W.nuke_info(k, 3);
    // Smooth between ticks (the game moves it 20 times a second), and fly
    // over a straight line from the silo's ground to the target's: following
    // the ground under it made it shake over every hill.
    const p = Math.max(0, W.nuke_info(k, 4) - (1 - alpha) * TICK_S / NUKE_FLIGHT_S);
    const g0 = groundAt(sx, sy), g1 = groundAt(tx, ty);
    const H = 10, at = q => [sx + (tx - sx) * q, sy + (ty - sy) * q, g0 + (g1 - g0) * q + 4 * H * q * (1 - q)];
    const [x, y, h] = at(p), [x2, y2, h2] = at(Math.min(1, p + 0.01));
    mesh.position.set(x, h, y);
    // Point it along its flight.
    const dir = new THREE.Vector3(x2 - x, h2 - h, y2 - y).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    ring.position.set(tx, groundAt(tx, ty) + 0.08, ty);
    ring.material.opacity = 0.45 + 0.35 * Math.sin(now * 0.012);
    if (frame % 3 === 0 && R3.puffs && R3.puffs.length < 64) R3.puffs.push({ x, y, h, t0: now, big: false, seed: Math.random() * 6.28 });
  }
  // Craters.
  const c = W.crater_count();
  // Fewer craters than drawn (a replay starting, or jumping back), or not
  // where they're drawn (another game): take those marks away.
  for (let k = 0; k < R3.craterMeshes.length; k++) {
    const g = R3.craterMeshes[k];
    if (k >= c || g.position.x !== W.crater_info(k, 0) || g.position.z !== W.crater_info(k, 1)) {
      for (const m of R3.craterMeshes.splice(k)) { R3.scene.remove(m); m.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
      break;
    }
  }
  while (R3.craterMeshes.length < c) {
    const k = R3.craterMeshes.length, cx = W.crater_info(k, 0), cy = W.crater_info(k, 1);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CircleGeometry(2.6, 40).rotateX(-Math.PI / 2), withFow(new THREE.MeshLambertMaterial({ color: "#2b241e" }))));
    const scorch = new THREE.Mesh(new THREE.RingGeometry(2.6, 9.0, 48).rotateX(-Math.PI / 2), withFow(new THREE.MeshLambertMaterial({ color: "#3e3a2c", transparent: true, opacity: 0.6, depthWrite: false })));
    scorch.position.y = 0.01; g.add(scorch);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.25, 6, 40).rotateX(Math.PI / 2), withFow(new THREE.MeshLambertMaterial({ color: "#4a3e32" })));
    g.add(rim);
    g.position.set(cx, groundAt(cx, cy) + 0.05, cy);
    R3.scene.add(g); R3.craterMeshes.push(g);
  }
  // Fireballs from `nukeFlash`.
  R3.fireballs = R3.fireballs.filter(f => {
    const a = (now - f.t0) / 4000;
    if (a >= 1) { R3.scene.remove(f.mesh); return false; }
    f.mesh.scale.setScalar((0.5 + Math.min(1, a * 3) * 4.5) * W.nuke_numbers(2) / 5);
    f.mesh.material.opacity = Math.max(0, 1 - a) * 0.9;
    f.mesh.position.y = f.y0 + a * 3;
    return true;
  });
}
// Aiming a nuke: a ring under the pointer as wide as the blast, and the
// cover of every enemy air defense in sight (a nuke falling inside one is
// shot down). A selected air defense of your own shows its cover too.
function aimRing(r, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.2, r, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
  m.renderOrder = 3;
  R3.scene.add(m);
  return m;
}
function updateAimRings() {
  R3.aim ??= aimRing(W.nuke_numbers(2), "#ff5a3c");
  R3.covers ??= [];
  const aiming = typeof amode !== "undefined" && amode && aimSilo != null;
  let w = null;
  if (aiming && mouse.inside) w = screenToGround(mouse.x, mouse.y);
  R3.aim.visible = !!w;
  if (w) R3.aim.position.set(w.x, groundAt(w.x, w.y) + 0.12, w.y);
  const want = [];
  for (let i = 0; i < entCount; i++) {
    if (E(i, F.kind) !== K.AirDefense) continue;
    const own = E(i, F.owner) === ME;
    if ((aiming && !own) || (own && (E(i, F.flags) & 1))) want.push([E(i, F.x), E(i, F.y)]);
  }
  while (R3.covers.length < want.length) R3.covers.push(aimRing(W.nuke_numbers(3), "#7fd0ff"));
  R3.covers.forEach((m, k) => {
    m.visible = k < want.length;
    if (m.visible) m.position.set(want[k][0], groundAt(want[k][0], want[k][1]) + 0.1, want[k][1]);
  });
}
function nukeFlash(x, y) {
  if (!R3.scene) return;
  nukeMeshes();
  const fl = $("flash");
  if (fl) { fl.classList.remove("on"); void fl.offsetWidth; fl.classList.add("on"); }
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 0.9 }));
  const y0 = groundAt(x, y) + 1;
  mesh.position.set(x, y0, y);
  R3.scene.add(mesh);
  R3.fireballs.push({ mesh, t0: performance.now(), y0 });
  // A column of smoke and a ring of dust.
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * Math.PI * 2;
    gunSmoke(x + Math.cos(a) * 3, y + Math.sin(a) * 3, K.Cannon);
  }
  for (let k = 0; k < 8; k++) R3.puffs.push({ x, y, h: groundAt(x, y) + 1 + k * 0.9, t0: performance.now() + k * 120, big: true, seed: k });
}

// A shot from a firearm at (x, y): a puff of smoke there (see updatePuffs).
function gunSmoke(x, y, kind) {
  if (!R3.puffs) return;
  if (R3.puffs.length >= 64) R3.puffs.shift();
  const m = muzzle(x, y, kind);
  R3.puffs.push({ x: m ? m.x : x, y: m ? m.z : y, h: m ? m.y : undefined, t0: performance.now(), big: isBigGun(kind), seed: Math.random() * 6.28 });
}
// Where the shot leaves the gun: the end of the shooter's gun (or, for
// cannon and the like, of the whole piece) furthest along the way it faces.
const _box = new THREE.Box3(), _mz = new THREE.Vector3(), _best = new THREE.Vector3();
function muzzle(x, y, kind) {
  let o = null, bd = 0.6;
  for (const c of R3.objs.values()) {
    if (c.kind !== kind || c.x === undefined) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bd) { bd = d; o = c; }
  }
  if (!o) return null;
  const mesh = (!isBigGun(kind) && o.toolMesh) || o.body;
  if (!mesh || !mesh.geometry) return null;
  mesh.updateWorldMatrix(true, false);
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const fx = Math.cos(o.face === undefined ? 0 : -o.face), fz = Math.sin(o.face === undefined ? 0 : -o.face);
  let best = -Infinity;
  for (let k = 0; k < 8; k++) {
    _mz.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(mesh.matrixWorld);
    const along = (_mz.x - o.x) * fx + (_mz.z - o.y) * fz;
    if (along > best + 1e-4) { best = along; _best.copy(_mz); }
  }
  if (isBigGun(kind)) { _box.setFromObject(mesh); _best.y = (_box.min.y + _box.max.y) / 2; } // the barrel's height, not a wheel's
  return { x: _best.x, y: _best.y, z: _best.z };
}
function updatePuffs(now) {
  const m = R3.puffMesh;
  if (!m) return;
  R3.puffs = R3.puffs.filter(p => now - p.t0 < 1600);
  if (R3.puffs.length > 64) R3.puffs.splice(0, R3.puffs.length - 64);
  let n = 0;
  for (const p of R3.puffs) {
    if (now < p.t0) continue;
    const age = (now - p.t0) / 1600, size = (p.big ? 0.42 : 0.2) * Math.sin(Math.min(1, age * 1.4) * Math.PI) ** 0.6;
    for (let k = 0; k < 3 && n < 192; k++) {
      const a = p.seed + k * 2.1, r = age * (p.big ? 0.6 : 0.3);
      const x = p.x + Math.cos(a) * r, z = p.y + Math.sin(a) * r;
      _p.set(x, (p.h != null ? p.h : groundAt(x, z) + (p.big ? 0.5 : 0.7)) + age * 0.6 + k * 0.08, z);
      _q.identity(); _s.setScalar(Math.max(0.001, size * (1 - k * 0.2)));
      _m4.compose(_p, _q, _s);
      m.setMatrixAt(n++, _m4);
    }
  }
  m.count = n;
  m.instanceMatrix.needsUpdate = true;
}

// Rebuild the resource instances when anything about them changed.
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();
function updateResources() {
  if (!R3.res) return;
  // A number that changes when resources do (was a string: garbage every frame).
  let key = resCount;
  for (let i = 0; i < resCount; i++) key = (key * 31 + resBuf[i * 5 + 2] * 7 + (resBuf[i * 5 + 3] / resBuf[i * 5 + 4] * 8 | 0)) | 0;
  if (key === R3.resKey) return;
  R3.resKey = key;
  const lists = { pine: [], oak: [], bush: [], stone: [], gold: [], horse: [], deer: [], iron: [], clay: [], sheep: [], nitrate: [], coal: [], oil: [], bauxite: [], uranium: [] };
  for (const m of Object.values(R3.res)) m.count = 0;
  for (let i = 0; i < resCount; i++) {
    const tx = resBuf[i * 5], ty = resBuf[i * 5 + 1], kind = resBuf[i * 5 + 2], frac = resBuf[i * 5 + 3] / resBuf[i * 5 + 4];
    const h = hash2(tx, ty), h2 = hash2(ty * 3 + 1, tx * 7);
    // Deposit kinds (defs::Dep): 0 fertile land, 1 forest, 2 stone, 3 horses, 4 game,
    // 6 iron ore, 7 clay, 8 sheep hills, 9 saltpeter, 10 coal, 11 oil, 12 bauxite, 13 uranium.
    let mesh, scale;
    if (kind === 1) { mesh = h < 0.4 ? "pine" : "oak"; scale = 0.85 + h2 * 0.45; }
    else if (kind === 0) { mesh = "bush"; scale = 0.8 + 0.4 * h2; }
    else if (kind === 3) { mesh = "horse"; scale = 1; } // the size of a horseman's horse
    else if (kind === 4) { mesh = "deer"; scale = 1; }
    else if (kind === 6) { mesh = "iron"; scale = 0.85 + 0.25 * h2; }
    else if (kind === 7) { mesh = "clay"; scale = 0.85 + 0.25 * h2; }
    else if (kind === 8) { mesh = "sheep"; scale = UNIT_SCALE; } // like the sheep farm's sheep
    else if (kind === 9) { mesh = "nitrate"; scale = 0.8 + 0.3 * h2; }
    else if (kind === 10) { mesh = "coal"; scale = 0.8 + 0.3 * h2; }
    else if (kind === 11) { mesh = "oil"; scale = 0.85 + 0.2 * h2; }
    else if (kind === 12) { mesh = "bauxite"; scale = 0.8 + 0.3 * h2; }
    else if (kind === 13) { mesh = "uranium"; scale = 0.8 + 0.3 * h2; }
    else { mesh = "stone"; scale = 0.8 + 0.3 * frac * h2; }
    const m = R3.res[mesh];
    if (m.count >= m.instanceMatrix.count) continue;
    const x = tx + 0.5 + (h - 0.5) * 0.25, y = ty + 0.5 + (h2 - 0.5) * 0.25;
    _p.set(x, groundAt(x, y) - 0.02, y);
    _q.setFromAxisAngle(_up, h * 6.28);
    _s.setScalar(scale);
    _m4.compose(_p, _q, _s);
    m.setMatrixAt(m.count, _m4);
    const v = 0.85 + h2 * 0.3;
    m.setColorAt(m.count, _c.setRGB(v, v, v));
    lists[mesh].push([tx, ty]);
    m.count++;
  }
  for (const [k, m] of Object.entries(R3.res)) {
    m.userData.res = lists[k];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }
}

// Arrows leave from the bow (a little ahead of an archer, at hand height;
// from the top of a tower) and arc down to the target's chest. The
// simulation moves them in a straight line on the ground; height and tilt
// are worked out here from how far along the way they are.
const _e = new THREE.Euler();
function updateArrows(alpha) {
  const a = R3.arrows, st = R3.stones, ms = R3.missiles, rk = R3.rockets, S = PROJ_STRIDE;
  let na = 0, ns = 0, nm = 0, nr = 0;
  for (let i = 0; i < Math.min(projCount, 256); i++) {
    const b = i * S, x = projBuf[b], y = projBuf[b + 1], px = projBuf[b + 2], py = projBuf[b + 3];
    const sx = projBuf[b + 4], sy = projBuf[b + 5], shooter = projBuf[b + 6], atBuilding = projBuf[b + 7];
    const tx = projBuf[b + 8], ty = projBuf[b + 9];
    const ix = px + (x - px) * alpha, iy = py + (y - py) * alpha;
    // Which way it flies: towards the target.
    let dx = tx - ix, dy = ty - iy, d = Math.hypot(dx, dy);
    if (d < 1e-3) { dx = x - px; dy = y - py; d = Math.hypot(dx, dy) || 1; }
    dx /= d; dy /= d;
    // The bow: ahead of the shooter, at the height it holds it.
    const stone = shooter === K.Trebuchet || shooter === K.Cannon || shooter === K.FieldGun || shooter === K.Tank;
    const rocket = shooter === K.RocketArtillery;
    if (shooter === K.Musketeer || shooter === K.Dragoon || shooter === K.Rifleman || shooter === K.MachineGunner || shooter === K.Infantry || shooter === K.Fighter || shooter === K.Jet) continue; // bullets are too small to see
    const missile = shooter === K.AirDefense;
    const fromH = missile ? 0.7 : rocket ? 0.85 : shooter === K.Tower ? 2.5 : shooter === K.Capitol ? 1.9 : shooter === K.Trebuchet ? 1.2 : shooter === K.Cannon || shooter === K.FieldGun ? 0.45 : shooter === K.Tank ? 0.6 : 0.62;
    const ahead = isBld(shooter) ? 0 : 0.3;
    const ox = sx + dx * ahead, oy = sy + dy * ahead;
    const toH = missile ? AIR_ALT + 0.3 : atBuilding ? 0.9 : 0.55;
    // How far along: distance flown over that plus the distance still to go.
    const flown = Math.hypot(ix - ox, iy - oy);
    const total = Math.max(0.3, flown + Math.hypot(tx - ix, ty - iy));
    const t = Math.min(1, flown / total);
    const arc = missile ? total * 0.25 : rocket ? total * 0.22 : shooter === K.Trebuchet ? total * 0.3 : shooter === K.Cannon || shooter === K.Tank ? total * 0.05 : shooter === K.FieldGun ? total * 0.15 : Math.min(1.2, total * 0.12);
    const h0 = groundAt(ox, oy) + fromH, h1 = groundAt(ix, iy) + toH;
    _p.set(ix, h0 + (h1 - h0) * t + arc * 4 * t * (1 - t), iy);
    // Pointing along its path: up as it leaves, down as it lands.
    const pitch = Math.atan2((h1 - h0) / total + arc * 4 * (1 - 2 * t) / total, 1);
    _q.setFromEuler(_e.set(0, -Math.atan2(dy, dx), pitch, "YZX"));
    _s.setScalar(rocket ? 1.3 : 1);
    _m4.compose(_p, _q, _s);
    if (missile) {
      if (nm < 32) ms.setMatrixAt(nm++, _m4);
      // A trail of smoke behind it.
      if (GFX.smoke && Math.random() < 0.5 && R3.puffs.length < 150) R3.puffs.push({ x: _p.x - dx * 0.3, y: _p.z - dy * 0.3, h: _p.y, t0: performance.now(), big: false, seed: Math.random() * 6.28 });
    } else if (rocket) {
      if (nr < 64) rk.setMatrixAt(nr++, _m4);
      // Smoke behind it: a rocket's trail is thicker than a missile's.
      if (GFX.smoke && Math.random() < 0.7 && R3.puffs.length < 150) R3.puffs.push({ x: _p.x - dx * 0.35, y: _p.z - dy * 0.35, h: _p.y, t0: performance.now(), big: false, seed: Math.random() * 6.28 });
    } else if (stone) { if (ns < 64) st.setMatrixAt(ns++, _m4); }
    else a.setMatrixAt(na++, _m4);
  }
  a.count = na; st.count = ns; ms.count = nm; rk.count = nr;
  ms.instanceMatrix.needsUpdate = true;
  rk.instanceMatrix.needsUpdate = true;
  a.instanceMatrix.needsUpdate = true;
  st.instanceMatrix.needsUpdate = true;
}

function updateRally() {
  const sel = selection();
  const r = R3.rally;
  r.visible = false;
  if (sel.length !== 1) return;
  const i = sel[0], rx = E(i, F.rx), ry = E(i, F.ry);
  if (E(i, F.owner) !== ME || Number.isNaN(rx)) return;
  r.visible = true;
  r.position.set(rx, groundAt(rx, ry), ry);
}

// The see-through building that follows the mouse while placing.
function updateGhost() {
  if (placing == null || !mouse.inside) { if (R3.ghost) R3.ghost.visible = false; return; }
  if (R3.ghostKind !== placing) {
    if (R3.ghost) R3.scene.remove(R3.ghost);
    R3.ghost = new THREE.Group();
    R3.ghost.add(new THREE.Mesh(cachedModel(placing, ME).body, ghostMat));
    const s = stat(placing, 6);
    R3.footprint = new THREE.Mesh(new THREE.PlaneGeometry(s, s).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#7be864", transparent: true, opacity: 0.35, depthWrite: false }));
    R3.footprint.position.y = 0.06;
    R3.ghost.add(R3.footprint);
    R3.scene.add(R3.ghost);
    R3.ghostKind = placing;
  }
  const spot = placementSpot(mouse.x, mouse.y);
  if (!spot) { R3.ghost.visible = false; return; }
  const s = stat(placing, 6), cx = spot.tx + s / 2, cy = spot.ty + s / 2;
  R3.ghost.visible = true;
  R3.ghost.position.set(cx, Math.max(0.02, hAt(cx, cy)), cy);
  R3.footprint.material.color.set(W.can_place(placing, spot.tx, spot.ty) ? "#7be864" : "#f05a3c");
}

// Expanding rings on the ground where you clicked.
function addMarker(x, y, color) {
  const m = new THREE.Mesh(R3.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
  m.position.set(x, groundAt(x, y) + 0.05, y);
  m.renderOrder = 3;
  R3.scene.add(m);
  R3.markers.push({ m, t0: performance.now() });
}
function updateMarkers(now) {
  R3.markers = R3.markers.filter(k => {
    const p = (now - k.t0) / 600;
    if (p >= 1) { R3.scene.remove(k.m); k.m.material.dispose(); return false; }
    k.m.scale.setScalar(0.15 + p * 0.45);
    k.m.material.opacity = 1 - p;
    return true;
  });
}

// Screen position of an entity (for health bars and box-select).
function entScreen(i, atTop) {
  const o = R3.objs.get(E(i, F.id));
  if (!o) return null;
  const top = isBld(o.kind) ? o.height * (o.body.scale.y) : o.height + 0.12;
  return worldToScreen(o.root.position.x, o.root.position.z, o.root.position.y + (atTop ? top : o.height * 0.5));
}

// --- Graphics quality ------------------------------------------------------------
// One setting trades looks for speed. It only changes how things are drawn,
// never the simulation, so players in one multiplayer game can each pick
// their own. Saved per browser.
const GFX_LEVELS = {
  low:    { label: "Low",    pixelRatio: 1,   shadows: 0,    grass: 0.12, sway: 0, smoke: false, post: false, bloom: false, ao: false },
  medium: { label: "Medium", pixelRatio: 1.5, shadows: 1024, grass: 0.22, sway: 1, smoke: true,  post: true,  bloom: false, ao: false },
  high:   { label: "High",   pixelRatio: 2,   shadows: 2048, grass: 0.32, sway: 1, smoke: true,  post: true,  bloom: true,  ao: false },
  ultra:  { label: "Ultra",  pixelRatio: 2,   shadows: 4096, grass: 0.42, sway: 1, smoke: true,  post: true,  bloom: true,  ao: true },
};
let gfxName = (() => {
  try { const v = localStorage.getItem("vibecraftGraphics"); if (GFX_LEVELS[v]) return v; } catch (e) {}
  // Phones and tablets start a notch lower: small GPUs and very dense screens.
  return matchMedia("(pointer: coarse)").matches ? "medium" : "high";
})();
let GFX = GFX_LEVELS[gfxName];

function setGraphicsQuality(name) {
  if (!GFX_LEVELS[name]) return;
  gfxName = name; GFX = GFX_LEVELS[name];
  try { localStorage.setItem("vibecraftGraphics", name); } catch (e) {}
  for (const seg of document.querySelectorAll(".gfx-seg")) for (const b of seg.children) b.setAttribute("aria-pressed", b.dataset.q === name);
  applyGraphics();
}

function applyGraphics() {
  const r = R3.renderer; if (!r) return;
  swayUniform.value = GFX.sway;
  // Shadows: turning them on or off, or a new map size, means rebuilding the shaders.
  const sun = R3.sun, on = GFX.shadows > 0;
  if (r.shadowMap.enabled !== on || (on && sun.shadow.mapSize.x !== GFX.shadows)) {
    r.shadowMap.enabled = on;
    sun.castShadow = on;
    if (on) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(GFX.shadows, GFX.shadows);
      r.shadowMap.type = GFX.shadows >= 2048 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    }
    for (const m of [entMat, hitMat, treeMat, stoneMat, goldMat, ghostMat]) m.needsUpdate = true;
    R3.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  }
  applyGrass();
  if (R3.smoke) R3.smoke.visible = GFX.smoke;
  if (view._w) resizeRenderer();
}

function applyGrass() {
  if (R3.tufts) R3.tufts.count = Math.round(R3.tuftSpots.length * GFX.grass);
  if (R3.flowers) R3.flowers.count = Math.max(0, Math.round(R3.flowerSpots.length * GFX.grass));
  if (R3.pebbles) R3.pebbles.count = Math.round(R3.pebbleSpots.length * Math.min(1, GFX.grass * 2.5));
}

// The setting appears on the start screen and in the in-game menu.
function addGraphicsControls() {
  const make = () => {
    const row = document.createElement("div");
    row.className = "row gfx-row";
    row.innerHTML = `<span class="note" id="gfxLabel${document.querySelectorAll(".gfx-row").length}">Graphics</span>`;
    const seg = document.createElement("div");
    seg.className = "seg gfx-seg";
    seg.setAttribute("aria-labelledby", row.firstChild.id);
    for (const [k, v] of Object.entries(GFX_LEVELS)) {
      const b = document.createElement("button");
      b.dataset.q = k; b.textContent = v.label;
      b.title = k === "ultra" ? "Adds soft contact shadows; needs a strong graphics card" : k === "low" ? "No shadows or wind: for slow computers" : "";
      b.setAttribute("aria-pressed", k === gfxName);
      b.onclick = () => setGraphicsQuality(k);
      seg.append(b);
    }
    row.append(seg);
    return row;
  };
  const start = document.querySelector("#startScreen .keys");
  if (start) start.before(make());
  const menu = document.querySelector("#menuScreen .card");
  if (menu) menu.append(make());
}

// --- Chimney smoke ------------------------------------------------------------------
// Puffs rise from the Smithy and Settlement chimneys, and dark smoke from badly
// damaged buildings. One point cloud for all of it: each puff knows its
// emitter and a random phase, and the vertex shader works out where it is
// in its rise, so the CPU only lists the emitters now and then.
const SMOKE_MAX = 48, SMOKE_PUFFS = 14;
function buildSmoke() {
  const n = SMOKE_MAX * SMOKE_PUFFS;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // the emitter
  geo.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array(n), 1));        // 0 off, 1 chimney, 2 fire
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) seed[i] = (i % SMOKE_PUFFS) / SMOKE_PUFFS + hash2(i, 7) * 0.08;
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uScale: { value: 300 }, uFow: fowUniforms.uFow, uMapSize: fowUniforms.uMapSize, fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 1 } },
    transparent: true, depthWrite: false, fog: true,
    vertexShader: `
      attribute float aKind; attribute float aSeed;
      uniform float uTime; uniform float uScale; uniform sampler2D uFow; uniform vec2 uMapSize;
      varying float vAlpha; varying vec3 vCol; varying float vFogDepth;
      void main() {
        float fire = step(1.5, aKind);
        float life = fract(uTime * (fire > 0.5 ? 0.32 : 0.2) + aSeed);
        vec3 p = position;
        p.y += life * (fire > 0.5 ? 2.2 : 1.7);
        p.xz += vec2(0.82, 0.57) * life * life * 1.1;
        p.x += sin(aSeed * 40.0 + uTime) * 0.08 * life;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = mix(0.16, fire > 0.5 ? 0.9 : 0.7, life);
        gl_PointSize = aKind < 0.5 ? 0.0 : size * uScale / -mv.z;
        float seen = texture2D(uFow, position.xz / uMapSize).r;
        vAlpha = sin(life * 3.14159) * (fire > 0.5 ? 0.5 : 0.3) * step(0.5, seen) * seen;
        vCol = fire > 0.5 ? mix(vec3(0.95, 0.45, 0.15), vec3(0.16, 0.15, 0.14), smoothstep(0.0, 0.25, life)) : mix(vec3(0.82, 0.8, 0.78), vec3(0.6, 0.6, 0.62), life);
        vFogDepth = -mv.z;
      }`,
    fragmentShader: `
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying float vAlpha; varying vec3 vCol; varying float vFogDepth;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = vAlpha * smoothstep(0.5, 0.15, length(c));
        if (a < 0.01) discard;
        // A little self-shadow: lighter on the side facing the sun.
        vec3 col = vCol * (0.85 + 0.3 * (0.5 - c.y));
        col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  R3.smoke = new THREE.Points(geo, mat);
  R3.smoke.frustumCulled = false;
  R3.smoke.renderOrder = 4;
  R3.smoke.visible = GFX.smoke;
  R3.scene.add(R3.smoke);
}
// Called every few frames with [x, y, z, kind] for each emitter.
function setSmokeEmitters(list) {
  const geo = R3.smoke.geometry, pos = geo.attributes.position.array, kind = geo.attributes.aKind.array;
  for (let e = 0; e < SMOKE_MAX; e++) {
    const em = list[e];
    for (let k = 0; k < SMOKE_PUFFS; k++) {
      const i = e * SMOKE_PUFFS + k;
      kind[i] = em ? em[3] : 0;
      if (em) { pos[i * 3] = em[0]; pos[i * 3 + 1] = em[1]; pos[i * 3 + 2] = em[2]; }
    }
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aKind.needsUpdate = true;
}
// Where smoke comes out, relative to the building's centre.
function updateSmoke() {
  // Chimneys, the smoke hole of a hut someone lives in, the Capitol's campfire.
  const CHIMNEYS = { [K.HuntingLodge]: [0.3, glbModels ? 1.2 : 1.1, -0.2], [K.Hut]: [0, 1.35, 0], [K.Capitol]: [CAMPFIRE[0] + 0.3, 2.6, CAMPFIRE[2]],
    [K.Cottage]: [-0.38, 1.3, -0.2], [K.Bakery]: [0.65, 0.92, -0.42], [K.Brickworks]: [0.15, 1.28, -0.55],
    [K.Townhouse]: [0.35, 1.75, -0.2], [K.PowderMill]: [-0.45, 1.1, -0.45],
    [K.Tenement]: [0.4, 2.35, -0.2], [K.SteelMill]: [-0.9, 2.65, -0.8], [K.Factory]: [1.0, 2.3, -0.9], [K.Cannery]: [0.55, 1.55, -0.35],
    [K.PowerPlant]: [0.9, 2.75, -0.7], [K.TowerBlock]: [0.35, 3.6, -0.25] };
  if (!R3.smoke || !GFX.smoke || frame % 10 !== 0) return;
  const list = [];
  for (const o of R3.objs.values()) {
    if (!isBld(o.kind) || o.body.scale.y < 1 || list.length >= SMOKE_MAX) continue;
    const ch = CHIMNEYS[o.kind], p = o.root.position;
    if (ch && (stat(o.kind, 10) < 0 || o.residents > 0) && (!o.campfire || o.campfire.visible)) list.push([p.x + ch[0], p.y + ch[1], p.z + ch[2], 1]);
    if (o.lastHp < 0.5 && o.kind !== K.Farm && list.length < SMOKE_MAX) list.push([p.x - 0.2, p.y + o.height * 0.6, p.z + 0.1, 2]);
  }
  setSmokeEmitters(list);
  R3.smoke.material.uniforms.uScale.value = view._h * R3.renderer.getPixelRatio() * 0.5 * R3.camera.projectionMatrix.elements[5];
}

// --- After the scene is drawn: grading, bloom, ambient occlusion ---------------------
// From Medium up, the scene is drawn into an off-screen image first, and one
// last full-screen pass finishes it:
// - colour grading: warm light, cool slightly teal shade, a touch more
//   colour, and a soft vignette (Medium and up);
// - bloom: bright things (sunlit roofs, glints on water, the forge, gold
//   veins) glow softly (High and up);
// - ambient occlusion: creases and contact points darken, worked out from
//   the depth image (Ultra).
// That pass also applies the tone mapping, which three.js skips when drawing
// into an image. On Low the scene goes straight to the screen.
const Post = { rt: null, scene: null, cam: null, mat: null, bloom: null, quad: null };
const FULLSCREEN_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function buildPost() {
  Post.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  Post.rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  Post.mat = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, tBloom: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2() },
      uRadius: { value: 0.55 }, uBloom: { value: 0 },
    },
    defines: { USE_AO: 0 },
    depthTest: false, depthWrite: false,
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
      uniform sampler2D tColor; uniform sampler2D tDepth; uniform sampler2D tBloom;
      uniform mat4 uProjInv; uniform mat4 uProj; uniform vec2 uRes; uniform float uRadius; uniform float uBloom;
      varying vec2 vUv;
      vec3 viewPos(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        return p.xyz / p.w;
      }
      void main() {
        vec3 col = texture2D(tColor, vUv).rgb;
        #if USE_AO
        float d = texture2D(tDepth, vUv).x;
        if (d < 1.0) {
          vec3 P = viewPos(vUv);
          vec3 N = normalize(cross(dFdx(P), dFdy(P)));
          float rUv = uRadius * uProj[1][1] / -P.z * 0.5; // the radius on screen, as a fraction of its height
          float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float occ = 0.0;
          const int N_S = 14;
          for (int i = 0; i < N_S; i++) {
            float f = (float(i) + 0.5) / float(N_S);
            float a = (float(i) * 2.39996 + noise * 6.2832);
            vec2 off = vec2(cos(a), sin(a)) * f * rUv * vec2(uRes.y / uRes.x, 1.0);
            vec3 v = viewPos(vUv + off) - P;
            float vv = dot(v, v);
            // Nearby geometry above this pixel's surface occludes it; far-away geometry doesn't count.
            occ += max(0.0, dot(v, N) - 0.015) / (vv + 0.05) * smoothstep(uRadius * uRadius * 4.0, uRadius * uRadius, vv);
          }
          col *= clamp(1.0 - occ * 0.6 / float(N_S), 0.0, 1.0);
        }
        #endif
        col += texture2D(tBloom, vUv).rgb * uBloom;
        // Grading, in linear light before tone mapping: cool the shade, warm the light.
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col *= mix(vec3(0.9, 1.0, 1.07), vec3(1.07, 1.0, 0.9), smoothstep(0.04, 0.9, lum));
        col = max(mix(vec3(lum), col, 1.12), 0.0);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // A soft vignette pulls the eye to the middle of the view.
        vec2 q = vUv - 0.5;
        gl_FragColor.rgb *= 1.0 - 0.28 * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
      }`,
  });
  Post.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), Post.mat);
  Post.quad.frustumCulled = false;
  Post.scene = new THREE.Scene();
  Post.scene.add(Post.quad);
  Post.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
}

// Bloom: keep only what's brighter than a threshold, shrink it step by step
// to a sixteenth of the screen, then grow it back, adding each level: a wide,
// soft glow for very little work (the "dual filter" method).
function buildBloom() {
  const levels = [];
  for (let i = 0; i < 5; i++) levels.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const mk = (frag, extra = {}) => new THREE.ShaderMaterial({
    uniforms: Object.assign({ tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, extra),
    depthTest: false, depthWrite: false, vertexShader: FULLSCREEN_VS, fragmentShader: frag,
  });
  const down = `
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }`;
  const bright = mk(down + `
    uniform float uThreshold;
    void main() {
      vec3 c = (tap(vec2(-1.0)) + tap(vec2(1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, -1.0))) * 0.25;
      float l = max(c.r, max(c.g, c.b));
      float k = smoothstep(uThreshold, uThreshold * 1.6, l);   // a soft knee, so the glow fades in
      gl_FragColor = vec4(min(c * k, vec3(8.0)), 1.0);
    }`, { uThreshold: { value: 1.05 } });
  const shrink = mk(down + `
    void main() {
      vec3 c = tap(vec2(0.0)) * 4.0 + tap(vec2(-1.0)) + tap(vec2(1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, -1.0));
      gl_FragColor = vec4(c / 8.0, 1.0);
    }`);
  const grow = mk(down + `
    void main() {
      vec3 c = tap(vec2(-2.0, 0.0)) + tap(vec2(2.0, 0.0)) + tap(vec2(0.0, -2.0)) + tap(vec2(0.0, 2.0))
             + (tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)) + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0))) * 2.0;
      gl_FragColor = vec4(c / 12.0, 1.0);
    }`);
  grow.blending = THREE.AdditiveBlending;
  Post.bloom = { levels, bright, shrink, grow };
}

function blit(r, mat, src, dst) {
  mat.uniforms.tSrc.value = src.texture || src;
  const w = (src.width || src.image.width), h = (src.height || src.image.height);
  mat.uniforms.uTexel.value.set(1 / w, 1 / h);
  Post.quad.material = mat;
  r.setRenderTarget(dst);
  r.render(Post.scene, Post.cam);
}

function renderBloom(r, sz) {
  if (!Post.bloom) buildBloom();
  const { levels, bright, shrink, grow } = Post.bloom;
  levels.forEach((t, i) => { const w = Math.max(1, sz.x >> (i + 1)), h = Math.max(1, sz.y >> (i + 1)); if (t.width !== w || t.height !== h) t.setSize(w, h); });
  blit(r, bright, Post.rt, levels[0]);
  for (let i = 1; i < levels.length; i++) blit(r, shrink, levels[i - 1], levels[i]);
  r.autoClear = false;
  for (let i = levels.length - 1; i > 0; i--) blit(r, grow, levels[i], levels[i - 1]);
  r.autoClear = true;
  return levels[0].texture;
}

const _black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
_black.needsUpdate = true;

function renderScene() {
  const r = R3.renderer;
  if (!GFX.post) { r.render(R3.scene, R3.camera); return; }
  if (!Post.rt) buildPost();
  const sz = r.getDrawingBufferSize(_v2);
  if (Post.rt.width !== sz.x || Post.rt.height !== sz.y) Post.rt.setSize(sz.x, sz.y);
  r.setRenderTarget(Post.rt);
  r.render(R3.scene, R3.camera);
  const u = Post.mat.uniforms;
  u.tBloom.value = GFX.bloom ? renderBloom(r, sz) : _black;
  u.uBloom.value = GFX.bloom ? 0.32 : 0;
  r.setRenderTarget(null);
  const ao = GFX.ao ? 1 : 0;
  if (Post.mat.defines.USE_AO !== ao) { Post.mat.defines.USE_AO = ao; Post.mat.needsUpdate = true; }
  u.tColor.value = Post.rt.texture; u.tDepth.value = Post.rt.depthTexture;
  u.uProj.value.copy(R3.camera.projectionMatrix); u.uProjInv.value.copy(R3.camera.projectionMatrixInverse);
  u.uRes.value.set(sz.x, sz.y);
  Post.quad.material = Post.mat;
  r.render(Post.scene, Post.cam);
}
const _v2 = new THREE.Vector2();

// --- HUD icons -----------------------------------------------------------------
// Button icons and portraits are rendered from the same 3D models, with a
// small second renderer, then copied into ordinary 2D canvases.
const iconCache = new Map();
let iconR = null;
function iconRenderer() {
  if (iconR) return iconR;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(128, 128, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // match the main view
  renderer.toneMappingExposure = 1.25;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#f1f4f8", "#5a5040", 2.0));
  const d = new THREE.DirectionalLight("#fff3dd", 2.2); d.position.set(-2, 4, 3); scene.add(d);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  iconR = { renderer, scene, cam, mat };
  return iconR;
}
function icon(k, owner, px) {
  const key = `${k}/${owner}/${px}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const { renderer, scene, cam, mat } = iconRenderer();
  const mdl = cachedModel(k, owner);
  const g = new THREE.Group();
  const body = new THREE.Mesh(mdl.body, mat);
  g.add(body);
  if (mdl.tool) {
    const t = new THREE.Mesh(mdl.tool, mat);
    t.position.set(...(mdl.rig ? mdl.rig.toolAt : mdl.pivot));
    t.rotation.z = mdl.rig ? (k === K.Spearman || k === K.Swordsman ? -0.25 : k === K.Worker ? -0.4 : 0) : -(mdl.toolTilt || 0);
    g.add(t);
  }
  g.rotation.y = isBld(k) ? -0.6 : -0.9;
  scene.add(g);
  // Frame the model: fit its bounding box in view.
  const bb = new THREE.Box3().setFromObject(g), c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
  if (isBld(k)) { bb.min.y = Math.max(bb.min.y, 0); c.y = (bb.min.y + bb.max.y) / 2; }
  const r = Math.max(size.x, size.y, size.z) * (isBld(k) ? 0.62 : 0.7);
  const dist = r / Math.tan((cam.fov * Math.PI) / 360);
  cam.position.set(c.x, c.y + dist * 0.55, c.z + dist * 0.85);
  cam.lookAt(c);
  renderer.render(scene, cam);
  scene.remove(g);
  const cv = document.createElement("canvas");
  cv.width = cv.height = px * 2;
  cv.getContext("2d").drawImage(renderer.domElement, 0, 0, px * 2, px * 2);
  iconCache.set(key, cv);
  return cv;
}
function iconEl(k, owner, px) {
  const cv = document.createElement("canvas");
  const src = icon(k, owner, px);
  cv.width = src.width; cv.height = src.height;
  cv.getContext("2d").drawImage(src, 0, 0);
  return cv;
}
