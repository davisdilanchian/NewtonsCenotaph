// Sound: footsteps made for the ground underfoot, heard in the room around you, and Haydn.
// Every step is synthesised, and each room's echo is computed from its size and its stone.
import { clamp } from './util.js';

const MUSIC = 'assets/music/haydn-creation.m4a';

/**
 * A room's echo as an impulse response: noise dying away over the reverberation time, losing its
 * treble faster than its bass, as stone and air do, with any distinct echoes laid on top.
 */
function impulse(ctx, { seconds, darken, build = 0.005, echoes = [], flutter = 0 }) {
  const rate = ctx.sampleRate, n = Math.ceil(rate * seconds), buffer = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const out = buffer.getChannelData(ch);
    let low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate, k = clamp(0.9 * Math.exp(-t * darken), 0.015, 0.9);   // the one-pole filter closes as the sound ages
      low += k * (Math.random() * 2 - 1 - low);
      out[i] = low * Math.exp((-6.9 * t) / seconds) * Math.min(1, t / build);
    }
    for (const [at, gain] of echoes) {
      const i0 = Math.floor(at * rate * (1 + (ch ? 0.004 : -0.004)));
      for (let j = 0; j < rate * 0.012 && i0 + j < n; j++) out[i0 + j] += gain * (Math.random() * 2 - 1) * Math.exp(-j / (rate * 0.003));
    }
    if (flutter) for (let e = 1; e < 30; e++) {                        // between the near walls of a passage
      const i0 = Math.floor(e * flutter * rate) + ch * 7;
      if (i0 < n) out[i0] += 0.25 * 0.82 ** e;
    }
  }
  return buffer;
}

export function makeSound() {
  let ctx = null, dry, rooms = {}, room = '', noise, music = null, musicGain, musicOn = true, foot = 0;
  try { musicOn = localStorage.getItem('music') !== 'off'; } catch { /* storage can be blocked */ }

  function start() {
    if (ctx) { ctx.resume(); return; }
    ctx = new AudioContext();
    dry = ctx.createGain(); dry.gain.value = 1; dry.connect(ctx.destination);

    // the open air, a stone passage 4.4 m wide, and a sphere 134 m across, all of stone. The sphere
    // gathers its echo back to the middle: a sound made near the centre returns there 0.39 s later.
    const spaces = {
      open: { ir: { seconds: 0.6, darken: 9 }, wet: 0.12 },
      passage: { ir: { seconds: 2.6, darken: 2.2, flutter: 4.4 / 343 }, wet: 1.1 },
      void: { ir: { seconds: 13, darken: 0.42, build: 0.25, echoes: [[0.39, 0.5], [0.78, 0.3], [1.17, 0.17]] }, wet: 3.2 },
    };
    for (const [name, s] of Object.entries(spaces)) {
      const conv = ctx.createConvolver(), gain = ctx.createGain();
      conv.buffer = impulse(ctx, s.ir);
      gain.gain.value = 0;
      conv.connect(gain).connect(ctx.destination);
      rooms[name] = { send: conv, gain, wet: s.wet };
    }
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    music = new Audio(MUSIC);
    music.loop = true; music.preload = 'auto'; music.crossOrigin = 'anonymous';
    musicGain = ctx.createGain(); musicGain.gain.value = 0;
    ctx.createMediaElementSource(music).connect(musicGain).connect(ctx.destination);
    if (musicOn) playMusic();
    setRoom(room || 'open', true);
  }

  function playMusic() {
    music.play().catch(() => {});
    musicGain.gain.cancelScheduledValues(ctx.currentTime);
    musicGain.gain.setTargetAtTime(0.42, ctx.currentTime, 1.5);
  }

  function toggleMusic() {
    musicOn = !musicOn;
    try { localStorage.setItem('music', musicOn ? 'on' : 'off'); } catch { /* storage can be blocked */ }
    if (!ctx) return musicOn;
    if (musicOn) playMusic();
    else { musicGain.gain.setTargetAtTime(0, ctx.currentTime, 0.4); setTimeout(() => { if (!musicOn) music.pause(); }, 2500); }
    return musicOn;
  }

  function setRoom(name, now = false) {
    if (!ctx || (name === room && !now)) { room = name; return; }
    room = name;
    for (const [k, r] of Object.entries(rooms)) r.gain.gain.setTargetAtTime(k === name ? r.wet : 0, ctx.currentTime, now ? 0.01 : 0.5);
  }

  // one burst of filtered noise, shaped by an envelope
  function burst(out, at, { f, q = 1, type = 'bandpass', attack = 0.001, decay, gain }) {
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), env = ctx.createGain();
    src.buffer = noise; filter.type = type; filter.frequency.value = f; filter.Q.value = q;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay * 6);
    src.connect(filter).connect(env).connect(out);
    src.start(at, Math.random() * 0.8, attack + decay * 6 + 0.01);
  }

  /** A footfall: leather on limestone, on gravel, or on grass. */
  function step(surface, strength = 1) {
    if (!ctx || ctx.state !== 'running') return;
    const at = ctx.currentTime + 0.005, r = () => 0.85 + Math.random() * 0.3, out = ctx.createGain(), pan = ctx.createStereoPanner();
    foot ^= 1;
    pan.pan.value = foot ? 0.12 : -0.12;
    out.gain.value = 0.15 * strength;                                  // heard, not noticed: well under the music
    out.connect(pan).connect(dry);
    for (const r0 of Object.values(rooms)) pan.connect(r0.send);
    if (surface === 'stone') {
      burst(out, at, { f: 2300 * r(), q: 1.3, decay: 0.006, gain: 0.9 });                 // the heel's click
      burst(out, at, { f: 160 * r(), q: 0.9, decay: 0.018, gain: 1.1, type: 'lowpass' });   // and its weight
      burst(out, at + 0.075 + Math.random() * 0.03, { f: 3200 * r(), q: 1, decay: 0.01, gain: 0.35 });   // then the sole
    } else if (surface === 'gravel') {
      const grains = 18 + Math.floor(Math.random() * 10);
      for (let i = 0; i < grains; i++) {
        const t = 0.13 * Math.random() ** 1.6;
        burst(out, at + t, { f: 1400 + Math.random() * 3600, q: 2.5, decay: 0.002 + Math.random() * 0.004, gain: (0.25 + Math.random() * 0.5) * (1 - t * 4) });
      }
      burst(out, at, { f: 300 * r(), decay: 0.02, gain: 0.5, type: 'lowpass' });
    } else {
      burst(out, at, { f: 700 * r(), q: 0.5, attack: 0.015, decay: 0.035, gain: 0.45, type: 'lowpass' });   // a soft press into turf
      burst(out, at + 0.06, { f: 2600 * r(), q: 0.7, attack: 0.02, decay: 0.03, gain: 0.12 });              // and the blades brushing back
    }
  }

  return { start, step, setRoom, toggleMusic, get musicOn() { return musicOn; }, get ctx() { return ctx; }, get music() { return music; }, get room() { return room; } };
}
