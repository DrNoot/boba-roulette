/**
 * BobaWheel - HTML5 Canvas roulette wheel with real physics
 * Wheel and ball are independent objects with separate angular velocities.
 * Exposes window.BobaWheel: init, setSegments, spin, isSpinning, render,
 *   setTickCallback, enableSwipe
 */
(function (global) {
  'use strict';

  const TWO_PI  = Math.PI * 2;
  const HALF_PI = Math.PI / 2;

  const DEFAULT_COLORS = [
    '#e63946','#f4a261','#2a9d8f','#e9c46a',
    '#6a4c93','#1982c4','#ff6b6b','#06d6a0','#bc8cff','#f0883e',
  ];

  // Physics constants — low friction = long suspenseful spins (~8-12 seconds)
  const WHEEL_FRICTION    = 0.9955;  // per-frame factor at 60 fps (~10s spin)
  const BALL_FRICTION     = 0.993;   // ball slows faster than wheel (~7-8s)
  const SETTLE_THRESHOLD  = 0.35;    // rad/s: ball barely moving before drop
  const SETTLE_DURATION   = 2.0;     // seconds for dramatic settle animation

  // ---------------------------------------------------------------------------
  // Easing
  // ---------------------------------------------------------------------------
  function easeOutBounce(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1)       return n1 * t * t;
    if (t < 2 / d1)       { t -= 1.5  / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1)     { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1; return n1 * t * t + 0.984375;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let canvas = null, ctx = null, dpr = 1;
  let logicalSize = 400;
  let outerR = 0, rimR = 0, ballOrbitRadius = 0;

  let originalSegments = [], displaySegments = [];

  // Wheel physics
  let wheelAngle = 0, wheelAngularVel = 0;

  // Ball physics
  let ballAngle = 0, ballAngularVel = 0;
  let ballRadius = 0, initialBallSpeed = 0;
  let ballTrail = []; // [{x,y,alpha}] for motion blur

  // Spin state
  let phase = 'idle'; // idle | spinning | settling | done
  let spinWinnerIdx = 0;
  let onCompleteCallback = null;
  let lastBallSegment = -1;
  let tickCallback = null;

  // Settle state
  let settleProgress = 0;
  let settleStartAngle = 0, settleTargetAngle = 0;
  let settleStartRadius = 0;
  let settleTargetRadius = 0;
  let settleWheelAngleStart = 0; // wheel angle when settle began

  // Swipe
  let swipeEnabled = true;
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;

  // RAF
  let rafId = null, lastTimestamp = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function init(canvasElement) {
    canvas = canvasElement;
    ctx    = canvas.getContext('2d');
    canvas.style.touchAction = 'none';
    _resize();
    window.addEventListener('resize', _resize);
    _attachSwipe();
    _scheduleRender();
  }

  function setSegments(segments) {
    if (!segments || segments.length === 0) return;
    originalSegments = segments.map((s, i) => ({
      name:  s.name  || `Option ${i + 1}`,
      color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    }));
    displaySegments = [];
    if (originalSegments.length < 6) {
      const times = Math.ceil(6 / originalSegments.length);
      for (let t = 0; t < times; t++) {
        originalSegments.forEach((seg, i) =>
          displaySegments.push({ ...seg, originalIndex: i }));
      }
    } else {
      originalSegments.forEach((seg, i) =>
        displaySegments.push({ ...seg, originalIndex: i }));
    }
    _scheduleRender();
  }

  function spin(winnerIndex, onComplete) {
    if (phase === 'spinning' || phase === 'settling') return;
    if (!displaySegments.length) return;

    phase              = 'spinning';
    spinWinnerIdx      = winnerIndex;
    onCompleteCallback = onComplete || null;
    lastBallSegment    = -1;
    ballTrail          = [];
    settleProgress     = 0;

    // Wheel spins clockwise — high initial speed for suspense
    wheelAngularVel = 18 + Math.random() * 8;

    // Ball spins counter-clockwise, faster than wheel
    initialBallSpeed = -(14 + Math.random() * 8);
    ballAngularVel   = initialBallSpeed;

    // Ball starts at the top of the rim
    ballAngle  = -HALF_PI;
    ballRadius = ballOrbitRadius;

    _scheduleRender();
  }

  function isSpinning() {
    return phase === 'spinning' || phase === 'settling';
  }

  function render() { _drawFrame(); }

  function setTickCallback(fn) { tickCallback = fn; }

  function enableSwipe(enabled) { swipeEnabled = enabled; }

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------
  function _resize() {
    dpr = window.devicePixelRatio || 1;
    const parent    = canvas.parentElement;
    const available = parent
      ? Math.min(parent.clientWidth, parent.clientHeight, 400)
      : 400;
    logicalSize = Math.max(available * 0.95, 200);

    canvas.style.width  = logicalSize + 'px';
    canvas.style.height = logicalSize + 'px';
    canvas.width  = Math.round(logicalSize * dpr);
    canvas.height = Math.round(logicalSize * dpr);

    outerR         = logicalSize / 2 * 0.92;
    rimR           = logicalSize / 2 * 0.96;
    ballOrbitRadius = logicalSize / 2 * 0.87;

    _scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Swipe gesture
  // ---------------------------------------------------------------------------
  function _attachSwipe() {
    canvas.addEventListener('touchstart', e => {
      if (!swipeEnabled) return;
      const t = e.touches[0];
      touchStartX = t.clientX; touchStartY = t.clientY;
      touchStartTime = performance.now();
    }, { passive: true });

    canvas.addEventListener('touchend', e => {
      if (!swipeEnabled || isSpinning()) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      const dt = (performance.now() - touchStartTime) / 1000;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dt > 0 && dist > 20) {
        const speed = dist / dt / logicalSize * 30; // map to rad/s range
        const vel   = Math.min(Math.max(speed, 6), 20);
        // Determine swipe direction relative to canvas centre
        const cx = canvas.getBoundingClientRect().left + logicalSize / 2;
        const cy = canvas.getBoundingClientRect().top  + logicalSize / 2;
        const angle = Math.atan2(t.clientY - cy, t.clientX - cx);
        const tangent = angle + HALF_PI; // tangent direction
        const swipeDir = (Math.cos(tangent) * dx + Math.sin(tangent) * dy) > 0 ? 1 : -1;
        wheelAngularVel = swipeDir * vel;
        // Ball opposite
        initialBallSpeed = -swipeDir * vel * (0.6 + Math.random() * 0.3);
        ballAngularVel   = initialBallSpeed;
      } else {
        // Tap: random defaults (matching spin() velocities)
        wheelAngularVel  = 18 + Math.random() * 8;
        initialBallSpeed = -(14 + Math.random() * 8);
        ballAngularVel   = initialBallSpeed;
      }
    }, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------
  function _scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(_onRaf);
  }

  function _onRaf(timestamp) {
    rafId = null;
    const dt = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.05) : 0.016;
    lastTimestamp = timestamp;

    _update(dt);
    _drawFrame();

    // Keep animating while spinning/settling, or while wheel is still drifting
    const wheelStillMoving = Math.abs(wheelAngularVel) > 0.01;
    if (phase !== 'idle' || wheelStillMoving) {
      rafId = requestAnimationFrame(_onRaf);
    } else {
      lastTimestamp = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Physics update
  // ---------------------------------------------------------------------------
  function _update(dt) {
    // Wheel keeps drifting even after ball settles (realistic)
    if (Math.abs(wheelAngularVel) > 0.01) {
      wheelAngle      += wheelAngularVel * dt;
      wheelAngularVel *= Math.pow(WHEEL_FRICTION, dt * 60);
    } else {
      wheelAngularVel = 0;
    }

    if (phase === 'idle' || phase === 'done') return;

    if (phase === 'spinning') {
      ballAngle      += ballAngularVel * dt;
      ballAngularVel *= Math.pow(BALL_FRICTION, dt * 60);

      // Ball drops inward as it slows
      const speedRatio = Math.min(1, Math.abs(ballAngularVel) / Math.abs(initialBallSpeed));
      ballRadius = lerp(outerR * 0.65, ballOrbitRadius, speedRatio);

      // Update trail
      const cx = logicalSize / 2;
      const cy = logicalSize / 2;
      ballTrail.unshift({ x: cx + ballRadius * Math.cos(ballAngle), y: cy + ballRadius * Math.sin(ballAngle) });
      if (ballTrail.length > 5) ballTrail.length = 5;

      _detectTick();

      if (Math.abs(ballAngularVel) < SETTLE_THRESHOLD) {
        _computeSettleTarget();
        phase               = 'settling';
        settleProgress      = 0;
        settleStartAngle    = ballAngle;
        settleStartRadius   = ballRadius;
        settleWheelAngleStart = wheelAngle;
      }

    } else if (phase === 'settling') {
      settleProgress += dt / SETTLE_DURATION;

      if (settleProgress >= 1) {
        settleProgress = 1;
        ballAngle      = settleTargetAngle;
        ballRadius     = settleTargetRadius;
        phase          = 'done';
        ballTrail      = [];

        if (onCompleteCallback) {
          const cb = onCompleteCallback;
          onCompleteCallback = null;
          cb(spinWinnerIdx);
        }
        return;
      }

      const t = settleProgress;
      // Compensate for wheel rotation during settle so ball tracks the segment
      const wheelDrift = wheelAngle - settleWheelAngleStart;
      // Angle: linear interpolation to target, adjusted for wheel drift
      ballAngle  = lerp(settleStartAngle, settleTargetAngle, t) + wheelDrift;
      // Radius: easeOutBounce for the "drop into slot" feel
      ballRadius = lerp(settleStartRadius, settleTargetRadius, easeOutBounce(t));
    }
  }

  function _computeSettleTarget() {
    const segCount = displaySegments.length;
    const segArc   = TWO_PI / segCount;

    // Find a display segment for the winner
    const targetDispIdx = displaySegments.findIndex(s => s.originalIndex === spinWinnerIdx);

    // Estimate remaining wheel rotation: v / ln(friction) * (1/60) approximation
    const frictionLog        = Math.log(WHEEL_FRICTION) * 60;
    const remainingWheelRot  = frictionLog !== 0 ? wheelAngularVel / (-frictionLog) : 0;
    const futureWheelAngle   = wheelAngle + remainingWheelRot;

    // The segment centre in absolute space when wheel comes to rest
    const rawTarget = futureWheelAngle + targetDispIdx * segArc + segArc * 0.5;

    // Choose nearest approach: find angle closest to current ballAngle
    let diff = ((rawTarget - ballAngle) % TWO_PI + TWO_PI) % TWO_PI;
    // Accept either direction — pick shortest path
    if (diff > Math.PI) diff -= TWO_PI;
    settleTargetAngle  = ballAngle + diff;
    settleTargetRadius = outerR * 0.60;
  }

  // ---------------------------------------------------------------------------
  // Tick detection
  // ---------------------------------------------------------------------------
  function _detectTick() {
    if (!tickCallback || !displaySegments.length) return;
    const segArc   = TWO_PI / displaySegments.length;
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
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, logicalSize, logicalSize);

    const cx = logicalSize / 2, cy = logicalSize / 2;
    const r  = logicalSize / 2;

    _drawWheel(cx, cy, r);
    _drawPointer(cx, cy, r);
    if (phase !== 'idle') _drawBall(cx, cy);

    ctx.restore();
  }

  function _drawWheel(cx, cy, r) {
    if (!displaySegments.length) {
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.92, 0, TWO_PI);
      ctx.fillStyle = '#333'; ctx.fill();
      return;
    }

    const hubR     = r * 0.08;
    const segCount = displaySegments.length;
    const segArc   = TWO_PI / segCount;
    const gap      = 0.012;

    // Outer metallic rim
    const rimGrad = ctx.createRadialGradient(cx, cy, outerR * 0.96, cx, cy, rimR);
    rimGrad.addColorStop(0, '#888'); rimGrad.addColorStop(0.4, '#ddd');
    rimGrad.addColorStop(0.7, '#aaa'); rimGrad.addColorStop(1, '#555');
    ctx.beginPath(); ctx.arc(cx, cy, rimR, 0, TWO_PI);
    ctx.arc(cx, cy, outerR, 0, TWO_PI, true);
    ctx.fillStyle = rimGrad; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, rimR, 0, TWO_PI);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.5; ctx.stroke();

    // Segment slices
    displaySegments.forEach((seg, i) => {
      const startA = wheelAngle + i * segArc + gap * 0.5;
      const endA   = wheelAngle + (i + 1) * segArc - gap * 0.5;

      const segGrad = ctx.createRadialGradient(cx, cy, hubR, cx, cy, outerR);
      segGrad.addColorStop(0,   _lighten(seg.color, 0.3));
      segGrad.addColorStop(0.6, seg.color);
      segGrad.addColorStop(1,   _darken(seg.color, 0.25));

      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, startA, endA); ctx.closePath();
      ctx.fillStyle = segGrad; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1; ctx.stroke();

      _drawLabel(cx, cy, outerR, startA, endA, seg.name, segCount);
    });

    // Centre hub
    const hubGrad = ctx.createRadialGradient(
      cx - hubR * 0.3, cy - hubR * 0.3, hubR * 0.05, cx, cy, hubR);
    hubGrad.addColorStop(0, '#555'); hubGrad.addColorStop(0.5, '#222');
    hubGrad.addColorStop(1, '#111');
    ctx.beginPath(); ctx.arc(cx, cy, hubR, 0, TWO_PI);
    ctx.fillStyle = hubGrad; ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  function _drawLabel(cx, cy, outerR, startAngle, endAngle, name, segCount) {
    const midAngle = (startAngle + endAngle) / 2;
    const labelR   = outerR * 0.60;
    const fontSize = Math.round(Math.max(9, Math.min(14, 150 / segCount)));

    ctx.save();
    ctx.translate(cx + labelR * Math.cos(midAngle), cy + labelR * Math.sin(midAngle));

    // Flip text if it would be upside down
    const norm = ((midAngle % TWO_PI) + TWO_PI) % TWO_PI;
    const flip = norm > HALF_PI && norm < HALF_PI * 3;
    ctx.rotate(flip ? midAngle + Math.PI : midAngle);

    let label = name.replace(/\s*\(.*\)/, '');
    const maxChars = segCount > 10 ? 9 : 13;
    if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '..';

    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Black stroke outline for legibility on any color
    ctx.lineWidth   = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle   = '#ffffff';
    ctx.fillText(label, 0, 0);

    ctx.restore();
  }

  function _drawPointer(cx, cy, r) {
    const tipY  = cy - r * 0.88;
    const baseY = cy - r * 1.0;
    const halfW = r * 0.04;

    ctx.save();
    ctx.shadowColor = 'rgba(220,30,30,0.7)';
    ctx.shadowBlur  = 10;
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx - halfW * 1.6, baseY - r * 0.025);
    ctx.lineTo(cx + halfW * 1.6, baseY - r * 0.025);
    ctx.closePath();
    ctx.fillStyle   = '#cc1111'; ctx.fill();
    ctx.strokeStyle = '#880000'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  function _drawBall(cx, cy) {
    const bx = cx + ballRadius * Math.cos(ballAngle);
    const by = cy + ballRadius * Math.sin(ballAngle);
    const br = Math.max(6, logicalSize * 0.025); // ~12px at 480px

    // Trail: fading circles behind the ball
    for (let i = 1; i < ballTrail.length; i++) {
      const alpha = 0.25 * (1 - i / ballTrail.length);
      const tr = br * (1 - i * 0.15);
      ctx.beginPath();
      ctx.arc(ballTrail[i].x, ballTrail[i].y, Math.max(tr, 2), 0, TWO_PI);
      ctx.fillStyle = `rgba(220,220,220,${alpha.toFixed(2)})`;
      ctx.fill();
    }

    // Ball
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    const grad = ctx.createRadialGradient(
      bx - br * 0.35, by - br * 0.35, br * 0.05, bx, by, br);
    grad.addColorStop(0,   '#ffffff');
    grad.addColorStop(0.35,'#e8e8e8');
    grad.addColorStop(0.75,'#999999');
    grad.addColorStop(1,   '#444444');

    ctx.beginPath(); ctx.arc(bx, by, br, 0, TWO_PI);
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Color helpers
  // ---------------------------------------------------------------------------
  function _hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) }
             : { r: 128, g: 128, b: 128 };
  }

  function _lighten(hex, amount) {
    const { r, g, b } = _hexToRgb(hex);
    return `rgb(${Math.min(255,Math.round(r+(255-r)*amount))},${Math.min(255,Math.round(g+(255-g)*amount))},${Math.min(255,Math.round(b+(255-b)*amount))})`;
  }

  function _darken(hex, amount) {
    const { r, g, b } = _hexToRgb(hex);
    return `rgb(${Math.max(0,Math.round(r*(1-amount)))},${Math.max(0,Math.round(g*(1-amount)))},${Math.max(0,Math.round(b*(1-amount)))})`;
  }

  // ---------------------------------------------------------------------------
  // Expose
  // ---------------------------------------------------------------------------
  global.BobaWheel = { init, setSegments, spin, isSpinning, render, setTickCallback, enableSwipe };

}(window));
