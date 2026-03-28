/**
 * BobaAudio - Web Audio API sound synthesis module
 * All sounds generated programmatically; no external audio files required.
 */
(function (global) {
  'use strict';

  let audioCtx = null;
  let enabled = true;

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (global.AudioContext || global.webkitAudioContext)();
    }
    // Mobile browsers suspend the context until a user gesture resumes it.
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  /**
   * init() - Create (or resume) the AudioContext on first user gesture.
   * Should be called from a click/touch handler before any playback.
   */
  function init() {
    getCtx();
  }

  /**
   * playTick() - Short percussive click for each divider pass.
   * Sine wave sweeping 1200 Hz -> 600 Hz over 40 ms,
   * with gain envelope 0.3 -> 0 over 60 ms.
   */
  function playTick() {
    if (!enabled) return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.linearRampToValueAtTime(600, now + 0.04);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.07);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  /**
   * playSpinStart() - Bandpass-filtered noise whoosh during spin (~4 s).
   * Returns the BufferSource node so the caller can stop it early.
   */
  function playSpinStart() {
    if (!enabled) return null;
    const ctx = getCtx();
    const now = ctx.currentTime;
    const duration = 4;

    // Generate white noise buffer
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(400, now);
    bandpass.frequency.linearRampToValueAtTime(1200, now + duration * 0.5);
    bandpass.frequency.linearRampToValueAtTime(400, now + duration);
    bandpass.Q.value = 1.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.3);
    gain.gain.linearRampToValueAtTime(0.4, now + duration - 0.5);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(ctx.destination);

    source.start(now);
    source.stop(now + duration);
    source.onended = () => {
      source.disconnect();
      bandpass.disconnect();
      gain.disconnect();
    };

    return source;
  }

  /**
   * playLand() - Low thud when the ball settles.
   * Sine 80 Hz -> 40 Hz over 150 ms plus a subtle triangle tick at 900 Hz.
   */
  function playLand() {
    if (!enabled) return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    // Low thud
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(80, now);
    thud.frequency.linearRampToValueAtTime(40, now + 0.15);
    thudGain.gain.setValueAtTime(0.5, now);
    thudGain.gain.linearRampToValueAtTime(0, now + 0.18);
    thud.connect(thudGain);
    thudGain.connect(ctx.destination);
    thud.start(now);
    thud.stop(now + 0.2);
    thud.onended = () => { thud.disconnect(); thudGain.disconnect(); };

    // Subtle triangle tick
    const tick = ctx.createOscillator();
    const tickGain = ctx.createGain();
    tick.type = 'triangle';
    tick.frequency.setValueAtTime(900, now);
    tickGain.gain.setValueAtTime(0.15, now);
    tickGain.gain.linearRampToValueAtTime(0, now + 0.05);
    tick.connect(tickGain);
    tickGain.connect(ctx.destination);
    tick.start(now);
    tick.stop(now + 0.06);
    tick.onended = () => { tick.disconnect(); tickGain.disconnect(); };
  }

  /**
   * playCelebration() - Rising 4-note arpeggio: C5, E5, G5, C6.
   * Triangle waves staggered 120 ms apart, each fading over 400 ms.
   */
  function playCelebration() {
    if (!enabled) return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    const stagger = 0.12;
    const fadeDuration = 0.4;

    notes.forEach((freq, i) => {
      const start = now + i * stagger;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.25, start);
      gain.gain.linearRampToValueAtTime(0, start + fadeDuration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + fadeDuration + 0.01);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    });
  }

  /**
   * setEnabled(bool) - Toggle all audio on/off.
   */
  function setEnabled(bool) {
    enabled = !!bool;
  }

  global.BobaAudio = { init, playTick, playSpinStart, playLand, playCelebration, setEnabled };
})(window);
