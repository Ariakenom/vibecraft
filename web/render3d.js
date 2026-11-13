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
  drawn: { calls: 0, triangles: 0 }, // the last frame's scene, for the trace
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
// How much things move in the wind (0 with the Wind setting off).
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
const BOAT_SCALE = 2.2; // boats, on top of UNIT_SCALE
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
  if (isNaval(kind)) return boatModel(kind, owner);
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

// A boat's hull, lofted from cross-sections so it has a pointed bow, a
// rounded bilge and a deck that rises to the ends, instead of a box with a
// wedge stuck on. The waterline is y = 0 and the bow points +x; the hull
// runs from x0 to x1. Returns its skin, its deck and a strake along the
// top of the sides (painted in the team colour, so a ship shows whose it
// is even with its sails down).
function hullGeos(x0, x1, W, H, o = {}) {
  const { stern = 0.55, sheer = 0.04, draft = 0.08, rake = 0.1, taper = 0.5, point = 1.7, bilge = 0.74, strake = 0.05, n = 12 } = o;
  const L = x1 - x0, st = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const f = t < 0.3 ? stern + (1 - stern) * Math.sin((t / 0.3) * Math.PI / 2) : t < taper ? 1 : 1 - ((t - taper) / (1 - taper)) ** point;
    const hw = Math.max(0.004, (W / 2) * f), x = x0 + t * L;
    const yd = H - draft + sheer * (2 * t - 1) ** 2;                    // the rail
    const yk = -draft + H * 0.6 * Math.max(0, (t - 0.75) / 0.25) ** 2;   // the keel sweeps up to the stem
    const yb = yk + (yd - yk) * 0.3, xd = x + rake * t ** 4;
    st.push({ t, hw, yd, yk, xd, sec: [[xd, yd, hw], [x, yb, hw * bilge], [x, yk, 0], [x, yb, -hw * bilge], [xd, yd, -hw]] });
  }
  const mk = () => ({ pos: [] });
  const skin = mk(), deck = mk(), band = mk();
  // A triangle, turned so it faces the way `hint` points.
  const tri = (g, a, b, c, hx, hy, hz) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const d = (uy * vz - uz * vy) * hx + (uz * vx - ux * vz) * hy + (ux * vy - uy * vx) * hz;
    if (d >= 0) g.pos.push(...a, ...b, ...c); else g.pos.push(...a, ...c, ...b);
  };
  const quad = (g, a, b, c, d, hx, hy, hz) => { tri(g, a, b, c, hx, hy, hz); tri(g, a, c, d, hx, hy, hz); };
  const DROP = 0.022, IN = 0.9;   // the deck sits a little below the rail, inside a low bulwark
  for (let i = 0; i < n; i++) {
    const A = st[i], B = st[i + 1];
    for (let j = 0; j < 4; j++) {
      const cz = (A.sec[j][2] + A.sec[j + 1][2]) / 2, cy = (A.sec[j][1] + A.sec[j + 1][1]) / 2;
      quad(skin, A.sec[j], A.sec[j + 1], B.sec[j + 1], B.sec[j], 0, cy - H * 0.6, cz * 3);
    }
    const dk = (S, s) => [S.xd, S.yd - DROP, s * S.hw * IN];
    quad(deck, dk(A, -1), dk(A, 1), dk(B, 1), dk(B, -1), 0, 1, 0);
    for (const s of [-1, 1]) {
      quad(skin, A.sec[s > 0 ? 0 : 4], dk(A, s), dk(B, s), B.sec[s > 0 ? 0 : 4], 0, 1, -s);   // the bulwark's inside
      // the strake: a band just proud of the top of the side
      const top = S => [S.xd, S.yd + 0.002, s * (S.hw + 0.006)];
      const low = S => { const p = S.sec[s > 0 ? 0 : 4], q = S.sec[s > 0 ? 1 : 3], k = Math.min(1, strake / Math.max(0.01, p[1] - q[1])); return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, s * (Math.abs(p[2] + (q[2] - p[2]) * k) + 0.006)]; };
      quad(band, top(A), low(A), low(B), top(B), 0, 0.2, s);
    }
  }
  const S0 = st[0];   // the stern: a flat transom
  for (let j = 1; j < 4; j++) tri(skin, S0.sec[0], S0.sec[j], S0.sec[j + 1], -1, 0, 0);
  tri(band, [S0.xd - 0.006, S0.yd + 0.002, S0.hw], [S0.xd - 0.006, S0.yd - strake, S0.hw * 0.97], [S0.xd - 0.006, S0.yd + 0.002, -S0.hw], -1, 0, 0);
  tri(band, [S0.xd - 0.006, S0.yd - strake, S0.hw * 0.97], [S0.xd - 0.006, S0.yd - strake, -S0.hw * 0.97], [S0.xd - 0.006, S0.yd + 0.002, -S0.hw], -1, 0, 0);
  const geo = g => { const b = new THREE.BufferGeometry(); b.setAttribute("position", new THREE.BufferAttribute(new Float32Array(g.pos), 3)); b.computeVertexNormals(); return b; };
  // How high the deck is, and how wide, at x: for putting things on it.
  const at = x => { const t = Math.max(0, Math.min(1, (x - x0) / L)), i = Math.min(n - 1, Math.floor(t * n)), k = t * n - i, A = st[i], B = st[i + 1];
    return { y: A.yd + (B.yd - A.yd) * k - DROP, hw: A.hw + (B.hw - A.hw) * k }; };
  return { skin: geo(skin), deck: geo(deck), band: geo(band), at };
}
// A sail with wind in it: a thin sheet across the ship, bellied forward.
function sailGeo(w, h, belly = 0.06) {
  const g = new THREE.BoxGeometry(0.016, h, w, 1, 4, 6), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const z = p.getZ(i) / (w / 2), y = p.getY(i) / (h / 2); p.setX(i, p.getX(i) + belly * (1 - z * z) * (1 - 0.4 * y * y)); }
  g.computeVertexNormals();
  return g;
}

// Boats: the waterline is y = 0, the bow points +x. The tool is a pennant
// at the masthead, which doesn't swing. Each has its own outline from the
// air: the fishing boat one slanting sail; the transport tubby, striped
// sail, deck full of cargo; the galley long and low with oars, a ram and a
// curling stern; the cog castles fore and aft; the galleon three masts of
// white sail and a tall stern; the ironclad a black sloping casemate; the
// destroyer grey and thin with turrets and raked funnels; the submarine a
// narrow deck and a gun; the nuclear one a black whale's back, a tall fin
// and missile hatches; the carrier a flat deck with aircraft on it.
function boatModel(kind, owner) {
  const team = PCOL[owner], dark = PDARK[owner];
  const m = new Model(), t = new Model();
  const GREY = "#98a1a8", DARKGREY = "#5a6268", SAIL = "#efe6d1", BLACK = "#22262a", GOLD = "#d9b24a";
  let H = null;
  const hull = (x0, x1, w, h, col, deck, band, o) => {
    H = hullGeos(x0, x1, w, h, o);
    m.add(H.skin, col).add(H.deck, deck).add(H.band, band);
    return H;
  };
  // Things stand on the deck: y above it at x.
  const on = (geo, col, x, y, z = 0, ry = 0) => m.add(geo, col, x, H.at(x).y + y, z, ry);
  const mast = (x, h, r = 0.02) => on(cyl(r * 0.7, r, h, 6), DARKWOOD, x, h / 2);
  const square = (x, y, w, h, col, belly) => {   // a square sail on its yard, y above the deck
    on(sailGeo(w, h, belly), col, x + 0.02, y);
    on(box(0.028, 0.028, w + 0.08), DARKWOOD, x, y + h / 2);
  };
  const gun = (x, z, len, col = BLACK) => on(cyl(0.014, 0.018, len, 6).rotateZ(Math.PI / 2), col, x, 0.04, z);
  let top = 0.9, mx = 0, mz = 0;
  switch (kind) {
    case K.FishingBoat: {
      hull(-0.3, 0.42, 0.26, 0.15, "#9a7648", "#c9a878", team, { stern: 0.7, sheer: 0.05, rake: 0.06, n: 8, strake: 0.035 });
      // one slanting yard and a three-cornered sail
      on(cyl(0.012, 0.016, 0.42, 5), DARKWOOD, 0.08, 0.21);
      { const yard = cyl(0.01, 0.01, 0.7, 5); yard.rotateZ(-0.9); on(yard, DARKWOOD, 0.02, 0.4); }
      { const s = new THREE.BoxGeometry(0.5, 0.42, 0.014, 6, 6, 1), p = s.attributes.position;
        for (let i = 0; i < p.count; i++) { const u = p.getX(i) / 0.5 + 0.5, v = p.getY(i) / 0.42 + 0.5; p.setY(i, (v * (0.25 + 0.75 * u) - 0.5) * 0.42 + u * 0.16); p.setZ(i, p.getZ(i) + 0.05 * Math.sin(u * Math.PI) * v); }
        s.computeVertexNormals(); on(s, SAIL, 0.0, 0.3); on(box(0.5, 0.05, 0.02), team, 0.0, 0.14); }
      on(box(0.15, 0.06, 0.15), "#d9d2bd", -0.17, 0.03);                 // a heap of net, floats on it
      for (const [x, z] of [[-0.2, 0.04], [-0.13, -0.04], [-0.17, 0]]) on(ball(0.018, 0), "#c8453a", x, 0.07, z);
      on(box(0.07, 0.11, 0.07), "#5a7a94", 0.24, 0.055, 0.02);            // the fisher, in a straw hat
      on(ball(0.035, 0), SKIN, 0.24, 0.14, 0.02); on(cone(0.065, 0.04, 8), "#d9b85c", 0.24, 0.18, 0.02);
      { const rod = cyl(0.005, 0.005, 0.34, 4); rod.rotateX(1.0); on(rod, DARKWOOD, 0.24, 0.18, 0.16); }
      on(cyl(0.035, 0.03, 0.05, 8), "#8a6438", 0.1, 0.025, -0.05);        // a basket of fish
      on(cyl(0.03, 0.03, 0.01, 8), "#a9c2d0", 0.1, 0.052, -0.05);
      top = 0.62; mx = 0.08;
      break;
    }
    case K.Transport: {
      hull(-0.52, 0.72, 0.5, 0.23, "#7a5532", "#b08a58", team, { stern: 0.8, sheer: 0.05, taper: 0.55, point: 1.4, rake: 0.05 });
      mast(0.05, 0.85, 0.024);
      square(0.05, 0.5, 0.56, 0.42, SAIL, 0.09);
      for (const y of [0.4, 0.6]) on(sailGeo(0.565, 0.06, 0.09), team, 0.055, y);   // two team stripes across the sail
      // the deck piled with cargo: crates, barrels, sacks, a load under a tarpaulin
      for (const [x, z, s, c] of [[-0.3, 0.1, 0.14, "#a07a4f"], [-0.3, -0.07, 0.12, "#8a6438"], [-0.16, 0.0, 0.13, "#a07a4f"], [-0.26, 0.03, 0.1, "#b88a58"]]) on(box(s, s, s), c, x, s / 2 + (s === 0.1 ? 0.13 : 0), z);
      for (const [x, z] of [[0.28, 0.1], [0.28, -0.1], [0.4, 0]]) { on(cyl(0.05, 0.05, 0.12, 8), "#8a5f35", x, 0.06, z); on(cyl(0.053, 0.053, 0.02, 8), IRON, x, 0.06, z); }
      on(box(0.2, 0.1, 0.3), dark, -0.02, 0.05); on(box(0.16, 0.05, 0.26), dark, -0.02, 0.12);
      for (const z of [-0.08, 0.06]) on(ball(0.05, 1).scale(1.3, 0.8, 1), "#d9c38f", 0.17, 0.035, z);
      on(box(0.03, 0.2, 0.03), DARKWOOD, -0.47, 0.1); on(box(0.03, 0.03, 0.14), DARKWOOD, -0.47, 0.2);   // the tiller post
      top = 0.9; mx = 0.05;
      break;
    }
    case K.Galley: {
      hull(-0.56, 0.62, 0.27, 0.15, "#6e4a2c", "#a8824f", "#b8402e", { stern: 0.5, sheer: 0.03, taper: 0.45, point: 2.0, rake: 0.02, strake: 0.03 });
      for (let i = 0; i < 8; i++) for (const sd of [-1, 1]) { const oar = box(0.016, 0.016, 0.36); oar.rotateX(sd * 0.42); m.add(oar, "#c9a878", -0.4 + i * 0.105, 0.01, sd * 0.27); m.add(box(0.03, 0.012, 0.07).rotateX(sd * 0.42), "#e0c898", -0.4 + i * 0.105, -0.055, sd * 0.42); }
      m.add(cone(0.035, 0.2, 6).rotateZ(-Math.PI / 2), "#b98b45", 0.7, -0.03, 0);          // the bronze ram, at the waterline
      for (const sd of [-1, 1]) { m.add(cyl(0.035, 0.035, 0.01, 10).rotateX(Math.PI / 2), "#f2ecda", 0.5, 0.05, sd * 0.062); m.add(cyl(0.015, 0.015, 0.012, 8).rotateX(Math.PI / 2), "#1a1410", 0.505, 0.05, sd * 0.066); }   // an eye on the bow
      for (let k = 0; k < 5; k++) { const a = 0.3 + k * 0.5; m.add(box(0.035, 0.09, 0.05).rotateZ(-a), "#6e4a2c", -0.6 - Math.sin(a) * 0.06 + (k > 2 ? (k - 2) * 0.05 : 0), 0.12 + k * 0.065, 0); }   // the stern post, curling forward
      for (let i = 0; i < 6; i++) for (const sd of [-1, 1]) on(cyl(0.04, 0.04, 0.012, 8).rotateX(Math.PI / 2), i % 2 ? team : dark, -0.34 + i * 0.13, 0.03, sd * (H.at(-0.34 + i * 0.13).hw + 0.008));   // shields along the rail
      mast(0.02, 0.62);
      square(0.02, 0.4, 0.44, 0.3, team, 0.07);
      on(box(0.16, 0.1, 0.16), "#b8402e", -0.42, 0.11); on(box(0.2, 0.015, 0.2), "#b8402e", -0.42, 0.16);       // the captain's awning
      top = 0.68; mx = 0.02;
      break;
    }
    case K.Cog: {
      hull(-0.5, 0.66, 0.42, 0.28, "#7a5532", "#a8824f", "#4e3420", { stern: 0.78, sheer: 0.06, taper: 0.5, point: 1.5, rake: 0.08 });
      // castles fore and aft: boxes on the rails with battlements, team-coloured boards
      const castle = (x, w, d, h) => {
        on(box(w, h, d), "#8a6a42", x, h / 2 + 0.02); on(box(w + 0.03, 0.03, d + 0.03), DARKWOOD, x, h + 0.02);
        on(box(w + 0.01, h * 0.45, d + 0.01), team, x, h * 0.62);
        for (let i = 0; i < 3; i++) for (const sd of [-1, 1]) on(box(0.055, 0.05, 0.03), "#8a6a42", x - w / 2 + 0.03 + i * (w - 0.06) / 2, h + 0.06, sd * d / 2);
        for (let i = 0; i < 3; i++) for (const sx of [-1, 1]) on(box(0.03, 0.05, 0.055), "#8a6a42", x + sx * w / 2, h + 0.06, -d / 2 + 0.03 + i * (d - 0.06) / 2);
      };
      castle(-0.36, 0.26, 0.36, 0.16); castle(0.46, 0.18, 0.24, 0.13);
      mast(0.05, 1.0, 0.026);
      square(0.05, 0.56, 0.52, 0.46, team, 0.09);
      on(sailGeo(0.1, 0.34, 0.11), dark, 0.075, 0.56); on(sailGeo(0.34, 0.09, 0.11), dark, 0.075, 0.6);   // a cross on the sail
      on(cyl(0.06, 0.045, 0.07, 8), "#8a6a42", 0.05, 0.88);                                                  // the crow's nest
      top = 1.02; mx = 0.05;
      break;
    }
    case K.Galleon: {
      hull(-0.6, 0.72, 0.4, 0.28, "#5a3a22", "#a8824f", GOLD, { stern: 0.72, sheer: 0.07, taper: 0.5, point: 1.6, rake: 0.1, strake: 0.03 });
      // the tall stern, in two steps, with windows and a lantern
      on(box(0.34, 0.14, 0.32), "#6e4a2c", -0.42, 0.07); on(box(0.2, 0.12, 0.28), "#7a5532", -0.5, 0.2);
      on(box(0.36, 0.02, 0.34), GOLD, -0.42, 0.145); on(box(0.22, 0.02, 0.3), GOLD, -0.5, 0.265);
      for (const z of [-0.08, 0, 0.08]) m.add(box(0.01, 0.05, 0.045), "#f2d27a", -0.607, H.at(-0.5).y + 0.2, z);
      on(ball(0.03, 0), "#f2d27a", -0.6, 0.33);
      for (let i = 0; i < 6; i++) for (const sd of [-1, 1]) { const x = -0.26 + i * 0.13, hw = H.at(x).hw; m.add(box(0.05, 0.04, 0.02), "#1d1208", x, 0.085, sd * (hw * 0.93)); m.add(box(0.03, 0.012, 0.05), "#2a2c30", x, 0.085, sd * (hw * 0.93 + 0.03)); }   // gun ports, muzzles out
      { const sprit = cyl(0.012, 0.018, 0.42, 5); sprit.rotateZ(-1.15); on(sprit, DARKWOOD, 0.8, 0.1); }
      for (const [x, h, w] of [[0.36, 0.8, 0.36], [0.0, 1.05, 0.46], [-0.32, 0.72, 0.3]]) {
        mast(x, h, 0.022);
        square(x, h * 0.42, w, h * 0.34, SAIL, 0.08); square(x, h * 0.78, w * 0.72, h * 0.24, SAIL, 0.06);
      }
      m.flag(0.2, 0.12, team, -0.52, H.at(-0.5).y + 0.5, 0); on(cyl(0.008, 0.008, 0.3, 4), DARKWOOD, -0.62, 0.42);   // the ensign at the stern
      top = 1.08; mx = 0.0;
      break;
    }
    case K.Ironclad: {
      hull(-0.6, 0.66, 0.42, 0.15, "#2e2b28", "#4a4540", team, { stern: 0.6, sheer: 0.0, taper: 0.55, point: 1.8, rake: -0.04, strake: 0.03 });
      // the casemate: iron plate sloping in on every side, guns through it
      { const g = box(0.66, 0.2, 0.38), p = g.attributes.position;
        for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setX(i, p.getX(i) * 0.62); p.setZ(i, p.getZ(i) * 0.5); }
        g.computeVertexNormals(); on(g, "#3d3935", -0.04, 0.1); }
      on(box(0.42, 0.012, 0.2), "#57514b", -0.04, 0.205);
      for (let i = 0; i < 4; i++) on(box(0.01, 0.012, 0.19), "#2a2724", -0.19 + i * 0.1, 0.212);          // plate seams on the roof
      for (const sd of [-1, 1]) for (const x of [-0.18, -0.04, 0.1]) { on(box(0.05, 0.045, 0.02), "#0f0d0c", x, 0.09, sd * 0.155); on(cyl(0.012, 0.012, 0.08, 6).rotateX(Math.PI / 2), "#1a1816", x, 0.09, sd * 0.19); }
      on(cyl(0.014, 0.014, 0.12, 6).rotateZ(Math.PI / 2), "#1a1816", 0.34, 0.08);                         // the bow gun
      on(cyl(0.06, 0.07, 0.4, 10), "#1f1c1a", -0.1, 0.4); on(cyl(0.075, 0.075, 0.05, 10), team, -0.1, 0.5); on(cyl(0.065, 0.065, 0.02, 10), "#0f0d0c", -0.1, 0.61);   // the funnel
      on(box(0.08, 0.06, 0.08), "#57514b", 0.1, 0.24);                                                     // the pilot house
      m.add(cone(0.04, 0.16, 6).rotateZ(-Math.PI / 2), "#2e2b28", 0.68, -0.03, 0);                         // a ram
      on(cyl(0.008, 0.008, 0.36, 4), "#1a1816", -0.5, 0.18);
      top = 0.72; mx = -0.5;
      break;
    }
    case K.Destroyer: {
      hull(-0.66, 0.84, 0.28, 0.2, GREY, "#7d868c", team, { stern: 0.55, sheer: 0.02, taper: 0.4, point: 1.9, rake: 0.14, strake: 0.025, n: 14 });
      const turret = (x, dir) => { on(cyl(0.06, 0.065, 0.035, 8), DARKGREY, x, 0.018); on(box(0.1, 0.055, 0.09), GREY, x, 0.06); on(cyl(0.011, 0.011, 0.17, 6).rotateZ(Math.PI / 2), BLACK, x + dir * 0.12, 0.065); };
      turret(0.5, 1); on(box(0.12, 0.05, 0.14), GREY, 0.36, 0.025); m.add(box(0.1, 0.055, 0.09), GREY, 0.36, H.at(0.36).y + 0.08, 0); m.add(cyl(0.011, 0.011, 0.17, 6).rotateZ(Math.PI / 2), BLACK, 0.48, H.at(0.36).y + 0.085, 0);   // two guns forward, one above the other
      on(box(0.2, 0.14, 0.2), GREY, 0.16, 0.07); on(box(0.14, 0.07, 0.18), GREY, 0.18, 0.175); on(box(0.145, 0.03, 0.185), BLACK, 0.2, 0.185);   // the bridge and its windows
      for (const x of [-0.04, -0.24]) { const f = cyl(0.045, 0.055, 0.22, 8); f.rotateZ(0.22); on(f, GREY, x, 0.13); on(cyl(0.05, 0.05, 0.035, 8).rotateZ(0.22), team, x - 0.02, 0.21); on(cyl(0.046, 0.046, 0.02, 8).rotateZ(0.22), BLACK, x - 0.027, 0.245); }   // two raked funnels
      on(cyl(0.008, 0.012, 0.42, 5), DARKGREY, 0.1, 0.4); on(box(0.012, 0.012, 0.2), DARKGREY, 0.1, 0.5); on(box(0.1, 0.04, 0.012), DARKGREY, 0.1, 0.58);   // mast and radar
      turret(-0.48, -1);
      for (const sd of [-1, 1]) on(cyl(0.022, 0.022, 0.16, 6).rotateZ(Math.PI / 2), DARKGREY, -0.36, 0.03, sd * 0.07);   // torpedo tubes
      for (let i = 0; i < 3; i++) on(cyl(0.02, 0.02, 0.04, 6).rotateX(Math.PI / 2), BLACK, -0.6, 0.025, -0.05 + i * 0.05);  // depth charges
      top = 0.66; mx = 0.1;
      break;
    }
    case K.Submarine: {
      // A diesel boat on the surface: a low round hull, a flat deck along
      // its top, a conning tower with a rail, periscopes, a gun before it.
      const HULL = "#4a545c";
      const back = new THREE.CapsuleGeometry(0.105, 0.86, 4, 10); back.rotateZ(Math.PI / 2); back.scale(1, 0.62, 1);
      m.add(back, HULL, 0.0, -0.035, 0);
      m.add(box(0.86, 0.03, 0.1), "#69747c", 0.02, 0.035, 0);                                   // the deck casing
      m.add(box(0.14, 0.03, 0.06), "#69747c", 0.5, 0.03, 0);
      m.add(cyl(0.05, 0.06, 0.12, 10).scale(1.7, 1, 1), HULL, 0.02, 0.11, 0);                   // the conning tower
      m.add(cyl(0.062, 0.062, 0.03, 10).scale(1.7, 1, 1), team, 0.02, 0.15, 0);
      for (const sd of [-1, 1]) m.add(box(0.14, 0.008, 0.008), "#c3ccd4", -0.02, 0.2, sd * 0.045);   // its rail
      m.add(cyl(0.008, 0.008, 0.2, 5), "#2a2e31", 0.05, 0.27, 0); m.add(cyl(0.006, 0.006, 0.14, 5), "#2a2e31", 0.0, 0.24, 0);   // periscopes
      m.add(cyl(0.025, 0.03, 0.035, 8), "#2a2e31", 0.24, 0.065, 0); m.add(cyl(0.01, 0.01, 0.16, 6).rotateZ(Math.PI / 2 - 0.25), "#2a2e31", 0.31, 0.105, 0);   // the deck gun
      { const wire = box(0.5, 0.005, 0.005); wire.rotateZ(-0.2); m.add(wire, "#2a2e31", 0.32, 0.1, 0); }   // the net cutter's wire to the bow
      m.add(box(0.04, 0.09, 0.012), HULL, -0.5, 0.02, 0);                                        // the rudder's top
      top = 0.4; mx = 0.02;
      break;
    }
    case K.NuclearSub: {
      // Much bigger, black and smooth: a whale's back, a tall fin with
      // planes on it, a rudder standing out of the water astern, and two
      // rows of missile hatches ringed in white.
      const HULL = "#1f2327";
      const back = new THREE.CapsuleGeometry(0.16, 1.1, 5, 12); back.rotateZ(Math.PI / 2); back.scale(1, 0.6, 1);
      m.add(back, HULL, -0.02, -0.045, 0);
      { const tail = cone(0.1, 0.3, 10); tail.rotateZ(Math.PI / 2); tail.scale(1, 0.6, 1); m.add(tail, HULL, -0.82, -0.04, 0); }
      m.add(box(0.2, 0.2, 0.07), HULL, 0.3, 0.14, 0); m.add(cyl(0.035, 0.035, 0.2, 8), HULL, 0.4, 0.14, 0); m.add(cyl(0.035, 0.035, 0.2, 8), HULL, 0.2, 0.14, 0);   // the fin, rounded fore and aft
      m.add(box(0.21, 0.035, 0.075), team, 0.3, 0.19, 0);
      m.add(box(0.07, 0.012, 0.3), HULL, 0.32, 0.15, 0);                                         // its diving planes
      m.add(cyl(0.008, 0.008, 0.16, 5), "#3a4046", 0.33, 0.32, 0); m.add(cyl(0.006, 0.006, 0.1, 5), "#3a4046", 0.27, 0.29, 0);
      for (let i = 0; i < 5; i++) for (const sd of [-1, 1]) {                                     // the missile deck
        m.add(cyl(0.04, 0.04, 0.012, 10), "#e8e6e0", -0.02 - i * 0.11, 0.052 - i * 0.002, sd * 0.05);
        m.add(cyl(0.03, 0.03, 0.014, 10), "#3a4046", -0.02 - i * 0.11, 0.053 - i * 0.002, sd * 0.05);
      }
      { const fin = box(0.14, 0.2, 0.014), p = fin.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setX(i, p.getX(i) * 0.5 - 0.03); fin.computeVertexNormals(); m.add(fin, HULL, -0.76, 0.1, 0); }   // the rudder
      m.add(box(0.1, 0.012, 0.26), HULL, -0.78, 0.0, 0);
      top = 0.42; mx = 0.3;
      break;
    }
    case K.Carrier: {
      // A long grey hull under a flat deck that overhangs it, an island to
      // starboard, an angled landing strip, and aircraft parked forward.
      hull(-0.84, 0.86, 0.42, 0.2, DARKGREY, "#6a7278", team, { stern: 0.7, sheer: 0.0, taper: 0.55, point: 1.7, rake: 0.1, strake: 0.03 });
      const dy = 0.15;
      m.add(box(1.72, 0.035, 0.52), "#4f575d", 0.02, dy, 0);
      { const ang = box(0.9, 0.036, 0.2); ang.rotateY(0.16); m.add(ang, "#4f575d", -0.3, dy, 0.22); }   // the angled deck, out to port
      for (let k = 0; k < 7; k++) m.add(box(0.12, 0.004, 0.018), "#e6e8dc", -0.72 + k * 0.24, dy + 0.02, -0.04);       // the centre line
      { const l = box(0.86, 0.004, 0.014); l.rotateY(0.16); m.add(l, "#f0d83a", -0.3, dy + 0.02, 0.2); }
      for (const [x, z] of [[0.25, 0.14], [-0.5, -0.12]]) m.add(box(0.14, 0.004, 0.12), "#3a4046", x, dy + 0.02, z);  // lifts
      m.add(box(0.3, 0.2, 0.09), GREY, 0.12, dy + 0.115, -0.21); m.add(box(0.16, 0.07, 0.1), GREY, 0.14, dy + 0.25, -0.21);
      m.add(box(0.165, 0.025, 0.105), BLACK, 0.15, dy + 0.26, -0.21);
      m.add(cyl(0.035, 0.04, 0.1, 8), DARKGREY, 0.02, dy + 0.26, -0.21);                                              // its funnel
      m.add(cyl(0.008, 0.01, 0.26, 5), DARKGREY, 0.16, dy + 0.42, -0.21); m.add(box(0.1, 0.035, 0.012), DARKGREY, 0.16, dy + 0.5, -0.21);
      m.add(box(0.31, 0.03, 0.095), team, 0.12, dy + 0.06, -0.21);
      // aircraft on the deck, wings in the team colour
      for (const [x, z, a] of [[0.62, 0.1, 0.5], [0.5, -0.08, 0.5], [0.72, -0.06, 0.5], [-0.62, 0.05, 0.0]]) {
        m.add(box(0.11, 0.022, 0.022), "#c3ccd4", x, dy + 0.035, z, a); m.add(box(0.03, 0.008, 0.13), team, x, dy + 0.04, z, a); m.add(box(0.012, 0.03, 0.04), "#c3ccd4", x - Math.cos(a) * 0.05, dy + 0.045, z + Math.sin(a) * 0.05, a);
      }
      top = 0.68; mx = 0.16; mz = -0.21;
      break;
    }
  }
  t.flag(0.14, 0.07, team, 0.07, 0, 0);
  // (A carrier is drawn larger, to look big beside the aircraft it carries.)
  const scale = kind === K.Carrier ? 1.7 : 1;
  return { body: m.build(), tool: t.build(), pivot: [mx, H && kind !== K.Carrier ? H.at(mx).y + top : top, mz], height: top, scale };
}

// Buildings are centred on their footprint; y = 0 is the ground.
function buildingModel(kind, owner) {
  const team = PCOL[owner], dark = PDARK[owner];
  const m = new Model();
  const s = stat(kind, 6);
  // A plinth that reaches into the ground hides slopes under the building.
  if (kind !== K.Farm && kind !== K.Dock) m.add(box(s * 0.94, 0.5, s * 0.94), "#6f6553", 0, -0.2, 0); // (the dock has its own footing)
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
      // (As `capitol` in assets/models.py, which is drawn when the models
      // are built in.) Just the statue in the middle of its town square (the paving is
      // `campfire`, drawn round it): a stepped plinth with team-coloured
      // drapes, and a bronze robed figure with one arm up holding a torch
      // (its flame flickers: `updateCampfires`). Team flags at the square's
      // corners say whose it is from afar.
      m.add(box(1.0, 0.1, 1.0), "#b5ab98", 0, 0.14, 0);
      m.add(box(0.8, 0.12, 0.8), "#a89f8c", 0, 0.25, 0);
      m.add(box(0.56, 0.62, 0.56), "#d8cfbb", 0, 0.62, 0);
      for (const [x, z, r] of [[0, 0.285, 0], [0, -0.285, 0], [0.285, 0, Math.PI / 2], [-0.285, 0, Math.PI / 2]]) m.add(box(0.26, 0.4, 0.02), team, x, 0.68, z, r);
      m.add(box(0.7, 0.1, 0.7), "#bfb6a2", 0, 0.98, 0);
      m.add(cone(0.28, 0.8, 10), "#a67c3d", 0, 1.43, 0);
      m.add(cyl(0.12, 0.17, 0.3, 8), "#b98b45", 0, 1.76, 0);
      m.add(ball(0.12, 1), "#c29650", 0, 2.01, 0);
      const arm = box(0.07, 0.34, 0.07); arm.rotateZ(-0.35);
      m.add(arm, "#b98b45", 0.2, 2.0, 0);
      m.add(cyl(0.03, 0.03, 0.34, 6), "#6e4a26", 0.3, 2.24, 0);
      m.add(cyl(0.07, 0.04, 0.08, 8), "#8a6330", 0.3, 2.42, 0);
      for (const [x, z] of [[2.3, 2.3], [-2.3, 2.3], [2.3, -2.3], [-2.3, -2.3]]) {
        m.add(cyl(0.025, 0.025, 1.3, 5), DARKWOOD, x, 0.65, z);
        m.flag(0.4, 0.24, team, x + 0.2, 1.15, z);
      }
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
    case K.Dock: {
      // A boathouse on the land half, a plank pier running out over the
      // water (+z; the whole thing is turned to face the water, see
      // `waterSide`), a crane, a boat tied up alongside, crates and rope.
      // The boathouse: stone footing, timber walls, a steep dark roof, and
      // a big open door to the pier.
      m.add(box(1.5, 0.16, 1.0), STONE2, 0, 0.08, -0.4);
      m.add(box(1.4, 0.62, 0.92), "#8a6a42", 0, 0.47, -0.4);
      for (const x of [-0.69, 0.69]) for (const z of [-0.85, 0.05]) m.add(box(0.07, 0.66, 0.07), DARKWOOD, x, 0.47, z);
      m.add(roof(1.58, 1.1, 0.55), "#5a4a3a", 0, 0.78, -0.4);
      m.add(box(0.62, 0.48, 0.03), "#2a1f15", 0, 0.38, 0.07);       // the open door
      m.add(box(0.7, 0.06, 0.05), DARKWOOD, 0, 0.64, 0.08);           // its lintel
      // The pier: planks across two beams on posts, out past the footprint.
      for (let k = 0; k < 11; k++) m.add(box(0.62, 0.035, 0.12), k % 2 ? WOOD : "#8a6a42", 0.2, 0.06, 0.12 + k * 0.15);
      for (const x of [-0.1, 0.5]) m.add(box(0.05, 0.05, 1.7), DARKWOOD, x, 0.02, 0.92);
      for (const x of [-0.1, 0.5]) for (const z of [0.5, 1.1, 1.7]) m.add(cyl(0.035, 0.04, 0.55, 6), DARKWOOD, x, -0.17, z);
      for (const z of [1.1, 1.7]) m.add(cyl(0.03, 0.03, 0.2, 6), "#3a2a1a", 0.5, 0.16, z);   // bollards
      // A crane at the end: a post, a jib, a rope and a crate on the hook.
      m.add(cyl(0.04, 0.05, 1.0, 6), DARKWOOD, -0.05, 0.55, 1.6);
      { const jib = box(0.05, 0.05, 0.7); jib.rotateX(-0.35); m.add(jib, DARKWOOD, -0.05, 1.0, 1.85); }
      m.add(cyl(0.006, 0.006, 0.45, 4), "#d9c9a8", -0.05, 0.8, 2.15);
      m.add(box(0.14, 0.12, 0.14), "#a07a4f", -0.05, 0.53, 2.15);
      // A rowing boat tied up beside the pier.
      { const hull = cyl(0.11, 0.07, 0.6, 8); hull.rotateX(Math.PI / 2); hull.scale(1, 0.55, 1); m.add(hull, "#7a5532", 0.82, -0.08, 1.2); }
      m.add(box(0.16, 0.02, 0.5), "#5e4128", 0.82, -0.03, 1.2);
      // Crates, a barrel and a coil of rope on the quay; a banner.
      m.add(box(0.2, 0.18, 0.2), "#a07a4f", -0.5, 0.09, 0.3).add(box(0.16, 0.14, 0.16), "#8a6438", -0.5, 0.25, 0.32);
      m.add(cyl(0.09, 0.09, 0.2, 8), "#6e4a2c", -0.25, 0.1, 0.45);
      m.add(new THREE.TorusGeometry(0.07, 0.025, 5, 10).rotateX(Math.PI / 2), "#d9c9a8", 0.25, 0.1, 0.5);
      banner(-0.72, -0.9, 1.3);
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
  // A fish shoal: rings of ripples on the surface, fins breaking it, and
  // the backs of fish just under it (seen through the clear water).
  const fish = new Model();
  for (const [r, y] of [[0.34, 0.012], [0.2, 0.016]]) fish.add(new THREE.TorusGeometry(r, 0.007, 3, 24).rotateX(Math.PI / 2), "#bfe0e6", 0, y, 0);
  for (const [x, z, a] of [[0.12, 0.05, 0.3], [-0.14, -0.1, 2.1], [0.02, -0.2, 4.0], [-0.05, 0.2, 5.2]]) {
    const body = ball(0.06, 1).scale(2.2, 0.6, 0.8).rotateY(a); fish.add(body, "#3d5f6e", x, -0.03, z);
    const fin = cone(0.025, 0.07, 3).rotateY(a); fish.add(fin, "#2c4652", x, 0.02, z);
  }
  const sheep = new Model();
  for (const [x, z] of [[-0.12, -0.08], [0.18, 0.14]]) {
    for (const [lx, lz] of [[0.08, 0.04], [0.08, -0.04], [-0.07, 0.04], [-0.07, -0.04]]) sheep.add(box(0.025, 0.1, 0.025), "#2a221c", x + lx, 0.05, z + lz);
    sheep.add(ball(0.12, 1).scale(1.35, 0.85, 0.95), "#ece6d6", x, 0.16, z).add(ball(0.055, 1), "#2a221c", x + 0.16, 0.19, z);
  }
  return { pine: pine.build(), oak: oak.build(), bush: bush.build(), stone: rock(false), gold: rock(true), horse: animal("#8a5c36", "#6a4528", "#2a1e14", 1, false, [[0, 0, 0]]),
    deer: animal("#a87d4f", "#7a5a3a", "#5a4026", 0.62, true, [[-0.18, -0.12, 0.4], [0.22, 0.18, 2.6]]),
    iron: iron.build(), clay: clay.build(), sheep: sheep.build(), nitrate: rock(false), coal: rock(false), oil: rock(false), bauxite: rock(false), uranium: rock(false), fish: fish.build() };
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
    [K.Sawmill]: "Lumbermill", [K.Stoneworks]: "Stoneworks", [K.Kiln]: "Kiln", [K.AirDefense]: "AirDefense", [K.Pasture]: "Pasture" };
  return GLB_NAMES[kind];
}
const AO_STRENGTH = 0.9;
// The Blender models, and the ones in use: none with the Models setting on
// Simple, which draws the models built in code (unitModel, buildingModel,
// resourceModels) that are otherwise only the fallback.
let glbAll = null, glbModels = null; // name -> { geo, team, ao, tool, pivot }

function loadGlbModels() {
  if (MODELS_B64.startsWith("/*")) return; // not built in
  try {
    const raw = atob(MODELS_B64), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    glbAll = parseGlb(bytes.buffer);
  } catch (e) {
    console.warn("Couldn't load models.glb; using the built-in models.", e);
    glbAll = null;
  }
  glbModels = GFX.models === "simple" ? null : glbAll;
}

function setResourceGeos() {
  R3.resGeo = resourceModels();
  if (glbModels) for (const [k, name] of [["pine", "Pine"], ["oak", "Oak"], ["bush", "Bush"], ["stone", "Stone"], ["gold", "Gold"], ["iron", "IronOre"], ["clay", "ClayPit"], ["sheep", "Sheep"], ["nitrate", "Saltpeter"], ["coal", "CoalSeam"], ["oil", "OilField"], ["bauxite", "Bauxite"], ["uranium", "UraniumOre"], ["horse", "Horse"], ["deer", "Deer"]]) {
    if (glbModels[name]) { R3.resGeo[k].dispose(); R3.resGeo[k] = glbModels[name].geo; }
  }
}

// Switching models: everything is made again with the other set (units and
// buildings on the next frame, resources when they're next drawn, icons
// when next shown).
function applyModels() {
  const want = GFX.models === "simple" ? null : glbAll;
  if (want === glbModels || !R3.resGeo) return;
  glbModels = want;
  modelCache.clear(); iconCache.clear();
  setResourceGeos();
  if (R3.res) { for (const m of R3.res.values()) { R3.scene.remove(m); m.dispose(); } R3.res.clear(); R3.resKey = ""; }
  for (const o of R3.objs.values()) R3.scene.remove(o.root);
  R3.objs.clear();
  R3.popFrom = performance.now() + 500; // (they're not new: no popping in)
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
// The same look for skinned (animated) bodies: three.js picks a shader per
// material, so one material shared by plain, skinned and instanced meshes
// made it work the shader out again at every switch, 60 times a frame,
// and that was most of the page's garbage (70 MB a second).
let entMatSkin, hitMatSkin;
const entMats = () => [entMat, hitMat, entMatSkin, hitMatSkin];
// And the shadow pass: three.js draws every caster with one depth material
// unless it has its own, so skinned and instanced meshes get theirs (one
// for each instanced mesh: with and without instance colours differ).
const depthMat = () => new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
let depthSkin = null;
const modelCache = new Map();
function cachedModel(kind, owner) {
  const key = kind * 64 + owner;
  if (!modelCache.has(key)) modelCache.set(key, glbModel(kind, owner) || (isBld(kind) ? { body: buildingModel(kind, owner) } : unitModel(kind, owner)));
  return modelCache.get(key);
}

// Colour grading happens inside the tone mapping, which every material does
// as it draws: warm the light, cool the shade, a touch more colour, then the
// filmic curve. That costs nothing extra (no second pass), so Fast has it
// too. With grading off the renderer uses plain filmic tone mapping instead
// (a different tone mapping is a different shader, so switching recompiles).
// The vignette is a CSS gradient over the canvas (#vignette).
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  "vec3 CustomToneMapping( vec3 color ) { return color; }",
  `vec3 CustomToneMapping( vec3 color ) {
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color *= mix(vec3(0.9, 1.0, 1.07), vec3(1.07, 1.0, 0.9), smoothstep(0.04, 0.9, lum));
    color = max(mix(vec3(lum), color, 1.12), 0.0);
    return ACESFilmicToneMapping(color);
  }`);

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
  entMatSkin = withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), flagPatch);
  hitMatSkin = withFow(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: "#ff7a4d", emissiveIntensity: 0.55 }), flagPatch);
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
  Fx.build(scene);
  buildBlobs(scene);
  // Bullets: thin bright tracers, too fast to be anything else.
  R3.tracers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.016, 0.016), new THREE.MeshBasicMaterial({ color: "#ffe9a6", transparent: true, opacity: 0.85, depthWrite: false }), 128);
  R3.tracers.frustumCulled = false; R3.tracers.count = 0;
  scene.add(R3.tracers);
  // Muzzle flashes: a glowing burst at the end of the gun for a few frames.
  R3.flashMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: "#ffc860", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), 48);
  R3.flashMesh.frustumCulled = false; R3.flashMesh.count = 0;
  scene.add(R3.flashMesh);
  R3.flashes = [];

  // Rally flag
  const rm = new Model();
  rm.add(cyl(0.02, 0.02, 0.9, 5), DARKWOOD, 0, 0.45, 0).flag(0.32, 0.2, PCOL[1], 0.16, 0.78, 0);
  R3.rally = new THREE.Mesh(rm.build(), entMat);
  R3.rally.receiveShadow = true; // (as bodies: see entMatSkin)
  R3.rallyFor = 1;
  R3.rally.visible = false;
  scene.add(R3.rally);

  loadGlbModels();
  setResourceGeos();
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
  // Shallow water (5, the fords): of the water round a corner, how much is
  // shallow. Its ground lies just under the surface, so people wade.
  const shallowShare = new Float32Array(cw * ch);
  for (let cy = 0; cy <= MH; cy++) for (let cx = 0; cx <= MW; cx++) {
    let sum = 0, n = 0, land = 0, shallow = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const tx = cx + dx, ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) continue;
      sum += elevOf(shade[ty * MW + tx] / 255); n++;
      const t = ter[ty * MW + tx];
      if (t === 1 || t === 5) { wet[cy * cw + cx] = 1; if (t === 5) shallow++; } else land++;
    }
    h[cy * cw + cx] = n ? sum / n : -1;
    landShare[cy * cw + cx] = n ? land / n : 0;
    shallowShare[cy * cw + cx] = n > land ? shallow / (n - land) : 0;
  }
  // Two blur passes turn the blocky per-tile steps into rolling hills.
  // Land is smoothed with land and water with water: blurred together, a
  // river bed pulled the land beside it down below the sand line, and every
  // river ran through a wide strip of sand like a dried-up lake. (Corners on
  // the shore are set below anyway.)
  const kind = i => landShare[i] === 1 ? 1 : landShare[i] === 0 ? 0 : 2;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(h.length);
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      const me = kind(cy * cw + cx);
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cw || y >= ch || (me !== 2 && kind(y * cw + x) !== me)) continue;
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
    const l = landShare[i], sh = shallowShare[i];
    h[i] = l === 0 ? (sh > 0 ? -0.4 + sh * 0.16 : Math.min(h[i], -0.4)) : l === 1 ? Math.max(h[i], 0.02) : WATER_Y + (l - 0.5) * 0.3;
  }
  R3.heights = h;
  R3.hTop = null;
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
  Fx.clear();
  R3.popFrom = performance.now() + 1500; // (no popping in for what's there from the start)
  for (const k of ["terrain", "shore", "water", "tufts", "flowers", "pebbles"]) if (R3[k]) { disposeTree(R3[k]); R3[k] = null; }
  if (R3.terrainGeo) { R3.terrainGeo.dispose(); R3.terrainGeo = null; }
  if (R3.res) for (const m of R3.res.values()) { scene.remove(m); m.dispose(); }
  R3.resKey = "";
  R3.flattened = new Set();
  R3.flatBase = new Map(); // ground height under each levelled site, by "x0,y0,size"

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
  // The whole ground is worked on in `geo` (levelling, shading), which isn't
  // drawn; what's drawn is copies of it in blocks (`terrainToBlocks`).
  R3.terrainGeo = geo;
  const mat = withFow(new THREE.MeshLambertMaterial({ map: tex }), groundPatch);
  const terrain = new THREE.Group();
  for (let by = 0; by < MH; by += BLOCK) for (let bx = 0; bx < MW; bx += BLOCK) {
    const w = Math.min(BLOCK, MW - bx), d = Math.min(BLOCK, MH - by);
    const g = new THREE.PlaneGeometry(w, d, w, d);
    g.rotateX(-Math.PI / 2);
    g.translate(bx + w / 2, 0, by + d / 2);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.userData.block = [bx, by, w, d];
    terrain.add(m);
  }
  scene.add(terrain);
  R3.terrain = terrain;
  terrainToBlocks(0, 0, MW, MH);

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

  // Resources: one instanced mesh per kind and block (`BLOCK`), made when
  // the first of that kind in that block comes into view (`updateResources`).
  // How each kind is drawn:
  const look = (sways, mat) => ({
    // (Each its own material where none is given: instanced meshes with and
    // without their own colours want different shaders; see entMatSkin.)
    mat: mat || (sways ? treeMat : withFow(new THREE.MeshLambertMaterial({ vertexColors: true }), flagPatch)),
    depth: sways ? treeDepthMat : depthMat(),
  });
  R3.resLook = { pine: look(true), oak: look(true), bush: look(true), stone: look(false, stoneMat), gold: look(false, goldMat) };
  for (const k of ["horse", "deer", "iron", "clay", "sheep", "fish", "nitrate", "coal", "oil", "bauxite", "uranium"]) R3.resLook[k] = look(false);
  R3.res = new Map(); // RES_KINDS index * 65536 + block -> its mesh
}
const RES_KINDS = ["pine", "oak", "bush", "stone", "gold", "horse", "deer", "iron", "clay", "sheep", "fish", "nitrate", "coal", "oil", "bauxite", "uranium"];
// Which of RES_KINDS draws a deposit of kind `dep` (defs::Dep) on tile tx, ty.
function resKindOf(dep, tx, ty) {
  switch (dep) {
    case 1: return hash2(tx, ty) < 0.4 ? 0 : 1; // pine or oak
    case 0: return 2; case 3: return 5; case 4: return 6; case 6: return 7; case 7: return 8; case 8: return 9;
    case 9: return 11; case 10: return 12; case 11: return 13; case 12: return 14; case 13: return 15; case 14: return 10;
    default: return 3; // stone
  }
}

// The instanced mesh for this kind of resource (an index into RES_KINDS) in
// block b, with room for n.
function resMesh(k, b, n) {
  const key = k * 65536 + b, kind = RES_KINDS[k];
  let m = R3.res.get(key);
  if (m && m.instanceMatrix.count >= n) return m;
  if (m) { R3.scene.remove(m); m.dispose(); }
  const l = R3.resLook[kind];
  m = new THREE.InstancedMesh(R3.resGeo[kind], l.mat, Math.max(4, 2 ** Math.ceil(Math.log2(n))));
  m.customDepthMaterial = l.depth;
  m.castShadow = true; m.receiveShadow = true; m.count = 0;
  m.userData.res = new Int32Array(m.instanceMatrix.count * 2); // each instance's tile x, y, for picking
  R3.scene.add(m);
  R3.res.set(key, m);
  return m;
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
// lapping foam along the shore. In the spirit of Minecraft's Complementary
// shaders: clear shallows with caustics on the sand, rolling waves made of
// several wave trains and noise (`waterSlope`), the sky and its clouds
// mirrored by Fresnel, and a sharp sun glint off the waves.
// Big things that cover the whole map (water, ground, grass, trees) are cut
// into blocks this many tiles wide, so the graphics card is only handed the
// blocks on screen. (As one piece each, every frame drew the whole map:
// over 5 million triangles on a large Frontier map, at any zoom.)
const BLOCK = 32;

// Remove something from the scene and free its geometry, its children's too.
function disposeTree(o) {
  if (o.parent) o.parent.remove(o);
  o.traverse(c => { if (c.geometry) c.geometry.dispose(); });
}

function buildWater() {
  // One point per tile: the swell is 0.018 high and several tiles long,
  // and ripples, foam and shine are worked out per pixel anyway. (Two per
  // tile drew 2.6 million triangles of water.)
  const pad = 40;
  const water = new THREE.Group();
  const blocks = [];
  for (let bz = -pad; bz < MH + pad; bz += BLOCK) for (let bx = -pad; bx < MW + pad; bx += BLOCK) {
    const w = Math.min(BLOCK, MW + pad - bx), d = Math.min(BLOCK, MH + pad - bz);
    const geo = new THREE.PlaneGeometry(w, d, w, d);
    geo.rotateX(-Math.PI / 2);
    geo.translate(bx + w / 2, WATER_Y, bz + d / 2);
    const pos = geo.attributes.position, depth = new Float32Array(pos.count);
    let wet = false;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      // Outside the map, the sea floor keeps sloping down from the map's edge.
      depth[i] = Math.max(-0.2, WATER_Y - heightAnywhere(x, z));
      if (depth[i] > -0.05) wet = true;
    }
    // A block of dry land, well above the water everywhere: no water there.
    if (!wet) { geo.dispose(); continue; }
    geo.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
    blocks.push(geo);
  }
  // The ground's height under the water, 4 samples per tile, so the shader
  // knows the depth at every pixel: the foam line then follows the real
  // shoreline crisply instead of smearing across the mesh's coarse vertices.
  const HR = 4, hw = (MW + pad * 2) * HR, hh = (MH + pad * 2) * HR, hdata = new Uint16Array(hw * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < hw; i++) hdata[j * hw + i] = THREE.DataUtils.toHalfFloat(heightAnywhere((i + 0.5) / HR - pad, (j + 0.5) / HR - pad));
  const htex = new THREE.DataTexture(hdata, hw, hh, THREE.RedFormat, THREE.HalfFloatType);
  htex.magFilter = htex.minFilter = THREE.LinearFilter;
  htex.needsUpdate = true;
  R3.heightTex = htex;
  // Phong's own highlight is kept faint: the sun's glint is drawn below,
  // from the same waves as the reflection, so the two line up.
  const mat = new THREE.MeshPhongMaterial({ color: "#2b6f8c", specular: "#24343a", shininess: 300, transparent: true, opacity: 0.88, depthWrite: false });
  withFow(mat, sh => {
    sh.uniforms.uTime = timeUniform;
    sh.uniforms.uHeight = { value: htex };
    // The height map's corner and size, as a uniform and never written into
    // the shader's text: three.js reuses a compiled shader whose source looks
    // the same (withFow), so a new map of another size got the last map's
    // numbers, read the heights at the wrong scale, and drew lakes as dry
    // sand and dry land as deep water.
    sh.uniforms.uHeightBox = { value: new THREE.Vector4(pad, pad, MW + pad * 2, MH + pad * 2) };
    sh.vertexShader = "attribute float aDepth;\nuniform float uTime;\nvarying float vDepth;\nvarying vec2 vWPos;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vDepth = aDepth;
      vWPos = position.xz;
      // A slow swell, calm in the shallows.
      transformed.y += (sin(position.x * 0.9 + uTime * 0.9) + cos(position.z * 0.7 + uTime * 0.65) + sin((position.x + position.z) * 1.6 + uTime * 1.4) * 0.5) * 0.018 * clamp(aDepth * 3.0, 0.0, 1.0);`);
    sh.fragmentShader = "uniform float uTime;\nuniform sampler2D uHeight;\nuniform vec4 uHeightBox;\nvarying float vDepth;\nvarying vec2 vWPos;\n" + `
      // The water's surface: waves running different ways, and noise to
      // break them up. Returns its slope (d height / dx, dz), for the normal.
      vec2 waterSlope(vec2 p, float t) {
        vec2 g = vec2(0.0);
        // (direction, frequency, speed, height) of each wave
        vec2 d1 = normalize(vec2(1.0, 0.35)), d2 = normalize(vec2(-0.45, 1.0)), d3 = normalize(vec2(0.8, -0.9)), d4 = normalize(vec2(-1.0, -0.2));
        g += d1 * 1.6 * 0.060 * cos(dot(d1, p) * 1.6 + t * 1.10);
        g += d2 * 2.3 * 0.040 * cos(dot(d2, p) * 2.3 + t * 1.35);
        g += d3 * 3.7 * 0.022 * cos(dot(d3, p) * 3.7 + t * 1.90);
        g += d4 * 5.9 * 0.012 * cos(dot(d4, p) * 5.9 + t * 2.60);
        vec2 q = p * 1.9 + vec2(t * 0.18, -t * 0.13);
        float e = 0.08, n0 = vnoise2(q);
        g += vec2(vnoise2(q + vec2(e, 0.0)) - n0, vnoise2(q + vec2(0.0, e)) - n0) / e * 0.05;
        return g;
      }
    ` + sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ground = texture2D(uHeight, (vWPos + uHeightBox.xy) / uHeightBox.zw).r;
        float dRaw = ${WATER_Y.toFixed(3)} - ground;
        if (dRaw < -0.01) discard;
        float d = clamp(dRaw, 0.0, 2.0);
        // Light is soaked up with depth: turquoise in the shallows, deep blue out at sea.
        vec3 shallow = vec3(0.02, 0.40, 0.52), deep = vec3(0.005, 0.07, 0.24);
        diffuseColor.rgb = mix(shallow, deep, 1.0 - exp(-d * 3.0));
        // Caustics: the waves focus the sunlight into a moving net of bright
        // lines on the sand, seen through clear shallow water.
        vec2 cp = vWPos * 2.4;
        float c1 = vnoise2(cp + vec2(uTime * 0.22, uTime * 0.16)), c2 = vnoise2(cp * 1.37 + vec2(-uTime * 0.19, uTime * 0.25) + 4.1);
        float caus = pow(1.0 - abs(c1 - c2), 16.0);
        diffuseColor.rgb += vec3(0.45, 0.6, 0.5) * caus * 0.22 * (1.0 - smoothstep(0.03, 0.45, d));
        // Foam: a broken line where the water meets the sand, and waves of
        // it washing in and out just beyond.
        float fn = vnoise2(vWPos * 5.0 + vec2(uTime * 0.35, -uTime * 0.2));
        float edge = 1.0 - smoothstep(0.0, 0.008 + 0.022 * fn, d);
        float wash = sin(uTime * 1.5 - d * 70.0 + sin(vWPos.x * 1.7) * 1.5 + cos(vWPos.y * 1.3) * 1.5);
        float wave = smoothstep(0.7, 0.95, wash) * (1.0 - smoothstep(0.015, 0.08, d)) * smoothstep(0.3, 0.7, fn);
        float foam = clamp(max(edge, wave * 0.8), 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.95, 0.95), foam);
        // Clear in the shallows (the sand shows through), darker further out.
        diffuseColor.a = mix(0.55, 0.97, smoothstep(0.0, 0.35, d));
        diffuseColor.a = max(diffuseColor.a, foam * 0.92);`)
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
        // Waves fade out with distance: there they're finer than a pixel and would shimmer.
        float waveAmt = 1.0 - smoothstep(30.0, 80.0, length(vViewPosition));
        {
          vec2 sl = waterSlope(vWPos, uTime) * waveAmt;
          vec3 nw = normalize(vec3(-sl.x, 1.0, -sl.y));
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`)
      // The water mirrors the sky and its clouds, more so at a glancing
      // angle (Fresnel), and the sun glints off the waves.
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        {
          vec3 V = normalize(vViewPosition);
          vec3 R = (vec4(reflect(-V, normal), 0.0) * viewMatrix).xyz;   // to world space
          R.y = abs(R.y);
          R = normalize(R);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(normal, V), 0.0), 5.0);
          vec3 refl = skyColor(R);
          // The same clouds the sky has (see buildSky), mirrored.
          vec2 cq = R.xz / (R.y + 0.08) * 40.0 * 0.045 + vec2(0.82, 0.57) * uTime * 0.012;
          float cn = vnoise2(cq) * 0.62 + vnoise2(cq * 2.3 + 5.0) * 0.28 + vnoise2(cq * 5.1 + 9.0) * 0.1;
          refl = mix(refl, vec3(1.0, 0.95, 0.88), smoothstep(0.48, 0.7, cn) * smoothstep(0.0, 0.25, R.y) * 0.85);
          float sun = max(dot(R, SUN_DIR), 0.0);
          vec3 glint = vec3(1.0, 0.88, 0.66) * (pow(sun, 2500.0) * 3.5 + pow(sun, 250.0) * 0.1);
          totalEmissiveRadiance += (refl * fres * 0.8 + glint) * (1.0 - foam);
        }`);
    sh.fragmentShader = NOISE_GLSL + SKY_GLSL + sh.fragmentShader;
  });
  for (const geo of blocks) {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1;
    m.receiveShadow = true;
    water.add(m);
  }
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
  sea.receiveShadow = true; // (as the water: one shader for both)
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
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  withFow(mat, swayPatch);
  R3.tufts = inBlocks(spots, tuftGeometry(), mat);
  const fmat = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  withFow(fmat, swayPatch);
  // (8 triangles each, as small as they are: a 20-sided ball drew 0.2
  // million triangles of flowers.)
  R3.flowers = inBlocks(spots.filter(s => s[2] < 0.12), new THREE.OctahedronGeometry(0.05, 0).scale(1, 0.6, 1).translate(0.02, 0.26, 0), fmat);
  const palette = ["#f2efe4", "#f3d55b", "#c58ad8", "#e98a5e"].map(c => new THREE.Color(c));
  for (const m of R3.flowers.children) m.userData.spots.forEach((s, i) => m.setColorAt(i, palette[Math.floor(s[2] * 33) % 4]));
  // A few pebbles in the grass, with the stone surface (8 triangles: a
  // 12-sided one drew 0.4 million triangles of pebbles).
  const pg = new THREE.OctahedronGeometry(0.06, 0).scale(1, 0.55, 0.8).translate(0, 0.015, 0);
  pg.setAttribute("color", new THREE.Float32BufferAttribute(new Array(pg.attributes.position.count * 3).fill(0.3), 3));
  R3.pebbles = inBlocks(spots.filter(s => s[2] > 0.95), pg, stoneMat);
  R3.pebbles.userData.pebbles = true;
  placeTufts();
  applyGrass();
  R3.scene.add(R3.tufts, R3.flowers, R3.pebbles);
}
// Spots ([x, y, ...]) drawn as one instanced mesh per block (`BLOCK`), in
// a group. Each keeps its spots, in their order, in userData.spots.
function inBlocks(spots, geo, mat) {
  const bw = Math.ceil(MW / BLOCK), lists = new Map();
  for (const s of spots) {
    const b = Math.floor(s[1] / BLOCK) * bw + Math.floor(s[0] / BLOCK);
    if (!lists.has(b)) lists.set(b, []);
    lists.get(b).push(s);
  }
  const g = new THREE.Group();
  for (const [b, list] of [...lists].sort((a, c) => a[0] - c[0])) {
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    m.receiveShadow = true;
    const bx = (b % bw) * BLOCK, by = Math.floor(b / bw) * BLOCK;
    m.userData.spots = list;
    m.userData.box = [bx, by, bx + BLOCK, by + BLOCK];
    g.add(m);
  }
  return g;
}
// (Re)position all tufts: called after the ground under a building is levelled.
// With a region (corners ax..bx, ay..by), only the tufts in it.
function placeTufts(ax = -1e9, ay = -1e9, bx = 1e9, by = 1e9) {
  const blocked = t => { const b = R3.flattened; return b && b.has(t); };
  const all = ax === -1e9;
  const put = (mesh, spots, pebbles) => {
    let lo = Infinity, hi = -1;
    spots.forEach((s, i) => {
      if (s[0] < ax || s[0] > bx || s[1] < ay || s[1] > by) return;
      lo = Math.min(lo, i); hi = i;
      // no grass on the beach (the ground shader turns low ground to sand)
      const hidden = blocked((Math.floor(s[1]) * MW + Math.floor(s[0]))) || hAt(s[0], s[1]) < 0.24;
      _p.set(s[0], hAt(s[0], s[1]) - 0.01, s[1]);
      _q.setFromAxisAngle(_up, s[2] * 40);
      _s.setScalar(hidden ? 0 : (pebbles ? 0.7 : 1.0) + s[2] * 0.6);
      _m4.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m4);
    });
    if (hi < 0) return;
    const r = mesh.instanceMatrix.updateRange;
    if (all) r.count = -1;
    else { // (just the instances changed, joined with any not sent yet)
      const from = lo * 16, end = (hi + 1) * 16;
      if (r.count === -1) { r.offset = from; r.count = end - from; }
      else { const e = Math.max(r.offset + r.count, end); r.offset = Math.min(r.offset, from); r.count = e - r.offset; }
    }
    mesh.instanceMatrix.needsUpdate = true;
    // (A few tufts moving a little doesn't change the block's bounds.)
    if (all) mesh.computeBoundingSphere();
  };
  for (const g of [R3.tufts, R3.flowers, R3.pebbles]) {
    if (!g) continue;
    for (const m of g.children) {
      const [x0, y0, x1, y1] = m.userData.box;
      if (x1 < ax || x0 > bx || y1 < ay || y0 > by) continue;
      put(m, m.userData.spots, g.userData.pebbles);
    }
  }
}

// Level the ground under a building so it sits flat instead of hovering on a
// slope. We move the terrain's corner heights (which everything samples) and
// the mesh vertices, and blend the ring around it so there's no cliff.
function flattenUnder(cx, cy, s) {
  const h = R3.heights, cw = MW + 1;
  const x0 = Math.round(cx - s / 2), y0 = Math.round(cy - s / 2);
  // Already levelled (the building was there before and is back out of the
  // fog): nothing to do, and blending its ring again would sink it further.
  const site = x0 + "," + y0 + "," + s;
  const had = R3.flatBase.get(site);
  if (had !== undefined) return had;
  // Corners at the water's edge stay where they are: a fishing hut by a
  // pond mustn't fill it in.
  const wet = R3.wet;
  let sum = 0, n = 0;
  for (let y = y0; y <= y0 + s; y++) for (let x = x0; x <= x0 + s; x++) if (!wet || !wet[y * cw + x]) { sum += h[y * cw + x]; n++; }
  const base = Math.max(0.02, n ? sum / n : 0.02);
  const pos = R3.terrainGeo.attributes.position;
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
  // Shade again and send to the graphics card only the rows changed, not
  // the whole map (that was 130 to 150 ms each time).
  terrainNormals(x0 - 2, y0 - 2, x0 + s + 2, y0 + s + 2);
  groundChanged();
  R3.resKey = "";
  placeTufts(x0 - 2, y0 - 2, x0 + s + 2, y0 + s + 2);
  R3.flatBase.set(site, base);
  return base;
}

// Recompute the terrain's normals for the corners from (ax, ay) to (bx, by),
// the same way computeVertexNormals does for the whole mesh (each corner's
// triangles' unnormalised normals, summed), and upload just those rows.
const _na = new THREE.Vector3(), _nb = new THREE.Vector3(), _nc = new THREE.Vector3(), _cb = new THREE.Vector3(), _ab = new THREE.Vector3();
function terrainNormals(ax, ay, bx, by) {
  const geo = R3.terrainGeo, cw = MW + 1;
  const pos = geo.attributes.position, nor = geo.attributes.normal, idx = geo.index.array;
  ax = Math.max(0, ax); ay = Math.max(0, ay); bx = Math.min(MW, bx); by = Math.min(MH, by);
  const inside = v => { const x = v % cw, y = (v - x) / cw; return x >= ax && x <= bx && y >= ay && y <= by; };
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) nor.setXYZ(y * cw + x, 0, 0, 0);
  // The cells touching those corners; PlaneGeometry has 2 triangles (6
  // indices) per cell, row by row.
  for (let cy = Math.max(0, ay - 1); cy <= Math.min(MH - 1, by); cy++) for (let cx = Math.max(0, ax - 1); cx <= Math.min(MW - 1, bx); cx++) {
    for (let t = 0; t < 2; t++) {
      const k = (cy * MW + cx) * 6 + t * 3, va = idx[k], vb = idx[k + 1], vc = idx[k + 2];
      _na.fromBufferAttribute(pos, va); _nb.fromBufferAttribute(pos, vb); _nc.fromBufferAttribute(pos, vc);
      _cb.subVectors(_nc, _nb); _ab.subVectors(_na, _nb); _cb.cross(_ab);
      for (const v of [va, vb, vc]) if (inside(v)) nor.setXYZ(v, nor.getX(v) + _cb.x, nor.getY(v) + _cb.y, nor.getZ(v) + _cb.z);
    }
  }
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    const v = y * cw + x;
    _na.fromBufferAttribute(nor, v).normalize();
    nor.setXYZ(v, _na.x, _na.y, _na.z);
  }
  terrainToBlocks(ax, ay, bx, by);
}

// Copy the ground's corners from ax..bx, ay..by (heights, normals, texture
// places) into the blocks that are drawn, and send just those blocks.
function terrainToBlocks(ax, ay, bx, by) {
  const src = R3.terrainGeo.attributes, cw = MW + 1;
  for (const m of R3.terrain.children) {
    const [x0, y0, w, d] = m.userData.block;
    if (x0 + w < ax || x0 > bx || y0 + d < ay || y0 > by) continue;
    const a = m.geometry.attributes;
    for (let y = 0; y <= d; y++) for (let x = 0; x <= w; x++) {
      const i = y * (w + 1) + x, v = (y0 + y) * cw + x0 + x;
      a.position.array[i * 3 + 1] = src.position.array[v * 3 + 1];
      for (let k = 0; k < 3; k++) a.normal.array[i * 3 + k] = src.normal.array[v * 3 + k];
      a.uv.array[i * 2] = src.uv.array[v * 2]; a.uv.array[i * 2 + 1] = src.uv.array[v * 2 + 1];
    }
    a.position.needsUpdate = a.normal.needsUpdate = a.uv.needsUpdate = true;
    m.geometry.computeBoundingSphere();
  }
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

// Where a ray first meets the ground: walked over the height grid (`hAt`)
// in small steps, then narrowed down between the last two. Testing the
// terrain mesh itself meant every triangle of the map (346,000 on a large
// Frontier map, 27 ms), on every mouse move while placing a building; this
// costs the same on any map. Returns the distance along the ray, or -1.
function groundHit(ray) {
  const o = ray.origin, d = ray.direction, h = R3.heights;
  if (!h) return -1;
  if (R3.hTop == null) { let top = -Infinity; for (let i = 0; i < h.length; i++) if (h[i] > top) top = h[i]; R3.hTop = top; }
  // Only where the ray is over the map and below the highest ground.
  let t0 = 0, t1 = R3.camera.far;
  for (const [p, v, lo, hi] of [[o.x, d.x, 0, MW], [o.z, d.z, 0, MH]]) {
    if (Math.abs(v) < 1e-9) { if (p < lo || p > hi) return -1; continue; }
    let a = (lo - p) / v, b = (hi - p) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (d.y < 0) t0 = Math.max(t0, (R3.hTop - o.y) / d.y); // (above the highest ground: nothing to hit)
  if (t0 > t1) return -1;
  const above = t => o.y + d.y * t - hAt(o.x + d.x * t, o.z + d.z * t);
  const step = 0.25 / Math.max(0.05, Math.hypot(d.x, d.z)); // a quarter tile across the ground
  let prev = t0, fa = above(t0);
  if (fa <= 0) return t0;
  for (let t = t0 + step; ; t += step) {
    const tt = Math.min(t, t1), f = above(tt);
    if (f <= 0) {
      let a = prev, b = tt;
      for (let k = 0; k < 12; k++) { const m = (a + b) / 2; if (above(m) > 0) a = m; else b = m; }
      return b;
    }
    if (tt >= t1) return -1;
    prev = tt;
  }
}
// (When the ground changes: placing a building flattens it.)
function groundChanged() { R3.hTop = null; }

// Screen pixel -> map position on the ground (or null if off the map).
function screenToGround(sx, sy) {
  R3.raycaster.setFromCamera(ndc(sx, sy), R3.camera);
  const ray = R3.raycaster.ray, t = R3.terrain ? groundHit(ray) : -1;
  if (t >= 0) return { x: ray.origin.x + ray.direction.x * t, y: ray.origin.z + ray.direction.z * t };
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
  // (Distances relative to each unit's reach: 20 px, more for the big boats.)
  let best = null, bd = 1;
  for (let i = 0; i < entCount; i++) {
    const k = E(i, F.kind); if (isBld(k)) continue;
    const o = R3.objs.get(E(i, F.id)); if (!o) continue;
    const p = worldToScreen(o.root.position.x, o.root.position.z, o.root.position.y + o.height * 0.5);
    const r = isNaval(k) ? 20 * BOAT_SCALE : 20;
    const d = ((p.x - sx) ** 2 + (p.y - sy) ** 2) / (r * r);
    if (d < bd) { bd = d; best = { x: E(i, F.x), y: E(i, F.y), id: E(i, F.id), what: "unit" }; }
  }
  if (best) return best;
  R3.raycaster.setFromCamera(ndc(sx, sy), R3.camera);
  const targets = _pickTargets;
  targets.length = 0;
  for (const o of R3.objs.values()) if (isBld(o.kind)) targets.push(o.body);
  if (R3.res) for (const m of R3.res.values()) if (m.visible) targets.push(m);
  // The ground: walked over the height grid (`groundHit`), not tested
  // against the terrain mesh; a building or resource in front of it wins.
  const ray = R3.raycaster.ray, tg = R3.terrain ? groundHit(ray) : -1;
  const hit = R3.raycaster.intersectObjects(targets, false)[0];
  if (!hit || (tg >= 0 && tg < hit.distance)) {
    if (tg >= 0) return { x: ray.origin.x + ray.direction.x * tg, y: ray.origin.z + ray.direction.z * tg, what: "ground" };
    return screenToGround(sx, sy);
  }
  if (hit.object.isInstancedMesh) {
    const r = hit.object.userData.res, i = hit.instanceId * 2; // tile x, y per instance
    return { x: r[i] + 0.5, y: r[i + 1] + 0.5, what: "res" };
  }
  const o = hit.object.userData.obj;
  return { x: o.x, y: o.y, id: o.id, what: "building" };
}

const _pickTargets = [];

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
// A Capitol is a town square, where free workers wait and newcomers turn up:
// 5x5 tiles of paving (SQUARE_HALF in people.rs) round the statue, the
// Capitol's own model. The paving is apart from that model so a click on
// the square picks the ground or the workers on it, not the Capitol.
// (Named for the campfire it replaced.)
const SQUARE_HALF = 2.5, TORCH = [0.3, 2.6, 0];
let campfireGeo = null, flameMat = null;
function campfire() {
  if (!campfireGeo) {
    const m = new Model();
    const H = SQUARE_HALF, k = 0.14;
    // A dark kerb that reaches into the ground (so slopes don't show under
    // it), light stone inside, a paler square round the statue, and paths
    // of darker stone from it to the middle of each side.
    m.add(box(H * 2, 0.5, H * 2), "#7d766a", 0, -0.17, 0);
    m.add(box(H * 2 - k * 2, 0.1, H * 2 - k * 2), "#bdb29d", 0, 0.05, 0);
    m.add(box(2.2, 0.12, 2.2), "#a29a88", 0, 0.06, 0);
    m.add(box(1.96, 0.14, 1.96), "#d3c9b4", 0, 0.07, 0);
    const path = H - k - 1.1;
    for (const [x, z, w, d] of [[0, 1.1 + path / 2, 0.5, path], [0, -1.1 - path / 2, 0.5, path], [1.1 + path / 2, 0, path, 0.5], [-1.1 - path / 2, 0, path, 0.5]]) m.add(box(w, 0.13, d), "#a29a88", x, 0.065, z);
    // Stone bollards along the edges, either side of the paths.
    for (const t of [-1.4, -0.7, 0.7, 1.4]) for (const [x, z] of [[t, H - 0.25], [t, -H + 0.25], [H - 0.25, t], [-H + 0.25, t]]) m.add(cyl(0.08, 0.1, 0.3, 8), "#8f887b", x, 0.2, z);
    campfireGeo = m.build();
    flameMat = new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.9 });
  }
  const g = new THREE.Group();
  const square = new THREE.Mesh(campfireGeo, entMat); square.castShadow = true; square.receiveShadow = true; g.add(square);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 7), flameMat);
  flame.position.set(TORCH[0], TORCH[1], TORCH[2]); flame.userData.flame = true; g.add(flame);
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
    o.baseY = flattenUnder(o.x, o.y, groundSize(kind));
    o.height = { [K.Farm]: 0.3, [K.Pasture]: 1.3, [K.Orchard]: 0.9, [K.Dock]: 1.2, [K.Tower]: 3, [K.Capitol]: 2.5 }[kind] || 1.6;
    if (glbModels && kind !== K.Farm) { mdl.body.computeBoundingBox(); o.height = Math.min(o.height + 0.6, mdl.body.boundingBox.max.y); }
    root.position.set(o.x, o.baseY, o.y);
    // A dock turns its pier (+z) to the water beside it.
    if (kind === K.Dock) root.rotation.y = waterSide(o.x, o.y, s);
    if (kind === K.Capitol) { o.campfire = campfire(); root.add(o.campfire); }
  } else if (mdl.rig) {
    root.remove(body);
    makeRigged(o, mdl);
  } else {
    const pivot = new THREE.Group();
    pivot.position.set(...mdl.pivot);
    const tool = new THREE.Mesh(mdl.tool, entMat);
    o.toolMesh = tool;
    tool.castShadow = tool.receiveShadow = true; // (as bodies: see entMatSkin)
    pivot.add(tool);
    body.add(pivot);
    o.tool = pivot; o.toolTilt = mdl.toolTilt || 0;
    // Boats are drawn bigger than their footprint in the game, so they read
    // as ships next to the people (playtest: "at least 2x").
    const sc = (mdl.scale || UNIT_SCALE) * (isNaval(kind) ? BOAT_SCALE : 1);
    o.height = mdl.height * sc;
    body.scale.setScalar(sc);
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
  const mesh = new THREE.SkinnedMesh(mdl.body, entMatSkin);
  mesh.customDepthMaterial = depthSkin ??= depthMat();
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
  tool.castShadow = tool.receiveShadow = true; // (as bodies: see entMatSkin)
  tool.position.set(ta[0] - tp[0], ta[1] - tp[1], ta[2] - tp[2]);
  bones[tb].add(tool);
  o.toolMesh = tool; o.toolBone = tb;
  o.height = mdl.height * UNIT_SCALE;
  mesh.scale.setScalar(UNIT_SCALE);
  o.rs = new RigState((o.id * 0.6180339) % 1 * 100, o.x, o.y);
}

// One frame of a rigged unit. anim: 0 idle, 1 walking, 2 working, 3 attacking.
// A rigged unit's springs and pace, in an object of their own (one shape
// for all, numbers from the start: writing them makes no garbage).
class RigState {
  constructor(seed, x, y) {
    this.seed = seed; this.prevX = x + 0.5 - 0.5; this.prevY = y + 0.5 - 0.5;
    this.speed = 0.5; this.lean = 0.5; this.leanV = 0.5; this.flinch = 0.5; this.flinchV = 0.5;
    this.speed = this.lean = this.leanV = this.flinch = this.flinchV = 0;
    this.wasHit = false;
  }
}
function animateRig(o, kind, anim, t, dt, hit) {
  const B = o.bones;
  // The bones' angles, worked out in plain numbers and set once at the end:
  // each change to a bone's rotation makes three.js work out its quaternion
  // again, a dozen times a bone a frame (and garbage each time).
  const R = o.rot ??= Object.fromEntries(RIG_BONES.map(n => [n, { x: 0.5, y: 0.5, z: 0.5 }]));
  for (let k = 0; k < RIG_BONES.length; k++) { const r = R[RIG_BONES[k]]; r.x = 0; r.y = 0; r.z = 0; }
  B.body.scale.set(1, 1, 1);
  B.hips.position.y = o.hipsY;
  dt = Math.min(dt, 0.05);
  // How fast it's really moving, smoothed (tiles per second).
  const v = Math.hypot(o.x - o.rs.prevX, o.y - o.rs.prevY) / Math.max(dt, 1e-3);
  o.rs.prevX = o.x; o.rs.prevY = o.y;
  o.rs.speed += (Math.min(v, 6) - o.rs.speed) * Math.min(1, dt * 10);
  const walking = anim === 1 || o.rs.speed > 0.4;
  // The body leans into the walk on a springy joint, so it wobbles when
  // starting and stopping.
  const leanTo = walking ? -0.2 : anim === 3 ? -0.12 : 0;
  o.rs.leanV += ((leanTo - o.rs.lean) * 70 - o.rs.leanV * 8) * dt; o.rs.lean += o.rs.leanV * dt;
  // A flinch when hit: a kick backwards on another spring.
  if (hit && !o.rs.wasHit) o.rs.flinchV += 9;
  o.rs.wasHit = hit;
  o.rs.flinchV += (-o.rs.flinch * 140 - o.rs.flinchV * 11) * dt; o.rs.flinch += o.rs.flinchV * dt;
  const f = o.rs.flinch;
  const T = t + o.rs.seed;
  const horse = isMounted(kind);
  if (horse) {
    const ph = T * (walking ? 13 : 0);
    if (walking) {
      R.legFL.z = Math.sin(ph) * 0.75; R.legFR.z = Math.sin(ph + 0.7) * 0.75;
      R.legBL.z = Math.sin(ph + Math.PI) * 0.75; R.legBR.z = Math.sin(ph + Math.PI + 0.7) * 0.75;
      B.hips.position.y = o.hipsY + Math.abs(Math.sin(ph)) * 0.05;
      R.hips.z = Math.sin(ph) * 0.07;
      R.neck.z = Math.sin(ph + 0.5) * 0.15;
      R.body.z = -Math.sin(ph + 0.8) * 0.12 + o.rs.lean * 0.6;
      R.head.z = Math.sin(ph + 1.4) * 0.12;
    } else {
      R.neck.z = Math.sin(T * 0.8) * 0.06 - 0.05;   // idle: head bobs, grazes now and then
      R.body.z = o.rs.lean * 0.6;
    }
    R.tail.z = Math.sin(T * (walking ? 9 : 2.5)) * (walking ? 0.35 : 0.2);
    R.tail.x = Math.sin(T * 1.7) * 0.25;
    R.armL.z = 0.5; R.armL.x = 0.2;           // holding the reins
    let arm = 0.9, jab = 0;
    if (kind === K.Dragoon) {
      // A carbine: held level while fighting, a kick at each real shot.
      const kick = recoil(sinceShot(o));
      if (anim === 3) arm = 1.3 + kick * 0.35;
      R.body.z += kick * 0.2;
      jab = -kick * 1.5;
    } else if (anim === 3) { jab = Math.max(0, Math.sin(T * 7)); arm = 1.0 + jab * 0.5; R.body.z -= jab * 0.25; }
    R.armR.z = arm;
    o.toolMesh.rotation.z = -arm - R.body.z + 0.12 - jab * 0.15;  // the lance stays couched, pointing forward
  } else {
    const ph = T * 10;
    const s = Math.sin(ph);
    if (walking) {
      R.legL.z = s * 0.8; R.legR.z = -s * 0.8;
      R.armL.z = -s * 0.65; R.armR.z = s * 0.65;
      B.hips.position.y = o.hipsY + Math.abs(Math.cos(ph)) * 0.035;
      R.hips.x = s * 0.13;                              // the waddle
      R.head.x = -s * 0.1;
    } else {
      B.body.scale.y = 1 + Math.sin(T * 2.2) * 0.025;            // breathing
      R.head.y = Math.sin(T * 0.7) * 0.35 * Math.max(0, Math.sin(T * 0.23));  // looks around now and then
    }
    R.armL.x += 0.12; R.armR.x -= 0.12;      // arms a little out from the body
    R.body.z = o.rs.lean;
    R.head.z = -o.rs.lean * 0.4;
    const tb = R[o.toolBone];
    let toolWorld = null; // the tool's angle in the unit's frame, or null to follow the arm
    if (anim === 2 || (anim === 3 && kind === K.Worker)) {
      // A big overhead chop: wind up, strike, recover.
      const c = (T * 1.5) % 1;
      const a = c < 0.55 ? 0.3 + (c / 0.55) * 2.4 : c < 0.68 ? 2.7 - ((c - 0.55) / 0.13) * 2.6 : 0.1 + ((c - 0.68) / 0.32) * 0.2;
      R.armR.z = a;
      R.body.z += c > 0.55 && c < 0.75 ? -0.3 : 0.08;
      if (!walking) { R.legL.z = 0.25; R.legR.z = -0.15; }
      o.toolMesh.rotation.z = -Math.PI / 2;                     // the head points out of the fist
    } else if (anim === 3 && (kind === K.Spearman || kind === K.Swordsman)) {
      // Jab with the spear, leaning in, shield up.
      const jab = Math.max(0, Math.sin(T * 8));
      R.armR.z = 1.2 + jab * 0.4;
      R.body.z += -jab * 0.3;
      R.armL.z = 0.9; R.armL.x = 0.4;
      if (!walking) { R.legL.z = 0.35; R.legR.z = -0.3; }
      toolWorld = -1.45 - jab * 0.1;
    } else if ((anim === 3 || (!walking && sinceShot(o) < 1.5)) && (kind === K.Crossbowman || kind === K.Musketeer || kind === K.Rifleman || kind === K.MachineGunner || kind === K.Infantry)) {
      // The weapon levelled at the target in both hands. Each real shot
      // kicks it up and the shooter back; slow weapons are lowered to
      // reload between shots, then brought up to aim again.
      const s = sinceShot(o), cd = stat(kind, 8);
      const kick = recoil(s) * (kind === K.MachineGunner ? 0.55 : 1);
      const down = cd >= 2 ? Math.min(smooth((s - 0.35) / 0.3), 1 - smooth((s - (cd - 0.7)) / 0.4)) : 0;
      R.armR.z = 1.3 + kick * 0.3 - down * 0.7; R.armL.z = 1.25 + kick * 0.2 - down * 0.35; R.armL.x = -0.35;
      R.body.z += kick * 0.22 + down * 0.08;
      R.head.z -= kick * 0.15;
      toolWorld = kick * 0.35 + down * 1.1;
    } else if (anim === 3 && kind === K.Archer) {
      // Bow arm out front; the string hand looses at each real shot and
      // draws back to the chest again for the next.
      const s = sinceShot(o), cd = stat(kind, 8);
      const draw = s > cd ? 1 : smooth((s - 0.2) / Math.max(0.3, cd * 0.6));
      R.armL.z = 1.45; R.armL.x = 0.25;
      R.armR.z = 1.2 + (1 - draw) * 0.3; R.armR.x = 0.55 * draw;
      R.body.y = 0.35;
      toolWorld = 0;
    } else {
      toolWorld = kind === K.Spearman || kind === K.Swordsman ? -0.25 : kind === K.Musketeer || kind === K.Rifleman ? 1.25 : kind === K.MachineGunner || kind === K.Infantry ? 0 : kind === K.Archer || kind === K.Crossbowman ? 0 : null;
      if (kind === K.Worker) o.toolMesh.rotation.z = -0.4;
    }
    if (toolWorld != null) o.toolMesh.rotation.z = toolWorld - tb.z - (o.toolBone === "armR" || o.toolBone === "armL" ? R.body.z : 0);
  }
  // The flinch: knocked back and squashed for a moment.
  R.body.z += f * 0.6;
  R.head.z += f * 0.5;
  B.body.scale.y *= 1 - f * 0.12;
  B.body.scale.x *= 1 + f * 0.06; B.body.scale.z *= 1 + f * 0.06;
  // (Into the Euler's own fields, then one quaternion update: passing three
  // numbers to rotation.set boxes each one, 40 KB a frame for an army.)
  for (let k = 0; k < RIG_BONES.length; k++) {
    const b = B[RIG_BONES[k]], r = R[RIG_BONES[k]], e = b.rotation;
    if (e._x === r.x && e._y === r.y && e._z === r.z) continue;
    e._x = r.x; e._y = r.y; e._z = r.z;
    b.quaternion.setFromEuler(e, false);
  }
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

const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere();
function render3d(alpha, now, dt) {
  const t = now / 1000;
  timeUniform.value = t;
  placeCamera();
  // What the camera sees, for skipping the walk cycles of units out of it.
  _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(R3.camera.projectionMatrix, R3.camera.matrixWorldInverse));
  const mark = ++R3.mark; // objects still in the world this frame get this mark
  const blobs = GFX.shadows === -1 && R3.blobs;
  blobN = 0;
  let pt = performance.now(); // (timing for the trace: `Prof`, net.js)

  for (let i = 0; i < entCount; i++) {
    const id = E(i, F.id), kind = E(i, F.kind);
    let o = R3.objs.get(id), changed = false;
    if (o && (o.kind !== kind || o.owner !== E(i, F.owner))) { R3.scene.remove(o.root); o = null; changed = true; }
    if (!o) {
      o = makeObj(i);
      // A new unit of yours, or one that changed (a worker who became a
      // soldier) pops in; anything else just came into view.
      if (!isBld(kind) && GFX.effects && now > R3.popFrom && (changed || o.owner === ME)) o.pop = now;
    }
    o.mark = mark;
    const flags = E(i, F.flags);
    o.lastHp = E(i, F.hp) / E(i, F.maxhp);
    o.residents = E(i, F.residents);
    // Every finished Capitol has its town square (people.rs: newcomers come
    // to the one nearest their house, and free workers wait at the nearest).
    if (o.campfire) o.campfire.visible = !(E(i, F.flags) & 2);
    if (isBld(kind)) {
      const building = flags & 2;
      // Placed, but no builder there yet: only its owner sees where it will go.
      const planned = !!(flags & 512);
      o.body.visible = !planned;
      if (planned && !o.plan && E(i, F.owner) === ME) {
        const s = groundSize(kind);
        o.plan = new THREE.Mesh(new THREE.PlaneGeometry(s, s).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: PCOL[ME], transparent: true, opacity: 0.28, depthWrite: false }));
        o.plan.position.y = 0.05; o.plan.renderOrder = 2;
        o.root.add(o.plan);
      }
      if (o.plan) o.plan.visible = planned;
      // Finished: a ring of dust rolls out from its foot.
      if (o.wasBuilding && !building && !planned) fxDustRing(o.x, o.y, stat(kind, 6) * 0.5, 14);
      o.wasBuilding = !!building;
      if (blobs && !planned && kind !== K.Farm) { const s = stat(kind, 6) * 1.25; addBlob(o.x, o.baseY, o.y, s, s, o.root.rotation.y); }
      o.body.scale.y = building ? Math.max(0.12, E(i, F.prog)) : 1;
      o.body.material = (flags & 8) ? hitMat : entMat;
      setRing(o, !!(flags & 1), kind === K.Capitol ? 1.2 : stat(kind, 6) * 0.78);
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
    o.root.position.set(x, isNaval(kind) ? WATER_Y + 0.02 : groundAt(x, y) + (isAir(kind) ? AIR_ALT + Math.sin(t * 1.3 + id) * 0.08 : 0), y);
    // Turn smoothly toward the facing Rust reports (three.js turns the other way).
    let target = -E(i, F.face), d = target - o.face;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    o.face += d * Math.min(1, dt * 12);
    o.root.rotation.y = o.face;
    if (blobs) {
      const r = W.kind_radius(kind) * (isNaval(kind) ? BOAT_SCALE * 2.2 : 2.6), sc = o.pop ? o.root.scale.x : 1;
      // Long things (horses, boats, guns) get a longer blob, turned with them.
      const long = isMounted(kind) || isNaval(kind) || kind === K.Cannon || kind === K.FieldGun || kind === K.Tank ? 1.5 : 1;
      addBlob(x, isNaval(kind) ? WATER_Y : groundAt(x, y), y, r * long * sc, r * sc, o.face); // (+x is its front)
    }
    const anim = E(i, F.anim);
    const ph = t + id * 0.37;
    if (GFX.effects) {
      // Dust kicked up, or a wake, for the distance it went this frame.
      const mv = o.fxX === undefined ? 0 : Math.hypot(x - o.fxX, y - o.fxY);
      if (mv > 0.001 && mv < 1) fxTrail(o, kind, mv);
      if (o.pop === now) fxDustRing(x, y, 0.25, 6);
    }
    o.fxX = x; o.fxY = y;
    if (o.pop) {
      const p = (now - o.pop) / POP_MS;
      if (p >= 1) { o.root.scale.setScalar(1); o.pop = 0; }
      else o.root.scale.setScalar(Math.max(0.001, popScale(p)));
    }
    if (o.bones) {
      // Out of sight (with room for a shadow falling into it): no walk
      // cycle, which was the most garbage the page made after three.js.
      _sph.center.copy(o.root.position); _sph.radius = 3;
      if (_frustum.intersectsSphere(_sph)) animateRig(o, kind, anim, t, dt, !!(flags & 8));
      else { o.rs.prevX = o.x; o.rs.prevY = o.y; }
    }
    else if (isNaval(kind)) {
      // Boats ride the swell: a slow bob and roll, a little pitch when under way.
      o.body.position.y = Math.sin(ph * 1.7) * 0.025 - 0.02;
      o.body.rotation.x = Math.sin(ph * 1.3) * 0.05;
      o.body.rotation.z = anim === 1 ? Math.sin(ph * 2.1) * 0.03 - 0.02 : Math.sin(ph * 0.9) * 0.02;
    } else {
      o.body.position.y = anim === 1 ? Math.abs(Math.sin(ph * 11)) * 0.035 : 0;
      o.body.rotation.z = anim === 1 ? -0.06 : 0;
      o.body.position.x = 0;
    }
    const gun = kind === K.Cannon || kind === K.FieldGun || kind === K.Tank || kind === K.RocketArtillery;
    if (o.tool && isNaval(kind)) o.tool.rotation.z = 0;
    else if (o.tool) {
      let swing = 0;
      if (kind === K.Trebuchet) {
        swing = trebuchetArm(sinceShot(o), stat(kind, 8));
        // The whole engine rocks as the counterweight drops.
        const s = sinceShot(o);
        if (s < 1) o.body.rotation.z += Math.sin(s * 14) * 0.05 * (1 - s);
      } else if (gun) {
        // Each real shot: the barrel kicks up and the piece rolls back.
        const k = recoil(sinceShot(o));
        swing = -k * (kind === K.RocketArtillery ? 0.12 : 0.3);
        o.body.position.x = -k * (kind === K.RocketArtillery ? 0.02 : 0.09);
      }
      else if (anim === 2) swing = Math.max(0, Math.sin(ph * 7)) * 1.6 - 0.4;
      else if (anim === 3) swing = kind === K.Archer ? 0.35 : Math.max(0, Math.sin(ph * 9)) * 1.4 - 0.2;
      o.tool.rotation.z = -swing - o.toolTilt;
      if (isAir(kind)) { o.tool.rotation.z = 0; o.tool.rotation.x = t * 40; } // the propeller
    }
    if (isAir(kind)) { o.body.position.y = 0; o.body.rotation.z = 0; o.body.rotation.x = Math.sin(t * 0.9 + id) * 0.08; }
    const mat = (flags & 8) ? hitMat : entMat;
    o.body.material = o.body.isSkinnedMesh ? ((flags & 8) ? hitMatSkin : entMatSkin) : mat;
    if (o.toolMesh) o.toolMesh.material = mat;
    setRing(o, !!(flags & 1), W.kind_radius(kind) * 1.45 * (isNaval(kind) ? BOAT_SCALE : 1));
  }

  // Things that vanished: badly hurt units and buildings get a short death
  // animation; anything else just walked into the fog.
  for (const o of R3.objs.values()) { // (values(), not [id, o] pairs: no array per object per frame)
    if (o.mark === mark) continue;
    R3.objs.delete(o.id);
    if (o.ring) o.ring.visible = false;
    if (isBld(o.kind) && o.lastHp < 0.3) fxCollapse(o.x, o.y, stat(o.kind, 6));
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
  if (R3.blobs) { R3.blobs.count = blobN; R3.blobs.instanceMatrix.needsUpdate = true; }
  pt = Prof.add("draw: units and buildings", pt);

  updateResources();
  pt = Prof.add("draw: resources", pt);
  updateArrows(alpha);
  updateRally();
  updateGhost();
  updateMarkers(now);
  updateSmoke();
  updateCampfires(performance.now());
  updatePuffs(performance.now());
  Fx.update(Math.min(0.1, dt));
  updateFlashes(performance.now());
  updateNukes(performance.now(), alpha);
  updateAimRings();
  Prof.add("draw: effects", pt);
  // Timed for the trace: handing the frame to the graphics card (and
  // compiling any shader it hasn't needed before).
  const g = performance.now();
  renderScene();
  R3.gpuMs = performance.now() - g;
  Prof.add("graphics card", g);
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
  R3.interceptors = [];
  R3.shotAt = new Map(); // where an air defense's missile meets each nuke fired at, by target
  R3.craterMeshes = [];
  R3.fireballs = [];
}
function updateNukes(now, alpha = 0) {
  if (!R3.scene || !W) return;
  nukeMeshes();
  const n = W.nuke_count();
  while (R3.nukeMesh.length < n) {
    const mesh = new THREE.Mesh(R3.nukeGeo, entMat); mesh.receiveShadow = true; mesh.scale.setScalar(1.6); R3.scene.add(mesh); R3.nukeMesh.push(mesh);
    const ring = new THREE.Mesh(new THREE.RingGeometry(W.nuke_numbers(2) - 0.25, W.nuke_numbers(2), 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ff3b2f", transparent: true, opacity: 0.7, depthWrite: false }));
    R3.scene.add(ring); R3.nukeRings.push(ring);
    // The air defense's missile: the very one it fires at aircraft (R3.missiles), pointing along y.
    R3.interceptorGeo ??= R3.missiles.geometry.clone().rotateZ(-Math.PI / 2);
    const im = new THREE.Mesh(R3.interceptorGeo, R3.missiles.material); im.visible = false; R3.scene.add(im); R3.interceptors.push(im);
  }
  for (let k = 0; k < R3.nukeMesh.length; k++) {
    const mesh = R3.nukeMesh[k], ring = R3.nukeRings[k], im = R3.interceptors[k];
    mesh.visible = ring.visible = k < n;
    im.visible = false;
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
    // An air defense has fired at it (`NUKE_INTERCEPT_AT` seconds before it
    // would land): its missile climbs from the battery to where it meets
    // the nuke (`INTERCEPTOR_FLIGHT` seconds later), and the nuke blows up
    // there (`nukeBurst`).
    if (W.nuke_info(k, 6)) {
      const AT = W.nuke_numbers(5), FL = W.nuke_numbers(6);
      const u = Math.min(1, Math.max(0, (AT - (1 - p) * NUKE_FLIGHT_S) / FL));
      const ax = W.nuke_info(k, 7), ay = W.nuke_info(k, 8), a0 = groundAt(ax, ay) + 1.2;
      const hit = at(1 - (AT - FL) / NUKE_FLIGHT_S);
      R3.shotAt.set(`${tx},${ty}`, hit);
      // Fast off the rail, a little bowed upward.
      const v = u * (0.6 + 0.4 * u);
      const mp = q => [ax + (hit[0] - ax) * q, ay + (hit[1] - ay) * q, a0 + (hit[2] - a0) * q + 2 * q * (1 - q)];
      const [mx, my, mh] = mp(v), [mx2, my2, mh2] = mp(Math.min(1, v + 0.02));
      im.visible = true;
      im.position.set(mx, mh, my);
      _v3.set(mx2 - mx, mh2 - mh, my2 - my);
      if (_v3.lengthSq() > 1e-8) im.quaternion.setFromUnitVectors(_up, _v3.normalize());
      if (R3.puffs && R3.puffs.length < 64) R3.puffs.push({ x: mx, y: my, h: mh, t0: now, big: false, seed: Math.random() * 6.28 });
    }
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
    f.mesh.scale.setScalar((0.5 + Math.min(1, a * 3) * 4.5) * W.nuke_numbers(2) / 5 * (f.size || 1));
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

// A nuke shot down (the game's event gives where it was going): a burst in
// the sky where the air defense's missile met it, smaller than a blast.
function nukeBurst(x, y) {
  if (!R3.scene) return;
  nukeMeshes();
  const key = `${x},${y}`, hit = R3.shotAt.get(key) || [x, y, groundAt(x, y) + 4];
  R3.shotAt.delete(key);
  const [bx, by, bh] = hit;
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: "#ffe2a0", transparent: true, opacity: 0.9 }));
  mesh.position.set(bx, bh, by);
  R3.scene.add(mesh);
  R3.fireballs.push({ mesh, t0: performance.now(), y0: bh, size: 0.35 });
  for (let k = 0; k < 10; k++) R3.puffs.push({ x: bx + Math.cos(k) * 1.2, y: by + Math.sin(k) * 0.8, h: bh + (k % 3) * 0.4, t0: performance.now() + k * 60, big: true, seed: k });
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
// The drawn unit of this kind nearest (x, y): who fired a shot from there.
function shooterAt(x, y, kind) {
  let o = null, bd = 0.6;
  for (const c of R3.objs.values()) {
    if (c.kind !== kind || c.x === undefined) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bd) { bd = d; o = c; }
  }
  return o;
}
// A shot was fired (Ev::Shoot): the shooter's recoil, a trebuchet's throw
// and an archer's loose are timed from this, so they only move when a shot
// really leaves. Guns also flash at the muzzle.
function shotFired(x, y, kind) {
  const o = shooterAt(x, y, kind);
  if (!o) return;
  o.shotAt = performance.now();
  if (isGun(kind) && !isAir(kind) && kind !== K.AirDefense && kind !== K.RocketArtillery && R3.flashes) {
    const m = muzzle(x, y, kind, o);
    if (m && R3.flashes.length < 48) R3.flashes.push({ x: m.x, y: m.y, z: m.z, t0: o.shotAt, big: isBigGun(kind), seed: Math.random() * 6.28 });
  }
}
function updateFlashes(now) {
  const m = R3.flashMesh;
  if (!m) return;
  let n = 0, keep = 0;
  for (const f of R3.flashes) {
    const life = f.big ? 140 : 90, age = (now - f.t0) / life;
    if (age >= 1) continue;
    R3.flashes[keep++] = f;
    _p.set(f.x, f.y, f.z);
    _q.setFromAxisAngle(_up, f.seed + age);
    _s.setScalar((f.big ? 0.22 : 0.075) * (age < 0.25 ? 0.6 + age * 1.6 : 1 - (age - 0.25) / 0.75 * 0.9));
    _m4.compose(_p, _q, _s);
    m.setMatrixAt(n++, _m4);
  }
  R3.flashes.length = keep;
  m.count = n;
  m.instanceMatrix.needsUpdate = true;
}
// Seconds since this unit last fired (a long time if never).
function sinceShot(o) { return o.shotAt ? (performance.now() - o.shotAt) / 1000 : 1e9; }
// A recoil: a sharp kick that dies away in a few tenths of a second.
function recoil(s) { return s > 0.5 ? 0 : s < 0.03 ? s / 0.03 : Math.exp(-(s - 0.03) * 12); }
const smooth = p => p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p);
// The trebuchet's arm, s seconds after a throw, with cd seconds to reload
// (radians it has swung forward). It rests cocked; the counterweight drops
// and whips the sling over the top in a fifth of a second (the stone leaves
// on the shot's tick), bounces, hangs, then is winched slowly back.
const TREB_SWING = 1.9;
function trebuchetArm(s, cd) {
  if (s >= cd) return 0;
  if (s < 0.2) { const p = s / 0.2; return TREB_SWING * p * p; }
  if (s < 0.7) { const p = (s - 0.2) / 0.5; return TREB_SWING + Math.sin(p * Math.PI * 2) * 0.18 * (1 - p); }
  const back0 = 1.1, back1 = Math.max(back0 + 0.5, cd - 0.4);
  return TREB_SWING * (1 - smooth((s - back0) / (back1 - back0)));
}

function muzzle(x, y, kind, o) {
  o = o || shooterAt(x, y, kind);
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

// --- Blob shadows ------------------------------------------------------------------
// The cheap kind of shadow (Shadows: Blobs): a soft dark disc on the ground
// under every unit and building, all in one instanced mesh. Without any
// shadow, things look pasted onto the ground instead of standing on it.
const BLOB_MAX = 2048;
function buildBlobs(scene) {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(0,0,0,1)"); grd.addColorStop(0.45, "rgba(0,0,0,0.8)"); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const mat = withFow(new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.5, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  R3.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, BLOB_MAX);
  R3.blobs.frustumCulled = false; R3.blobs.count = 0; R3.blobs.renderOrder = 1;
  scene.add(R3.blobs);
}
let blobN = 0;
// (Called while drawing each thing: `w` is its size along its +x, `d` across.)
function addBlob(x, h, y, w, d = w, turn = 0) {
  if (blobN >= BLOB_MAX) return;
  _p.set(x, h + 0.04, y); _q.setFromAxisAngle(_up, turn); _s.set(w, 1, d);
  _m4.compose(_p, _q, _s);
  R3.blobs.setMatrixAt(blobN++, _m4);
}

// --- Small effects ---------------------------------------------------------------
// Dust, wood chips, debris, splashes, wakes and sparks: short-lived bits that
// fly, fall and shrink away. Three instanced meshes draw all of them: soft
// round puffs, hard little blocks (chips, debris) and glowing sparks. Only
// drawing: nothing here touches the game, so it can use Math.random.
// Each spawns only where the player can see (the "Small effects" setting).
const FX_MAX = 700;
const Fx = {
  list: [], meshes: null,
  build(scene) {
    const mk = (geo, mat) => {
      const m = new THREE.InstancedMesh(geo, mat, FX_MAX);
      m.frustumCulled = false; m.count = 0;
      m.setColorAt(0, _c.set(1, 1, 1)); // (makes the colour buffer before the first draw)
      scene.add(m);
      return m;
    };
    this.meshes = [
      mk(new THREE.IcosahedronGeometry(1, 1), withFow(new THREE.MeshLambertMaterial())), // (opaque, like the powder smoke)
      mk(new THREE.BoxGeometry(1, 1, 1), withFow(new THREE.MeshLambertMaterial())),
      mk(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })),
    ];
    this.meshes[1].castShadow = true;
  },
  clear() { this.list.length = 0; if (this.meshes) for (const m of this.meshes) m.count = 0; },
  // kind: 0 soft, 1 hard, 2 glow. Sizes s0 -> s1 over the life (ms).
  add(kind, x, y, z, vx, vy, vz, life, s0, s1, color, g = 0, drag = 0) {
    if (this.list.length >= FX_MAX) this.list.shift();
    this.list.push({ kind, x, y, z, vx, vy, vz, life, s0, s1, r: color[0], gr: color[1], b: color[2], g, drag, t: 0,
      rx: Math.random() * 6, ry: Math.random() * 6, spin: (Math.random() - 0.5) * 14, floor: kind === 2 ? -99 : groundAt(x, z) });
  },
  update(dt) {
    if (!this.meshes) return;
    const n = [0, 0, 0];
    let keep = 0;
    for (const p of this.list) {
      p.t += dt * 1000;
      if (p.t >= p.life) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      // Hard bits land and lie there; the others just stop at the ground.
      if (p.y < p.floor) { p.y = p.floor; p.vy = p.kind === 1 ? -p.vy * 0.25 : 0; p.vx *= 0.5; p.vz *= 0.5; p.spin *= 0.5; }
      p.rx += p.spin * dt; p.ry += p.spin * 0.7 * dt;
      const f = p.t / p.life, m = this.meshes[p.kind];
      // Soft things swell then fade by shrinking; hard ones keep their size till the end.
      const size = p.s0 + (p.s1 - p.s0) * f;
      const s = p.kind === 1 ? size * Math.min(1, (1 - f) * 4) : size * Math.sin(Math.min(1, f * 3 + 0.15) * Math.PI / 2) * (1 - f * f);
      _p.set(p.x, p.y, p.z);
      _q.setFromEuler(_fxEul.set(p.rx, p.ry, 0));
      _s.set(s, p.kind === 1 ? s * 0.45 : s, s);
      _m4.compose(_p, _q, _s);
      m.setMatrixAt(n[p.kind], _m4);
      m.setColorAt(n[p.kind]++, _c.setRGB(p.r, p.gr, p.b));
      this.list[keep++] = p;
    }
    this.list.length = keep;
    this.meshes.forEach((m, i) => { m.count = n[i]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  },
};
const _fxEul = new THREE.Euler();
const fxRnd = (a, b) => a + Math.random() * (b - a);
const FX_DUST = [0.62, 0.53, 0.40], FX_DUST2 = [0.40, 0.35, 0.29], FX_WOOD = [0.62, 0.45, 0.25], FX_FOAM = [0.92, 0.96, 0.97], FX_SPARK = [3.0, 2.1, 0.8];
// Is (x, y) in sight of the player now? Effects only happen where you can see.
function fxSeen(x, y) {
  if (!GFX.effects || !R3.fowData) return false;
  const tx = Math.floor(x), ty = Math.floor(y);
  return tx >= 0 && ty >= 0 && tx < MW && ty < MH && R3.fowData[(ty * MW + tx) * 4] === 255;
}
function fxOnWater(x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return true;
  const t = u8(W.terrain_ptr(), MW * MH)[ty * MW + tx];
  return t === 1 || t === 5;
}
// A ring of dust rolling outward along the ground: a building finished, a unit appearing.
function fxDustRing(x, y, r, n, col = FX_DUST) {
  if (!fxSeen(x, y)) return;
  const h = groundAt(x, y);
  for (let k = 0; k < n; k++) {
    const a = (k + fxRnd(-0.4, 0.4)) / n * 6.283, d = r * fxRnd(0.7, 1.1), sp = fxRnd(1, 2.4) * (0.6 + r * 0.25);
    Fx.add(0, x + Math.cos(a) * d, h + fxRnd(0, 0.15), y + Math.sin(a) * d, Math.cos(a) * sp, fxRnd(0.1, 0.6), Math.sin(a) * sp, fxRnd(600, 1200), fxRnd(0.1, 0.2), fxRnd(0.25, 0.6) * (0.7 + r * 0.15), col, 0, 3);
  }
}
// A building comes down: a big cloud and tumbling pieces.
function fxCollapse(x, y, size) {
  if (!fxSeen(x, y)) return;
  const h = groundAt(x, y), r = size * 0.45;
  for (let k = 0; k < 14; k++) {
    const a = fxRnd(0, 6.283), d = fxRnd(0, r);
    Fx.add(0, x + Math.cos(a) * d, h + fxRnd(0.2, 1.2), y + Math.sin(a) * d, Math.cos(a) * fxRnd(0.3, 1.2), fxRnd(0.3, 1.0), Math.sin(a) * fxRnd(0.3, 1.2), fxRnd(1300, 2200), fxRnd(0.25, 0.4), fxRnd(0.7, 1.1), Math.random() < 0.5 ? FX_DUST : FX_DUST2, -0.15, 1.2);
  }
  for (let k = 0; k < 12; k++) {
    const a = fxRnd(0, 6.283), sp = fxRnd(1, 3);
    Fx.add(1, x + Math.cos(a) * r * 0.5, h + fxRnd(0.4, 1.2), y + Math.sin(a) * r * 0.5, Math.cos(a) * sp, fxRnd(2, 4.5), Math.sin(a) * sp, fxRnd(1600, 2400), fxRnd(0.08, 0.16), fxRnd(0.08, 0.16), Math.random() < 0.5 ? FX_WOOD : [0.55, 0.53, 0.5], 9.8, 0.4);
  }
  fxDustRing(x, y, r, 12, FX_DUST2);
}
// A hammer blow on a building site: a few wood chips fly off its edge.
function fxHammer(x, y, size = 2) {
  if (!fxSeen(x, y)) return;
  const a = fxRnd(0, 6.283), r = size * 0.4, cx = x + Math.cos(a) * r, cy = y + Math.sin(a) * r, h = groundAt(cx, cy) + fxRnd(0.2, 0.6);
  for (let k = 0; k < 3; k++) Fx.add(1, cx, h, cy, Math.cos(a) * fxRnd(0.4, 1.4) + fxRnd(-0.5, 0.5), fxRnd(1.5, 3), Math.sin(a) * fxRnd(0.4, 1.4) + fxRnd(-0.5, 0.5), fxRnd(700, 1100), 0.06, 0.05, FX_WOOD, 9.8, 0.5);
  Fx.add(0, cx, h - 0.1, cy, 0, 0.3, 0, 600, 0.08, 0.2, FX_DUST, 0, 2);
}
// Something was hit: a splash on water, chips off a building, sparks and a little dust on the ground.
function fxHit(x, y, building, metal) {
  if (!fxSeen(x, y)) return;
  if (fxOnWater(x, y)) {
    for (let k = 0; k < 6; k++) Fx.add(0, x + fxRnd(-0.15, 0.15), WATER_Y + 0.05, y + fxRnd(-0.15, 0.15), fxRnd(-0.6, 0.6), fxRnd(1.8, 3.2), fxRnd(-0.6, 0.6), fxRnd(500, 800), 0.07, 0.04, FX_FOAM, 9.8, 0.3);
    return;
  }
  const h = groundAt(x, y) + (building ? fxRnd(0.4, 1.2) : 0.35);
  if (building) for (let k = 0; k < 2; k++) Fx.add(1, x + fxRnd(-0.3, 0.3), h, y + fxRnd(-0.3, 0.3), fxRnd(-1, 1), fxRnd(1, 2.4), fxRnd(-1, 1), fxRnd(600, 900), 0.06, 0.05, FX_WOOD, 9.8, 0.5);
  if (metal) for (let k = 0; k < 3; k++) Fx.add(2, x + fxRnd(-0.1, 0.1), h + 0.1, y + fxRnd(-0.1, 0.1), fxRnd(-2, 2), fxRnd(0.8, 2.5), fxRnd(-2, 2), fxRnd(150, 280), 0.035, 0.015, FX_SPARK, 6, 1);
  Fx.add(0, x, groundAt(x, y) + 0.1, y, fxRnd(-0.2, 0.2), 0.3, fxRnd(-0.2, 0.2), 500, 0.06, 0.18, FX_DUST, 0, 2);
}
// A shell, cannonball or rocket lands: a flash, a burst of dark smoke and
// earth (or a tall splash on water), clods flying out. Rockets are biggest.
function fxBlast(x, y, kind) {
  if (!fxSeen(x, y)) return;
  const big = kind === K.RocketArtillery ? 1.4 : kind === K.Trebuchet ? 0.8 : 1;
  const h = groundAt(x, y);
  if (fxOnWater(x, y)) {
    for (let k = 0; k < 16; k++) Fx.add(0, x + fxRnd(-0.25, 0.25) * big, WATER_Y + 0.05, y + fxRnd(-0.25, 0.25) * big, fxRnd(-0.8, 0.8), fxRnd(3, 5.5) * big, fxRnd(-0.8, 0.8), fxRnd(700, 1100), 0.1 * big, 0.06, FX_FOAM, 9.8, 0.3);
    fxDustRing(x, y, 0.3 * big, 10, FX_FOAM);
    return;
  }
  if (kind !== K.Trebuchet) for (let k = 0; k < 5; k++) Fx.add(2, x + fxRnd(-0.2, 0.2), h + fxRnd(0.1, 0.4), y + fxRnd(-0.2, 0.2), fxRnd(-1, 1), fxRnd(0.5, 1.5), fxRnd(-1, 1), fxRnd(120, 220), 0.35 * big, 0.6 * big, FX_SPARK, 0, 4);
  for (let k = 0; k < 9; k++) {
    const a = fxRnd(0, 6.283), sp = fxRnd(0.3, 1.1) * big;
    Fx.add(0, x + Math.cos(a) * 0.15, h + fxRnd(0.1, 0.4), y + Math.sin(a) * 0.15, Math.cos(a) * sp, fxRnd(1, 2.2) * big, Math.sin(a) * sp, fxRnd(900, 1500), 0.12 * big, fxRnd(0.3, 0.5) * big, k < 5 ? FX_DUST2 : [0.3, 0.29, 0.28], -0.3, 2.2);
  }
  for (let k = 0; k < 8; k++) {
    const a = fxRnd(0, 6.283), sp = fxRnd(1.5, 3.5) * big;
    Fx.add(1, x, h + 0.15, y, Math.cos(a) * sp, fxRnd(2.5, 5) * big, Math.sin(a) * sp, fxRnd(900, 1400), fxRnd(0.06, 0.12), fxRnd(0.06, 0.12), k % 2 ? FX_DUST2 : [0.35, 0.3, 0.22], 9.8, 0.3);
  }
  fxDustRing(x, y, 0.35 * big, 10);
}

// Kinds that throw up dust as they go, and how much (0..1).
function fxDustOf(kind) {
  if (isMounted(kind)) return 1;
  if (kind === K.Tank || kind === K.Cannon || kind === K.FieldGun || kind === K.RocketArtillery || kind === K.Trebuchet) return 0.8;
  return 0.12;
}
// Called for each moving unit with how far it went this frame.
function fxTrail(o, kind, dist) {
  o.fxGone = (o.fxGone || 0) + dist;
  if (isAir(kind)) return;
  const naval = isNaval(kind), step = naval ? 0.35 : 0.5;
  if (o.fxGone < step) return;
  o.fxGone = 0;
  if (!fxSeen(o.x, o.y)) return;
  const back = o.face, bx = -Math.cos(-back), by = -Math.sin(-back); // behind it
  if (naval) {
    // A wake: foam to both sides of the stern, spreading out.
    for (const side of [-1, 1]) {
      const px = o.x + bx * 0.35 - by * side * 0.12, py = o.y + by * 0.35 + bx * side * 0.12;
      Fx.add(0, px, WATER_Y + 0.03, py, -by * side * 0.4, 0, bx * side * 0.4, 1400, 0.1, 0.22, FX_FOAM, 0, 1.5);
    }
    return;
  }
  if (Math.random() > fxDustOf(kind) || fxOnWater(o.x, o.y)) return;
  Fx.add(0, o.x + bx * 0.2 + fxRnd(-0.1, 0.1), groundAt(o.x, o.y) + 0.08, o.y + by * 0.2 + fxRnd(-0.1, 0.1), bx * 0.3, fxRnd(0.2, 0.5), by * 0.3, fxRnd(600, 900), 0.06, fxRnd(0.2, 0.3), FX_DUST, 0, 2);
}
// A new unit pops into the world: grows from nothing, overshoots a little, settles.
const POP_MS = 380;
function popScale(p) { const c = 2.2; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; }

// Rebuild the resource instances when anything about them changed.
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _v3 = new THREE.Vector3(), _c = new THREE.Color();
// Which way the water is from a building's middle: the angle that turns
// its +z side to face it (the mean direction of the water tiles round it).
function waterSide(x, y, s) {
  const ter = u8(W.terrain_ptr(), MW * MH), r = s / 2 + 2;
  let dx = 0, dz = 0;
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
    if (tx < 0 || ty < 0 || tx >= MW || ty >= MH || (ter[ty * MW + tx] !== 1 && ter[ty * MW + tx] !== 5)) continue;
    const vx = tx + 0.5 - x, vz = ty + 0.5 - y, d = Math.hypot(vx, vz) || 1;
    dx += vx / d; dz += vz / d;
  }
  // Square to the shore: the nearest of the four sides.
  const a = Math.atan2(dx, dz);
  return Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
}

const resetCount = m => { m.count = 0; };
const makeRoom = (n, key) => resMesh(Math.floor(key / 65536), key % 65536, n);
function updateResources() {
  if (!R3.res) return;
  // A number that changes when resources do (was a string: garbage every frame).
  let key = resCount;
  // (Deposits never run out, so which ones are known is all that changes:
  // more come into view as the map is explored.)
  for (let i = 0; i < resCount; i++) key = (key * 31 + resBuf[i * 5 + 2] * 7 + resBuf[i * 5] * 3 + resBuf[i * 5 + 1]) | 0;
  if (key === R3.resKey) return;
  R3.resKey = key;
  // Each mesh keeps its instances' tiles (x, y, x, y, ...) for picking,
  // in one array reused from change to change.
  // (Written over in place, then cut to length: emptying an array lets
  // the browser drop its storage, to be made again straight after.)
  // First which kind goes where, and how many of each in each block.
  // (Numbers, in arrays kept from call to call: this runs several times a
  // second while exploring, and strings here were the page's biggest garbage.)
  const bw = Math.ceil(MW / BLOCK);
  if (!R3.resPlace || R3.resPlace.length < resCount) R3.resPlace = new Int32Array(resCount * 2 + 64);
  const place = R3.resPlace, need = R3.resNeed ??= new Map();
  need.clear();
  R3.res.forEach(resetCount);
  for (let i = 0; i < resCount; i++) {
    const tx = resBuf[i * 5], ty = resBuf[i * 5 + 1];
    const key = resKindOf(resBuf[i * 5 + 2], tx, ty) * 65536 + Math.floor(ty / BLOCK) * bw + Math.floor(tx / BLOCK);
    place[i] = key;
    need.set(key, (need.get(key) || 0) + 1);
  }
  need.forEach(makeRoom);
  for (let i = 0; i < resCount; i++) {
    const tx = resBuf[i * 5], ty = resBuf[i * 5 + 1], kind = resBuf[i * 5 + 2], frac = resBuf[i * 5 + 3] / resBuf[i * 5 + 4];
    const h = hash2(tx, ty), h2 = hash2(ty * 3 + 1, tx * 7);
    // Deposit kinds (defs::Dep): 0 fertile land, 1 forest, 2 stone, 3 horses, 4 game,
    // 6 iron ore, 7 clay, 8 sheep hills, 9 saltpeter, 10 coal, 11 oil, 12 bauxite, 13 uranium,
    // 14 fish shoals (out on the water).
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
    else if (kind === 14) { mesh = "fish"; scale = 0.9 + 0.3 * h2; }
    else { mesh = "stone"; scale = 0.8 + 0.3 * frac * h2; }
    const m = R3.res.get(place[i]);
    if (!m) continue;
    const x = tx + 0.5 + (h - 0.5) * 0.25, y = ty + 0.5 + (h2 - 0.5) * 0.25;
    // Turned round the vertical by h and scaled, written straight into the
    // instance arrays (passing numbers to three.js's setters boxes each).
    const c = Math.cos(h * 6.28) * scale, sn = Math.sin(h * 6.28) * scale, a = m.instanceMatrix.array, o = m.count * 16;
    a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = scale; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = groundAt(x, y) - 0.02; a[o + 14] = y; a[o + 15] = 1;
    const v = 0.85 + h2 * 0.3;
    if (!m.instanceColor) m.setColorAt(m.count, _c.setRGB(v, v, v)); // (makes the colour array, once)
    const ca = m.instanceColor.array, co = m.count * 3;
    ca[co] = v; ca[co + 1] = v; ca[co + 2] = v;
    m.userData.res[m.count * 2] = tx; m.userData.res[m.count * 2 + 1] = ty;
    m.count++;
  }
  for (const m of R3.res.values()) {
    m.visible = m.count > 0;
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
  const a = R3.arrows, st = R3.stones, ms = R3.missiles, rk = R3.rockets, tr = R3.tracers, S = PROJ_STRIDE;
  let na = 0, ns = 0, nm = 0, nr = 0, nt = 0;
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
    const stone = shooter === K.Trebuchet || shooter === K.Cannon || shooter === K.FieldGun || shooter === K.Tank || shooter === K.Galleon || shooter === K.Ironclad || shooter === K.Destroyer;
    // A torpedo runs along the water, drawn like a rocket without the smoke.
    const torpedo = shooter === K.Submarine;
    const rocket = shooter === K.RocketArtillery || torpedo;
    const bullet = shooter === K.Musketeer || shooter === K.Dragoon || shooter === K.Rifleman || shooter === K.MachineGunner || shooter === K.Infantry || shooter === K.Fighter || shooter === K.Jet;
    if (bullet) {
      // A tracer: a short bright streak, straight from the gun to the target.
      if (nt >= 128) continue;
      const air = isAir(shooter);
      const ox = sx + dx * 0.3, oy = sy + dy * 0.3;
      const flown = Math.hypot(ix - ox, iy - oy), total = Math.max(0.3, flown + Math.hypot(tx - ix, ty - iy));
      const t = Math.min(1, flown / total);
      const h0 = groundAt(ox, oy) + (air ? AIR_ALT : shooter === K.Dragoon ? 0.72 : 0.5), h1 = groundAt(tx, ty) + (atBuilding ? 0.8 : 0.45);
      _p.set(ix, h0 + (h1 - h0) * t, iy);
      _q.setFromEuler(_e.set(0, -Math.atan2(dy, dx), Math.atan2(h1 - h0, total), "YZX"));
      _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      tr.setMatrixAt(nt++, _m4);
      continue;
    }
    const missile = shooter === K.AirDefense;
    const fromH = torpedo ? 0.02 : missile ? 1.1 : rocket ? 0.85 : shooter === K.Tower ? 2.5 : shooter === K.Capitol ? 1.9 : shooter === K.Trebuchet ? 1.2 : shooter === K.Cannon || shooter === K.FieldGun ? 0.45 : shooter === K.Tank ? 0.6 : 0.62;
    const ahead = isBld(shooter) ? 0 : 0.3;
    const ox = sx + dx * ahead, oy = sy + dy * ahead;
    const toH = torpedo ? 0.03 : missile ? AIR_ALT + 0.3 : atBuilding ? 0.9 : 0.55;
    // How far along: distance flown over that plus the distance still to go.
    const flown = Math.hypot(ix - ox, iy - oy);
    const total = Math.max(0.3, flown + Math.hypot(tx - ix, ty - iy));
    const t = Math.min(1, flown / total);
    const arc = torpedo ? 0 : missile ? total * 0.25 : rocket ? total * 0.22 : shooter === K.Trebuchet ? total * 0.3 : shooter === K.Cannon || shooter === K.Tank ? total * 0.05 : shooter === K.FieldGun ? total * 0.15 : Math.min(1.2, total * 0.12);
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
      if (!torpedo && GFX.smoke && Math.random() < 0.7 && R3.puffs.length < 150) R3.puffs.push({ x: _p.x - dx * 0.35, y: _p.z - dy * 0.35, h: _p.y, t0: performance.now(), big: false, seed: Math.random() * 6.28 });
    } else if (stone) { if (ns < 64) st.setMatrixAt(ns++, _m4); }
    else a.setMatrixAt(na++, _m4);
  }
  a.count = na; st.count = ns; ms.count = nm; rk.count = nr; tr.count = nt;
  tr.instanceMatrix.needsUpdate = true;
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
    const s = groundSize(placing);
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

// --- Graphics settings -----------------------------------------------------------
// Settings only change how things are drawn, never the simulation, so players
// in one multiplayer game can each pick their own. Saved per browser.
// Two presets, Fast and Fancy; any setting can then be changed on its own.
// A changed setting stays changed when switching preset, and shows a button
// to put it back to the preset's value.
const gfxPct = v => Math.round(v * 100) + "%";
const GFX_SETTINGS = [
  { key: "pixelRatio", label: "Sharpness", type: "choice", options: [[1, "Normal"], [1.5, "Sharp"], [2, "Sharpest"]], fast: 1, fancy: 2,
    hint: "How many pixels are drawn on high-resolution screens. The biggest cost on a weak graphics card." },
  { key: "shadows", label: "Shadows", type: "choice", options: [[0, "Off"], [-1, "Blobs"], [1024, "Low"], [2048, "High"], [4096, "Highest"]], fast: -1, fancy: 2048,
    hint: "Shadows from the sun; higher is sharper. Blobs: a soft dark patch under each unit and building, almost free." },
  { key: "ao", label: "Contact shadows", type: "toggle", fast: false, fancy: false,
    hint: "Darkens creases and where things meet the ground. Needs a strong graphics card." },
  { key: "grading", label: "Colour grading", type: "toggle", fast: true, fancy: true,
    hint: "Warm light, cool shade, a touch more colour and darker screen edges. Almost free." },
  { key: "bloom", label: "Glow", type: "slider", min: 0, max: 2, step: 0.05, fast: 0, fancy: 1, fmt: gfxPct,
    hint: "Bright things glow: fire, sunlit roofs, glints on the water." },
  { key: "tilt", label: "Tilt-shift", type: "slider", min: 0, max: 2, step: 0.05, fast: 0, fancy: 0, fmt: gfxPct,
    hint: "Blurs what's nearer and farther than where you look, like a model town. Strongest zoomed in; gone zoomed out." },
  { key: "grass", label: "Grass and flowers", type: "slider", min: 0, max: 1, step: 0.05, fast: 0.75, fancy: 0.75, fmt: gfxPct,
    hint: "How much grass, flowers and pebbles cover the ground." },
  { key: "sway", label: "Wind", type: "toggle", fast: false, fancy: true, hint: "Trees, bushes and grass sway." },
  { key: "smoke", label: "Chimney smoke", type: "toggle", fast: false, fancy: true, hint: "Smoke from chimneys, campfires and burning buildings." },
  { key: "models", label: "Models", type: "choice", options: [["simple", "Simple"], ["detailed", "Detailed"]], fast: "detailed", fancy: "detailed",
    hint: "Simple: the older models built in code. Detailed: the ones made in Blender." },
  { key: "effects", label: "Small effects", type: "toggle", fast: true, fancy: true,
    hint: "Dust, wood chips, splashes, sparks, boat wakes, and new units popping in." },
];
const GFX_PRESETS = { fast: "Fast", fancy: "Fancy" };
const gfxDef = key => GFX_SETTINGS.find(s => s.key === key);

let gfxPreset = "fancy", gfxOver = {};
(() => {
  try {
    const v = JSON.parse(localStorage.getItem("vibecraftGfx") || "null");
    if (v && GFX_PRESETS[v.preset]) {
      gfxPreset = v.preset;
      for (const [k, x] of Object.entries(v.over || {})) if (gfxDef(k) && typeof x === typeof gfxDef(k).fast) gfxOver[k] = x;
      return;
    }
    // The old four levels: Low is Fast; the rest are Fancy, changed to match.
    const old = localStorage.getItem("vibecraftGraphics");
    if (old === "low") { gfxPreset = "fast"; return; }
    if (old === "medium") { gfxOver = { pixelRatio: 1.5, shadows: 1024, bloom: 0, grass: 0.5 }; return; }
    if (old === "ultra") { gfxOver = { shadows: 4096, ao: true, grass: 1 }; return; }
    if (old === "high") return;
  } catch (e) {}
  // Phones and tablets start on Fast: small graphics cards and very dense screens.
  if (matchMedia("(pointer: coarse)").matches) gfxPreset = "fast";
})();

let GFX = {}, gfxName = "";
function computeGfx() {
  for (const s of GFX_SETTINGS) GFX[s.key] = s.key in gfxOver ? gfxOver[s.key] : s[gfxPreset];
  // The finishing pass is needed for any of these (see renderScene).
  GFX.post = GFX.bloom > 0 || GFX.ao || GFX.tilt > 0;
  // (For the trace.)
  gfxName = gfxPreset + (Object.keys(gfxOver).length ? " " + JSON.stringify(gfxOver) : "");
}
computeGfx();

function saveGfx() {
  try { localStorage.setItem("vibecraftGfx", JSON.stringify({ preset: gfxPreset, over: gfxOver })); } catch (e) {}
}
function setGfxPreset(name) {
  if (!GFX_PRESETS[name]) return;
  gfxPreset = name;
  // A changed setting stays; one that now matches the preset is no longer a change.
  for (const k of Object.keys(gfxOver)) if (gfxOver[k] === gfxDef(k)[name]) delete gfxOver[k];
  gfxChanged();
}
function setGfx(key, value) {
  if (value === gfxDef(key)[gfxPreset]) delete gfxOver[key]; else gfxOver[key] = value;
  gfxChanged();
}
function gfxChanged() {
  computeGfx(); saveGfx(); applyGraphics(); refreshGfxControls();
}

function applyGraphics() {
  const r = R3.renderer; if (!r) return;
  swayUniform.value = GFX.sway ? 1 : 0;
  // Shadows: turning them on or off, or a new map size, means rebuilding the
  // shaders; so does a new tone mapping (colour grading on or off).
  const sun = R3.sun, on = GFX.shadows > 0;
  const tm = GFX.grading ? THREE.CustomToneMapping : THREE.ACESFilmicToneMapping;
  document.getElementById("vignette").hidden = !GFX.grading;
  if (r.toneMapping !== tm) {
    r.toneMapping = tm;
    if (Post.mat) Post.mat.needsUpdate = true;
    R3.scene.traverse(o => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
  }
  if (r.shadowMap.enabled !== on || (on && sun.shadow.mapSize.x !== GFX.shadows)) {
    r.shadowMap.enabled = on;
    sun.castShadow = on;
    if (on) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(GFX.shadows, GFX.shadows);
      r.shadowMap.type = GFX.shadows >= 2048 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    }
    for (const m of [...entMats(), treeMat, stoneMat, goldMat, ghostMat]) m.needsUpdate = true;
    R3.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  }
  applyGrass();
  applyModels();
  if (R3.smoke) R3.smoke.visible = GFX.smoke;
  if (!GFX.effects) Fx.clear();
  if (view._w) resizeRenderer();
}

function applyGrass() {
  // (Each block draws that share of its own spots, which are shuffled.)
  const share = (g, f) => { if (g) for (const m of g.children) { m.count = Math.round(m.userData.spots.length * f); m.visible = m.count > 0; } };
  const g = GFX.grass * 0.42; // (all of it was too much: 42% of the spots at most)
  share(R3.tufts, g);
  share(R3.flowers, g);
  share(R3.pebbles, Math.min(1, g * 2.5));
}

// The controls appear on the start screen and in the in-game menu: the two
// presets, "Hold to look" (hides the menu while held, to see the game behind
// it), and every setting on its own under "More". While a setting is being
// changed, the rest of the menu fades so the game shows through.
const gfxPanels = [];
function addGraphicsControls() {
  const make = () => {
    const box = document.createElement("div");
    box.className = "gfx";
    const n = gfxPanels.length;
    box.innerHTML = `
      <div class="row gfx-head">
        <h2 id="gfxLabel${n}">Graphics</h2>
        <div class="seg gfx-seg" aria-labelledby="gfxLabel${n}"></div>
        <button class="ghost gfx-show" title="Hide the menu while held, to see the game behind it">Hold to look</button>
      </div>
      <div class="gfx-list" id="gfxList${n}"></div>`;
    const seg = box.querySelector(".gfx-seg");
    for (const [k, label] of Object.entries(GFX_PRESETS)) {
      const b = document.createElement("button");
      b.dataset.q = k; b.textContent = label;
      b.title = k === "fast" ? "No shadows, glow or blur: for slow computers and phones" : "Everything but contact shadows and tilt-shift";
      b.onclick = () => setGfxPreset(k);
      seg.append(b);
    }
    const list = box.querySelector(".gfx-list");
    for (const s of GFX_SETTINGS) {
      const item = document.createElement("div");
      item.className = "gfx-item"; item.dataset.key = s.key; item.title = s.hint || "";
      const id = `gfx${n}-${s.key}`;
      item.innerHTML = `<label for="${id}">${s.label}</label><div class="gfx-ctl"></div><span class="gfx-val"></span>`
        + `<button class="gfx-reset" aria-label="Back to the preset's ${s.label.toLowerCase()}">↺</button>`;
      const ctl = item.querySelector(".gfx-ctl");
      if (s.type === "slider") {
        const inp = document.createElement("input");
        Object.assign(inp, { type: "range", id, min: s.min, max: s.max, step: s.step });
        inp.oninput = () => setGfx(s.key, +inp.value);
        ctl.append(inp);
      } else {
        // A drop-down, the more demanding choices further down.
        const opts = s.type === "toggle" ? [[false, "Off"], [true, "On"]] : s.options;
        const sel = document.createElement("select"); sel.id = id;
        for (const [v, label] of opts) {
          const o = document.createElement("option");
          o.textContent = label; o.value = JSON.stringify(v);
          sel.append(o);
        }
        sel.onchange = () => { setGfx(s.key, JSON.parse(sel.value)); sel.blur(); };
        ctl.append(sel);
      }
      item.querySelector(".gfx-reset").onclick = () => setGfx(s.key, s[gfxPreset]);
      // Fade the menu while the pointer is held on this setting (a slider).
      if (s.type === "slider") item.querySelector(".gfx-ctl").addEventListener("pointerdown", () => {
        const ov = box.closest(".overlay"); if (!ov) return;
        item.classList.add("active"); ov.classList.add("gfx-fade");
        const up = () => { item.classList.remove("active"); ov.classList.remove("gfx-fade"); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); };
        addEventListener("pointerup", up); addEventListener("pointercancel", up);
      });
      list.append(item);
    }
    // Hold to look: the whole menu goes while the button is held.
    const show = box.querySelector(".gfx-show");
    show.addEventListener("pointerdown", e => {
      const ov = box.closest(".overlay"); if (!ov) return;
      e.preventDefault();
      show.setPointerCapture(e.pointerId);
      ov.classList.add("gfx-peek");
      const up = () => { ov.classList.remove("gfx-peek"); show.removeEventListener("pointerup", up); show.removeEventListener("pointercancel", up); show.removeEventListener("lostpointercapture", up); };
      show.addEventListener("pointerup", up); show.addEventListener("pointercancel", up); show.addEventListener("lostpointercapture", up);
    });
    show.addEventListener("contextmenu", e => e.preventDefault()); // (a long press on a phone)
    gfxPanels.push(box);
    return box;
  };
  // In the Settings tab of the start screen and of the menu, before the volume.
  for (const id of ["startSettings", "menuSettings"]) { const at = document.getElementById(id); if (at) at.prepend(make()); }
  refreshGfxControls();
}

function refreshGfxControls() {
  const presetName = GFX_PRESETS[gfxPreset];
  for (const box of gfxPanels) {
    for (const b of box.querySelector(".gfx-seg").children) b.setAttribute("aria-pressed", b.dataset.q === gfxPreset);
    for (const item of box.querySelectorAll(".gfx-item")) {
      const s = gfxDef(item.dataset.key), v = GFX[s.key], changed = s.key in gfxOver;
      if (s.type === "slider") {
        const inp = item.querySelector("input");
        if (+inp.value !== v) inp.value = v;
        item.querySelector(".gfx-val").textContent = s.fmt(v);
      } else {
        const sel = item.querySelector("select");
        if (sel.value !== JSON.stringify(v)) sel.value = JSON.stringify(v);
      }
      item.classList.toggle("changed", changed);
      const reset = item.querySelector(".gfx-reset");
      reset.classList.toggle("off", !changed); // (kept in place, invisible: hiding it would change the row's height)
      reset.tabIndex = changed ? 0 : -1;
      const d = s[gfxPreset];
      reset.title = `Back to ${presetName}: ${s.type === "slider" ? s.fmt(d) : s.type === "toggle" ? (d ? "on" : "off") : s.options.find(o => o[0] === d)[1].toLowerCase()}`;
    }
  }
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
  // Chimneys, the smoke hole of a hut someone lives in, the Capitol's torch.
  const CHIMNEYS = { [K.HuntingLodge]: [0.3, glbModels ? 1.2 : 1.1, -0.2], [K.Hut]: [0, 1.35, 0], [K.Capitol]: TORCH,
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

// --- After the scene is drawn: grading, bloom, ambient occlusion, tilt-shift --------
// With any of these settings on, the scene is drawn into an off-screen image
// first, and one last full-screen pass finishes it:
// - ambient occlusion ("contact shadows"): creases and contact points
//   darken, worked out from the depth image;
// - tilt-shift: ground nearer or farther than the point the camera looks at
//   is mixed with blurred copies of the image (a half down to a sixteenth
//   of the size), more the farther it is, so the land looks like a model;
// - bloom ("glow"): bright things (sunlit roofs, glints on water, the forge,
//   gold veins) glow softly;
// That pass also applies the tone mapping (and with it the colour grading),
// which three.js skips when drawing into an image. With all of them off the
// scene goes straight to the screen.
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
      tBlur1: { value: null }, tBlur2: { value: null }, tBlur3: { value: null }, tBlur4: { value: null }, uTilt: { value: 0 }, uFocus: { value: 24 }, uPlaneN: { value: new THREE.Vector3() }, uPlaneD: { value: 0 },
    },
    defines: { USE_AO: 0, USE_TILT: 0 },
    depthTest: false, depthWrite: false,
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
      uniform sampler2D tColor; uniform sampler2D tDepth; uniform sampler2D tBloom;
      uniform mat4 uProjInv; uniform mat4 uProj; uniform vec2 uRes; uniform float uRadius; uniform float uBloom;
      uniform sampler2D tBlur1; uniform sampler2D tBlur2; uniform sampler2D tBlur3; uniform sampler2D tBlur4; uniform float uTilt; uniform float uFocus; uniform vec3 uPlaneN; uniform float uPlaneD;
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
        #if USE_TILT
        {
          // How far the ground seen through this pixel is from the focus, as
          // a share of the focus distance: the plane of the ground, not what
          // the pixel shows, so things standing up (a tower, a plane in the
          // air) are as sharp as the ground under them. The sky is far away.
          vec4 fp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec3 dir = normalize(fp.xyz / fp.w);
          float dn = dot(dir, uPlaneN);
          float dist = dn < -1e-4 ? -(dir * (uPlaneD / dn)).z : uFocus * 4.0;
          float off = smoothstep(0.03, 0.3, abs(dist - uFocus) / uFocus);
          float b = off * uTilt * 4.0;
          col = mix(col, texture2D(tBlur1, vUv).rgb, clamp(b, 0.0, 1.0));
          col = mix(col, texture2D(tBlur2, vUv).rgb, clamp(b - 1.0, 0.0, 1.0));
          col = mix(col, texture2D(tBlur3, vUv).rgb, clamp(b - 2.0, 0.0, 1.0));
          col = mix(col, texture2D(tBlur4, vUv).rgb, clamp(b - 3.0, 0.0, 1.0));
          // A model looks brighter and more colourful than the real thing.
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = max(mix(vec3(l), col, 1.0 + 0.15 * min(uTilt, 1.0)), 0.0);
        }
        #endif
        col += texture2D(tBloom, vUv).rgb * uBloom;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
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
    }`, { uThreshold: { value: 0.8 } }); // (1.05 was too high: little but the sun on water glowed)
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

// Tilt-shift's blurred copies: the image shrunk to a half, a quarter, an
// eighth and a sixteenth, each step a soft five-tap filter (bloom's), so the
// smallest is the blurriest. The finishing pass mixes them in by distance
// from the focus.
function renderTiltBlur(r, sz) {
  if (!Post.bloom) buildBloom();
  if (!Post.blur) Post.blur = [0, 1, 2, 3].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  Post.blur.forEach((t, i) => { const w = Math.max(1, sz.x >> (i + 1)), h = Math.max(1, sz.y >> (i + 1)); if (t.width !== w || t.height !== h) t.setSize(w, h); });
  blit(r, Post.bloom.shrink, Post.rt, Post.blur[0]);
  blit(r, Post.bloom.shrink, Post.blur[0], Post.blur[1]);
  blit(r, Post.bloom.shrink, Post.blur[1], Post.blur[2]);
  blit(r, Post.bloom.shrink, Post.blur[2], Post.blur[3]);
  const u = Post.mat.uniforms;
  u.tBlur1.value = Post.blur[0].texture; u.tBlur2.value = Post.blur[1].texture; u.tBlur3.value = Post.blur[2].texture; u.tBlur4.value = Post.blur[3].texture;
}

const _black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
_black.needsUpdate = true;

function renderScene() {
  const r = R3.renderer;
  // (What the scene took, for the trace: read here, as icons drawn later
  // with the same renderer reset the counts.)
  const note = () => { R3.drawn = { calls: r.info.render.calls, triangles: r.info.render.triangles }; };
  if (!GFX.post) { r.render(R3.scene, R3.camera); note(); return; }
  if (!Post.rt) buildPost();
  const sz = r.getDrawingBufferSize(_v2);
  if (Post.rt.width !== sz.x || Post.rt.height !== sz.y) Post.rt.setSize(sz.x, sz.y);
  r.setRenderTarget(Post.rt);
  r.render(R3.scene, R3.camera);
  note();
  const u = Post.mat.uniforms;
  u.tBloom.value = GFX.bloom > 0 ? renderBloom(r, sz) : _black;
  u.uBloom.value = GFX.bloom * 0.6;
  // Tilt-shift fades out as the camera zooms out past the usual height
  // (cam.dist 24; it goes from 9 to 48): from high up, a blurred edge only
  // hides the overview. 100% blurs the edges fully at the usual height.
  const tilt = GFX.tilt * Math.max(0, Math.min(1, (48 - cam.dist) / 24)) * 0.5;
  if (tilt > 0) renderTiltBlur(r, sz);
  u.uTilt.value = tilt; u.uFocus.value = cam.dist;
  // The ground's plane, as the camera sees it (see placeCamera).
  const V = R3.camera.matrixWorldInverse;
  u.uPlaneN.value.set(0, 1, 0).transformDirection(V);
  u.uPlaneD.value = _v3.set(cam.x, Math.max(0, hAt(cam.x, cam.y)), cam.y).applyMatrix4(V).dot(u.uPlaneN.value);
  r.setRenderTarget(null);
  const ao = GFX.ao ? 1 : 0, tl = tilt > 0 ? 1 : 0;
  if (Post.mat.defines.USE_AO !== ao || Post.mat.defines.USE_TILT !== tl) { Post.mat.defines.USE_AO = ao; Post.mat.defines.USE_TILT = tl; Post.mat.needsUpdate = true; }
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
