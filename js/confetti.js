/**
 * BobaConfetti - Canvas-based confetti particle system.
 * Renders on an overlay canvas; no external dependencies.
 */
(function (global) {
  'use strict';

  const COLORS = [
    '#e63946', '#f4a261', '#2a9d8f', '#e9c46a',
    '#264653', '#ff6b6b', '#a8dadc', '#bc8cff'
  ];
  const GRAVITY = 0.18;
  const OPACITY_DECAY = 0.008;

  let canvas = null;
  let ctx = null;
  let particles = [];
  let animating = false;
  let enabled = true;

  /**
   * init(containerElement) - Create an overlay canvas inside the given container.
   * The canvas is absolutely positioned and pointer-events:none so it does not
   * interfere with clicks on the underlying UI.
   */
  function init(container) {
    if (canvas) return; // already initialised

    canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';

    // Ensure the container is a positioning context.
    const pos = global.getComputedStyle(container).position;
    if (pos === 'static') {
      container.style.position = 'relative';
    }

    container.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
  }

  /**
   * resize() - Synchronise canvas dimensions with its container.
   */
  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    canvas.width = parent.offsetWidth;
    canvas.height = parent.offsetHeight;
  }

  /**
   * _randomBetween(min, max) - Uniform random float in [min, max).
   */
  function _randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  /**
   * _makeParticle() - Construct a single confetti particle.
   * Spawned near the horizontal centre, just above the top of the canvas.
   */
  function _makeParticle() {
    return {
      x: canvas.width * _randomBetween(0.3, 0.7),
      y: _randomBetween(-10, 10),
      vx: (Math.random() - 0.5) * 6,
      vy: -(Math.random() * 6 + 3),
      width: _randomBetween(6, 12),
      height: _randomBetween(4, 8),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      angle: Math.random() * Math.PI * 2,
      angularVelocity: (Math.random() - 0.5) * 0.2,
      opacity: 1
    };
  }

  /**
   * _step() - Advance all particles by one frame and redraw.
   * Stops the rAF loop automatically when every particle has expired.
   */
  function _step() {
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = 0;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      // Physics
      p.vy += GRAVITY;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.angularVelocity;
      p.opacity -= OPACITY_DECAY;

      // Skip dead particles
      if (p.opacity <= 0 || p.y > canvas.height) continue;
      alive++;

      // Draw rotated rectangle
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
      ctx.restore();
    }

    if (alive > 0) {
      global.requestAnimationFrame(_step);
    } else {
      // All particles expired; clear the canvas and mark loop as stopped.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles = [];
      animating = false;
    }
  }

  /**
   * launch(count) - Spawn `count` confetti particles (default 80) and start
   * the animation loop if it is not already running.
   */
  function launch(count) {
    if (!enabled || !canvas) return;
    const n = (count !== undefined && count > 0) ? count : 80;

    for (let i = 0; i < n; i++) {
      particles.push(_makeParticle());
    }

    if (!animating) {
      animating = true;
      global.requestAnimationFrame(_step);
    }
  }

  /**
   * setEnabled(bool) - Toggle confetti on/off.
   * Disabling mid-animation stops any future launch but does not abort the
   * current frame loop; particles already in flight finish naturally.
   */
  function setEnabled(bool) {
    enabled = !!bool;
  }

  global.BobaConfetti = { init, launch, resize, setEnabled };
})(window);
