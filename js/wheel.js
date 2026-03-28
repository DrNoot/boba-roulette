/**
 * BobaWheel - HTML5 Canvas roulette wheel renderer
 * Exposes window.BobaWheel with: init, setSegments, spin, isSpinning, render, setTickCallback
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const DEFAULT_COLORS = [
    '#e63946', '#f4a261', '#2a9d8f', '#e9c46a',
    '#6a4c93', '#1982c4', '#ff6b6b', '#06d6a0',
    '#bc8cff', '#f0883e',
  ];

  const TWO_PI = Math.PI * 2;
  const HALF_PI = Math.PI / 2;

  // Phase durations (ms)
  const SPIN_DURATION  = 4500; // wheel spin + ball orbit
  const SETTLE_DURATION = 1500; // ball spirals inward

  // ---------------------------------------------------------------------------
  // Easing functions
  // ---------------------------------------------------------------------------
  function easeOutQuint(t) {
    return 1 - Math.pow(1 - t, 5);
  }

  function easeOutBounce(t) {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) {
      return n1 * t * t;
    } else if (t < 2 / d1) {
      t -= 1.5 / d1;
      return n1 * t * t + 0.75;
    } else if (t < 2.5 / d1) {
      t -= 2.25 / d1;
      return n1 * t * t + 0.9375;
    } else {
      t -= 2.625 / d1;
      return n1 * t * t + 0.984375;
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let canvas = null;
  let ctx    = null;
  let dpr    = 1;

  // Logical size (CSS pixels)
  let logicalSize = 400;

  // Segments
  let originalSegments = [];   // {name, color} as provided by caller
  let displaySegments  = [];   // possibly duplicated for visual fullness, each has {name, color, originalIndex}

  // Wheel rotation (radians, cumulative)
  let wheelAngle = 0;

  // Spin animation state
  let spinning       = false;
  let spinStartTime  = null;
  let spinStartAngle = 0;
  let spinEndAngle   = 0;
  let spinWinnerIdx  = 0;   // index into originalSegments
  let onCompleteCallback = null;
  let phase          = 'idle'; // 'idle' | 'spin' | 'settle' | 'done'

  // Ball state
  let ballAngle       = 0;    // absolute angle from centre (radians)
  let ballRadius      = 0;    // distance from centre (logical px)
  let ballOrbitRadius = 0;    // set during init / resize
  let ballTargetAngle = 0;    // final resting angle
  let ballTargetRadius = 0;   // final resting distance from centre
  let lastBallSegment = -1;   // for tick detection

  // Callbacks
  let tickCallback = null;

  // RAF handle
  let rafId = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function init(canvasElement) {
    canvas = canvasElement;
    ctx    = canvas.getContext('2d');

    canvas.style.touchAction = 'none';

    _resize();

    window.addEventListener('resize', _resize);

    _scheduleRender();
  }

  function setSegments(segments) {
    if (!segments || segments.length === 0) return;

    originalSegments = segments.map((s, i) => ({
      name:  s.name  || `Option ${i + 1}`,
      color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    }));

    // If fewer than 6 segments, duplicate to fill visually
    displaySegments = [];
    if (originalSegments.length < 6) {
      const times = Math.ceil(6 / originalSegments.length);
      for (let t = 0; t < times; t++) {
        originalSegments.forEach((seg, i) => {
          displaySegments.push({ ...seg, originalIndex: i });
        });
      }
    } else {
      originalSegments.forEach((seg, i) => {
        displaySegments.push({ ...seg, originalIndex: i });
      });
    }

    _scheduleRender();
  }

  function spin(winnerIndex, onComplete) {
    if (spinning) return;
    if (!displaySegments.length) return;

    spinning           = true;
    phase              = 'spin';
    spinStartTime      = null;
    spinStartAngle     = wheelAngle;
    spinWinnerIdx      = winnerIndex;
    onCompleteCallback = onComplete || null;

    // Find first display segment that maps to the winner
    const displayIdx = displaySegments.findIndex(s => s.originalIndex === winnerIndex);
    const segCount   = displaySegments.length;
    const segArc     = TWO_PI / segCount;

    // The pointer is at -PI/2 (top). We want the centre of the winner segment
    // to sit under the pointer at the END of the spin.
    //
    // Segment i has its centre at: wheelAngle + i * segArc + segArc / 2
    // We need that to equal -PI/2  (mod 2PI)
    //
    // targetWheelAngle = -PI/2 - (displayIdx * segArc + segArc / 2)
    // Add N full revolutions (5-8) to make it look like a real spin.

    const revolutions = 5 + Math.floor(Math.random() * 4); // 5-8
    const rawTarget   = -HALF_PI - (displayIdx * segArc + segArc * 0.5);

    // Normalise so we always spin FORWARD (increasing angle)
    let delta = (rawTarget - spinStartAngle) % TWO_PI;
    if (delta <= 0) delta += TWO_PI;

    spinEndAngle = spinStartAngle + revolutions * TWO_PI + delta;

    // Ball starts on outer rim at the top (pointer position)
    ballAngle       = -HALF_PI;
    ballRadius      = ballOrbitRadius;
    ballTargetAngle = rawTarget; // ball rests where the winner segment centre ends up
    ballTargetRadius = logicalSize * 0.35; // ~mid-segment radially

    lastBallSegment = -1;

    _scheduleRender();
  }

  function isSpinning() {
    return spinning;
  }

  function render() {
    _drawFrame();
  }

  function setTickCallback(fn) {
    tickCallback = fn;
  }

  // ---------------------------------------------------------------------------
  // Resize handling
  // ---------------------------------------------------------------------------
  function _resize() {
    dpr = window.devicePixelRatio || 1;

    const parent = canvas.parentElement;
    const maxSize = 480;
    const available = parent
      ? Math.min(parent.clientWidth, parent.clientHeight, maxSize)
      : maxSize;

    logicalSize = Math.max(available, 200);

    canvas.style.width  = logicalSize + 'px';
    canvas.style.height = logicalSize + 'px';
    canvas.width  = Math.round(logicalSize * dpr);
    canvas.height = Math.round(logicalSize * dpr);

    // Update derived measurements
    const r = logicalSize / 2;
    ballOrbitRadius = r * 0.88; // ball orbits just inside the outer rim

    _scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------
  let _lastTimestamp = null;

  function _scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(_onRaf);
  }

  function _onRaf(timestamp) {
    rafId = null;

    const dt = _lastTimestamp ? Math.min(timestamp - _lastTimestamp, 50) : 16;
    _lastTimestamp = timestamp;

    _update(timestamp, dt);
    _drawFrame();

    // Keep looping while spinning or on first draw
    if (spinning || phase !== 'idle') {
      rafId = requestAnimationFrame(_onRaf);
    } else {
      _lastTimestamp = null;
    }
  }

  function _update(timestamp, _dt) {
    if (phase === 'idle' || phase === 'done') return;

    if (!spinStartTime) spinStartTime = timestamp;

    const elapsed = timestamp - spinStartTime;

    if (phase === 'spin') {
      const t = Math.min(elapsed / SPIN_DURATION, 1);
      const ease = easeOutQuint(t);

      // Wheel rotation
      wheelAngle = spinStartAngle + (spinEndAngle - spinStartAngle) * ease;

      // Ball orbits in OPPOSITE direction, decelerating
      const ballProgress = easeOutQuint(t);
      const totalBallRevs = 3 + (1 - t) * 4; // faster at start, slower at end
      ballAngle = -HALF_PI - ballProgress * TWO_PI * totalBallRevs;
      ballRadius = ballOrbitRadius;

      // Tick detection
      _detectTick();

      if (t >= 1) {
        // Transition to settle phase
        phase        = 'spin';  // will be reset below
        spinStartTime = timestamp;
        phase        = 'settle';
      }

    } else if (phase === 'settle') {
      const t = Math.min(elapsed / SETTLE_DURATION, 1);
      const ease = easeOutBounce(t);

      // Ball spirals inward
      const orbitEnd   = ballOrbitRadius;
      const radiusDelta = orbitEnd - ballTargetRadius;
      ballRadius = orbitEnd - radiusDelta * ease;

      // Ball angle converges to target (in wheel-space)
      // The target is wheel-relative; convert to absolute
      const absoluteTarget = spinEndAngle + ballTargetAngle - (-HALF_PI); // keep it simple: use raw target
      // Interpolate last orbit angle to absoluteTarget
      if (!_settleStartAngle) _settleStartAngle = ballAngle;
      ballAngle = _settleStartAngle + (absoluteTarget - _settleStartAngle) * ease;

      if (t >= 1) {
        phase    = 'done';
        spinning = false;
        _settleStartAngle = null;

        if (onCompleteCallback) {
          onCompleteCallback(spinWinnerIdx);
          onCompleteCallback = null;
        }
      }
    }
  }

  // Persisted across settle phase
  let _settleStartAngle = null;

  // ---------------------------------------------------------------------------
  // Tick detection
  // ---------------------------------------------------------------------------
  function _detectTick() {
    if (!tickCallback || !displaySegments.length) return;

    const segArc   = TWO_PI / displaySegments.length;
    // Which segment is the ball over in wheel-space?
    const relAngle = ((ballAngle - wheelAngle) % TWO_PI + TWO_PI) % TWO_PI;
    const segIdx   = Math.floor(relAngle / segArc);

    if (segIdx !== lastBallSegment) {
      lastBallSegment = segIdx;
      tickCallback();
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function _drawFrame() {
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, logicalSize, logicalSize);

    const cx = logicalSize / 2;
    const cy = logicalSize / 2;
    const r  = logicalSize / 2;

    _drawWheel(cx, cy, r);
    _drawPointer(cx, cy, r);
    _drawBall(cx, cy);

    ctx.restore();
  }

  function _drawWheel(cx, cy, r) {
    if (!displaySegments.length) {
      _drawEmptyWheel(cx, cy, r);
      return;
    }

    const outerR     = r * 0.92;
    const rimR       = r * 0.96;
    const hubR       = r * 0.08;
    const segCount   = displaySegments.length;
    const segArc     = TWO_PI / segCount;
    const gapAngle   = 0.012; // radians of dark gap between segments

    // --- Outer metallic rim ---
    const rimGrad = ctx.createRadialGradient(cx, cy, outerR * 0.96, cx, cy, rimR);
    rimGrad.addColorStop(0,   '#888');
    rimGrad.addColorStop(0.4, '#ddd');
    rimGrad.addColorStop(0.7, '#aaa');
    rimGrad.addColorStop(1,   '#555');

    ctx.beginPath();
    ctx.arc(cx, cy, rimR, 0, TWO_PI);
    ctx.arc(cx, cy, outerR, 0, TWO_PI, true);
    ctx.fillStyle = rimGrad;
    ctx.fill();

    // Subtle rim border
    ctx.beginPath();
    ctx.arc(cx, cy, rimR, 0, TWO_PI);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // --- Segment slices ---
    displaySegments.forEach((seg, i) => {
      const startAngle = wheelAngle + i * segArc + gapAngle * 0.5;
      const endAngle   = wheelAngle + (i + 1) * segArc - gapAngle * 0.5;

      // Slight radial gradient per segment for depth
      const segGrad = ctx.createRadialGradient(cx, cy, hubR, cx, cy, outerR);
      segGrad.addColorStop(0,   _lighten(seg.color, 0.3));
      segGrad.addColorStop(0.6, seg.color);
      segGrad.addColorStop(1,   _darken(seg.color, 0.25));

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = segGrad;
      ctx.fill();

      // Dark gap stroke
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // --- Label ---
      _drawLabel(cx, cy, outerR, startAngle, endAngle, seg.name);
    });

    // --- Centre hub ---
    const hubGrad = ctx.createRadialGradient(cx - hubR * 0.3, cy - hubR * 0.3, hubR * 0.05, cx, cy, hubR);
    hubGrad.addColorStop(0,   '#555');
    hubGrad.addColorStop(0.5, '#222');
    hubGrad.addColorStop(1,   '#111');

    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, TWO_PI);
    ctx.fillStyle   = hubGrad;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  function _drawLabel(cx, cy, outerR, startAngle, endAngle, name) {
    const midAngle  = (startAngle + endAngle) / 2;
    const labelR    = outerR * 0.65;
    const textX     = cx + labelR * Math.cos(midAngle);
    const textY     = cy + labelR * Math.sin(midAngle);

    const arcSpan  = endAngle - startAngle;
    const maxWidth = arcSpan * labelR * 0.9; // approximate chord length

    ctx.save();
    ctx.translate(textX, textY);
    ctx.rotate(midAngle + HALF_PI); // text reads outward from center

    // Determine font size that fits
    let fontSize = Math.min(13, Math.max(8, outerR * 0.07));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Truncate if needed
    let label = name;
    if (ctx.measureText(label).width > maxWidth) {
      while (label.length > 1 && ctx.measureText(label + '...').width > maxWidth) {
        label = label.slice(0, -1);
      }
      label = label + '...';
    }

    // Shadow for legibility
    ctx.shadowColor   = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur    = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, 0, 0);

    ctx.restore();
  }

  function _drawEmptyWheel(cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.92, 0, TWO_PI);
    ctx.fillStyle   = '#333';
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  function _drawPointer(cx, cy, r) {
    // Red arrow at top (12 o'clock), pointing inward
    const tipX   = cx;
    const tipY   = cy - r * 0.88;  // points to just inside the rim
    const baseY  = cy - r * 1.0;   // sits just outside the wheel
    const halfW  = r * 0.04;

    // Glow
    ctx.save();
    ctx.shadowColor   = 'rgba(220, 30, 30, 0.7)';
    ctx.shadowBlur    = 10;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - halfW * 1.6, baseY - r * 0.025);
    ctx.lineTo(tipX + halfW * 1.6, baseY - r * 0.025);
    ctx.closePath();

    ctx.fillStyle   = '#cc1111';
    ctx.fill();
    ctx.strokeStyle = '#880000';
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.restore();
  }

  function _drawBall(cx, cy) {
    if (phase === 'idle') return;

    const bx = cx + ballRadius * Math.cos(ballAngle);
    const by = cy + ballRadius * Math.sin(ballAngle);
    const br = Math.max(4, logicalSize * 0.021); // ~10px at 480px

    // Drop shadow
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur    = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // Metallic radial gradient
    const grad = ctx.createRadialGradient(
      bx - br * 0.35, by - br * 0.35, br * 0.05,
      bx, by, br
    );
    grad.addColorStop(0,   '#ffffff');
    grad.addColorStop(0.4, '#d0d0d0');
    grad.addColorStop(0.8, '#888888');
    grad.addColorStop(1,   '#555555');

    ctx.beginPath();
    ctx.arc(bx, by, br, 0, TWO_PI);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Color helpers
  // ---------------------------------------------------------------------------
  function _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
      : { r: 128, g: 128, b: 128 };
  }

  function _lighten(hex, amount) {
    const { r, g, b } = _hexToRgb(hex);
    const nr = Math.min(255, Math.round(r + (255 - r) * amount));
    const ng = Math.min(255, Math.round(g + (255 - g) * amount));
    const nb = Math.min(255, Math.round(b + (255 - b) * amount));
    return `rgb(${nr},${ng},${nb})`;
  }

  function _darken(hex, amount) {
    const { r, g, b } = _hexToRgb(hex);
    const nr = Math.max(0, Math.round(r * (1 - amount)));
    const ng = Math.max(0, Math.round(g * (1 - amount)));
    const nb = Math.max(0, Math.round(b * (1 - amount)));
    return `rgb(${nr},${ng},${nb})`;
  }

  // ---------------------------------------------------------------------------
  // Expose public API
  // ---------------------------------------------------------------------------
  global.BobaWheel = {
    init,
    setSegments,
    spin,
    isSpinning,
    render,
    setTickCallback,
  };

}(window));
