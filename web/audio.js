// ===========================================================================
// Sound. Everything is synthesized with the Web Audio API: oscillators and
// filtered noise shaped by quick volume envelopes. No audio files to load.
const Sfx = (() => {
  let ac = null, master, sfxBus, uiBus, noiseBuf;
  let muted = false, volume = 0.8, voices = 0;
  const lastPlayed = {};
  try {
    muted = localStorage.getItem("vibecraftMuted") === "1";
    const v = parseFloat(localStorage.getItem("vibecraftVolume"));
    if (v >= 0 && v <= 1) volume = v;
  } catch (e) {}
  const level = () => muted ? 0 : volume;

  function init() {
    if (ac) { if (ac.state === "suspended") ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    master = ac.createGain(); master.gain.value = level();
    master.connect(comp); comp.connect(ac.destination);
    sfxBus = ac.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
    uiBus = ac.createGain(); uiBus.gain.value = 0.55; uiBus.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem("vibecraftMuted", m ? "1" : "0"); } catch (e) {}
    if (ac) master.gain.setTargetAtTime(level(), ac.currentTime, 0.05);
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem("vibecraftVolume", String(volume)); } catch (e) {}
    if (ac) master.gain.setTargetAtTime(level(), ac.currentTime, 0.05);
  }

  // Building blocks -------------------------------------------------------
  // A voice is a chain ending in a gain node with an attack/decay envelope,
  // routed through an optional stereo panner to a bus.
  function out(bus, vol, pan, t, attack, decay) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p); p.connect(bus);
    } else g.connect(bus);
    voices++;
    setTimeout(() => voices--, (attack + decay) * 1000 + 50);
    return g;
  }
  function tone(bus, type, f0, f1, vol, pan, t, attack, decay) {
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    o.connect(out(bus, vol, pan, t, attack, decay));
    o.start(t); o.stop(t + attack + decay + 0.02);
  }
  function noise(bus, filter, f0, f1, q, vol, pan, t, attack, decay) {
    const s = ac.createBufferSource(); s.buffer = noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ac.createBiquadFilter(); f.type = filter; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    s.connect(f); f.connect(out(bus, vol, pan, t, attack, decay));
    s.start(t, Math.random() * 0.5); s.stop(t + attack + decay + 0.02);
  }
  const jit = (x, amt = 0.08) => x * (1 + (Math.random() * 2 - 1) * amt);

  // Rate limiting: a big battle can produce dozens of hits per tick. Playing
  // them all is mud, so each sound has a minimum gap and there's a voice cap.
  function allow(name, gapMs) {
    if (!ac || muted || voices > 40) return false;
    const now = performance.now();
    if (lastPlayed[name] && now - lastPlayed[name] < gapMs) return false;
    lastPlayed[name] = now;
    return true;
  }

  // The sounds --------------------------------------------------------------
  const S = {
    chop(v, p) { const t = ac.currentTime;
      tone(sfxBus, "sine", jit(190), 90, v * 0.5, p, t, 0.002, 0.07);
      noise(sfxBus, "bandpass", jit(1500), 700, 2, v * 0.6, p, t, 0.001, 0.06); },
    mine(v, p, gold) { const t = ac.currentTime, f = jit(gold ? 2600 : 2100, 0.05);
      tone(sfxBus, "triangle", f, f * 0.98, v * 0.22, p, t, 0.001, 0.16);
      tone(sfxBus, "sine", f * 1.51, f * 1.5, v * 0.1, p, t, 0.001, 0.09);
      noise(sfxBus, "highpass", 3000, 3000, 0.7, v * 0.25, p, t, 0.001, 0.025); },
    forage(v, p) { const t = ac.currentTime;
      noise(sfxBus, "highpass", jit(3500), 5000, 0.8, v * 0.18, p, t, 0.02, 0.09); },
    till(v, p) { const t = ac.currentTime;
      noise(sfxBus, "lowpass", jit(900), 400, 1, v * 0.3, p, t, 0.005, 0.12); },
    hammer(v, p) { const t = ac.currentTime;
      tone(sfxBus, "square", jit(420), 260, v * 0.12, p, t, 0.001, 0.05);
      noise(sfxBus, "bandpass", jit(900), 900, 3, v * 0.5, p, t, 0.001, 0.05);
      tone(sfxBus, "sine", 120, 70, v * 0.35, p, t, 0.001, 0.08); },
    dropoff(v, p, r) { const t = ac.currentTime;
      if (r === 3) { for (let k = 0; k < 3; k++) tone(sfxBus, "triangle", jit(3000, 0.15), 2900, v * 0.08, p, t + k * 0.035, 0.001, 0.07); }
      else noise(sfxBus, "lowpass", 600, 300, 1, v * 0.3, p, t, 0.004, 0.1); },
    melee(v, p, kind) { const t = ac.currentTime, heavy = kind === 3;
      tone(sfxBus, "sawtooth", jit(heavy ? 700 : 950, 0.15), 500, v * 0.08, p, t, 0.001, 0.07);
      noise(sfxBus, "bandpass", jit(2600, 0.2), 1800, 1.5, v * 0.5, p, t, 0.001, heavy ? 0.12 : 0.07);
      tone(sfxBus, "sine", heavy ? 110 : 150, 60, v * 0.4, p, t, 0.001, 0.09); },
    bow(v, p, tower) { const t = ac.currentTime;
      tone(sfxBus, "triangle", jit(tower ? 160 : 230), 150, v * 0.18, p, t, 0.001, 0.12);
      noise(sfxBus, "bandpass", 3500, 900, 2.5, v * 0.25, p, t + 0.01, 0.02, 0.16); },
    arrowHit(v, p, bld) { const t = ac.currentTime;
      if (bld) noise(sfxBus, "lowpass", 500, 300, 1, v * 0.35, p, t, 0.001, 0.06);
      else noise(sfxBus, "bandpass", 1800, 1200, 2, v * 0.25, p, t, 0.001, 0.04); },
    death(v, p, horse) { const t = ac.currentTime;
      tone(sfxBus, "sawtooth", jit(horse ? 300 : 420), horse ? 120 : 180, v * 0.07, p, t, 0.01, 0.25);
      noise(sfxBus, "lowpass", 400, 120, 1, v * 0.5, p, t + 0.05, 0.005, 0.2); },
    crumble(v, p) { const t = ac.currentTime;
      noise(sfxBus, "lowpass", 900, 90, 0.8, v * 0.9, p, t, 0.02, 1.4);
      tone(sfxBus, "sine", 70, 35, v * 0.6, p, t, 0.01, 0.9);
      for (let k = 0; k < 6; k++) noise(sfxBus, "bandpass", jit(1200, 0.4), 800, 3, v * 0.3, p, t + 0.1 + Math.random() * 0.8, 0.002, 0.05); },
    // UI sounds are not positional.
    select() { const t = ac.currentTime; tone(uiBus, "sine", 880, 880, 0.12, 0, t, 0.002, 0.05); },
    command(kind) { const t = ac.currentTime;
      if (kind === 2) { tone(uiBus, "square", 330, 300, 0.05, 0, t, 0.002, 0.07); tone(uiBus, "square", 247, 240, 0.05, 0, t + 0.07, 0.002, 0.09); }
      else { tone(uiBus, "sine", 660, 660, 0.12, 0, t, 0.002, 0.05); tone(uiBus, "sine", 990, 990, 0.1, 0, t + 0.05, 0.002, 0.07); } },
    place() { const t = ac.currentTime; tone(uiBus, "sine", 140, 70, 0.4, 0, t, 0.002, 0.15); noise(uiBus, "lowpass", 700, 300, 1, 0.3, 0, t, 0.002, 0.12); },
    queued() { const t = ac.currentTime; tone(uiBus, "triangle", 523, 523, 0.15, 0, t, 0.002, 0.08); },
    error() { const t = ac.currentTime; tone(uiBus, "square", 110, 100, 0.08, 0, t, 0.005, 0.16); },
    starving() { const t = ac.currentTime; tone(uiBus, "triangle", 330, 330, 0.15, 0, t, 0.01, 0.3); tone(uiBus, "triangle", 262, 262, 0.15, 0, t + 0.25, 0.01, 0.5); },
    trained() { const t = ac.currentTime; tone(uiBus, "triangle", 784, 784, 0.15, 0, t, 0.002, 0.15); tone(uiBus, "triangle", 1047, 1047, 0.13, 0, t + 0.09, 0.002, 0.25); },
    built() { const t = ac.currentTime; [523, 659, 784].forEach((f, k) => tone(uiBus, "triangle", f, f, 0.15, 0, t + k * 0.1, 0.003, 0.35)); },
    horn() { const t = ac.currentTime;
      for (const [f, d, dl] of [[196, 0.35, 0], [196, 0.7, 0.42]]) {
        const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
        const lfo = ac.createOscillator(); lfo.frequency.value = 5; const lg = ac.createGain(); lg.gain.value = 3;
        lfo.connect(lg); lg.connect(o.frequency);
        const flt = ac.createBiquadFilter(); flt.type = "lowpass"; flt.frequency.value = 900;
        o.connect(flt); flt.connect(out(uiBus, 0.3, 0, t + dl, 0.06, d));
        o.start(t + dl); lfo.start(t + dl); o.stop(t + dl + d + 0.1); lfo.stop(t + dl + d + 0.1);
      } },
    fanfare(won) { const t = ac.currentTime;
      const notes = won ? [392, 523, 659, 784, 1047] : [440, 415, 392, 330, 262];
      notes.forEach((f, k) => tone(uiBus, "triangle", f, f, 0.2, 0, t + k * 0.18, 0.01, k === notes.length - 1 ? 1.2 : 0.3)); },
  };

  // Play a sound made at world position (x, y): silent if it's in the fog or
  // far off screen, quieter toward the edges, panned left/right.
  function at(name, x, y, gapMs, ...args) {
    if (!ac || muted) return;
    const v = hearing(x, y);
    if (v <= 0.02) return;
    if (!allow(name, gapMs)) return;
    S[name](v, panFor(x, y), ...args);
    played[name] = (played[name] || 0) + 1;
  }
  function ui(name, ...args) { if (allow("ui:" + name, 60)) { S[name](...args); played[name] = (played[name] || 0) + 1; } }

  // How many times each sound has played: handy when debugging in the console.
  const played = {};
  return { init, setMuted, setVolume, get muted() { return muted; }, get volume() { return volume; }, at, ui, played };
})();

// How loud a world-position sound is for the current camera (0..1):
// silent in the fog, fading out with distance from the middle of the view.
function hearing(x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return 0;
  if (u8(W.fog_ptr(), MW * MH)[ty * MW + tx] !== 2) return 0;
  const reach = cam.dist * 0.9 + 4;
  const d = Math.hypot(x - cam.x, y - cam.y) / reach;
  return d >= 1 ? 0 : (1 - d) * (0.55 + 0.45 * Math.min(1, 22 / cam.dist));
}
// Left/right position on screen, -1..1, from the camera's point of view.
function panFor(x, y) {
  const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
  return Math.max(-1, Math.min(1, ((x - cam.x) * rx + (y - cam.y) * rz) / (cam.dist * 0.7)));
}
