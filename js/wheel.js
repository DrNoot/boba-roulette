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
  // Phases: idle | ready | wheelCoasting | ballLaunched | settling | done
  //  ready = wheel shown, user can drag/flick it
  //  wheelCoasting = wheel spinning from user flick, waiting for ball flick
  //  ballLaunched = both spinning independently
  //  settling = ball dropping into slot
  //  done = result shown
  let phase = 'idle';
  let spinWinnerIdx = 0;
  let onCompleteCallback = null;
  let lastBallSegment = -1;
  let tickCallback = null;

  // Settle state
  let settleProgress = 0;
  let settleStartAngle = 0, settleTargetAngle = 0;
  let settleStartRadius = 0;
  let settleTargetRadius = 0;
  let settleWheelAngleStart = 0;

  // Touch interaction state
  let swipeEnabled = true;
  let dragging = false;
  let lastTouchAngle = 0;
  let touchVelocityHistory = []; // recent angular velocities for flick detection
  let touchStartTime = 0;

  // Delayed friction: track when wheel/ball were launched
  let wheelLaunchTime = 0;  // performance.now() when wheel was flicked
  let ballLaunchTime = 0;   // performance.now() when ball was flicked
  const FRICTION_DELAY = 2.0; // seconds of near-zero friction after launch
  const FRICTION_RAMP  = 1.5; // seconds to ramp from zero to full friction

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
    _attachTouch();
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

  // Enter ready state: wheel is shown, user can interact
  function setReady() {
    phase = 'ready';
    wheelAngularVel = 0;
    ballAngularVel = 0;
    ballTrail = [];
    _scheduleRender();
  }

  // Programmatic spin (bypasses manual interaction)
  function spin(winnerIndex, onComplete) {
    if (phase === 'ballLaunched' || phase === 'settling') return;
    if (!displaySegments.length) return;

    spinWinnerIdx      = winnerIndex;
    onCompleteCallback = onComplete || null;
    lastBallSegment    = -1;
    ballTrail          = [];
    settleProgress     = 0;

    wheelAngularVel  = 18 + Math.random() * 8;
    wheelLaunchTime  = performance.now();
    initialBallSpeed = -(14 + Math.random() * 8);
    ballAngularVel   = initialBallSpeed;
    ballLaunchTime   = performance.now();
    ballAngle  = -HALF_PI;
    ballRadius = ballOrbitRadius;
    phase = 'ballLaunched';

    _scheduleRender();
  }

  // Launch ball with given velocity (called by app.js after user flicks ball)
  function launchBall(winnerIndex, onComplete, ballVel) {
    if (phase !== 'wheelCoasting') return;

    spinWinnerIdx      = winnerIndex;
    onCompleteCallback = onComplete || null;
    lastBallSegment    = -1;
    ballTrail          = [];
    settleProgress     = 0;

    initialBallSpeed = ballVel;
    ballAngularVel   = ballVel;
    ballLaunchTime   = performance.now();
    ballAngle  = -HALF_PI;
    ballRadius = ballOrbitRadius;
    phase = 'ballLaunched';
  }

  function isSpinning() {
    return phase === 'wheelCoasting' || phase === 'ballLaunched' || phase === 'settling';
  }

  function isReady() {
    return phase === 'ready';
  }

  function getPhase() { return phase; }

  function render() { _drawFrame(); }

  function setTickCallback(fn) { tickCallback = fn; }

  function enableSwipe(enabled) { swipeEnabled = enabled; }

  // Callbacks for app.js
  let onWheelFlick = null;  // called when wheel gets flicked (user launched wheel)
  let onBallFlick = null;   // called when ball area is flicked
  function setWheelFlickCallback(fn) { onWheelFlick = fn; }
  function setBallFlickCallback(fn) { onBallFlick = fn; }

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
  // Velocity amplifier: small phone screen needs boost to feel like a big roulette wheel
  const VELOCITY_BOOST = 3.0;

  function _attachTouch() {
    // Get angle of touch relative to wheel center
    function _touchAngle(touch) {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return Math.atan2(touch.clientY - cy, touch.clientX - cx);
    }

    canvas.addEventListener('touchstart', e => {
      if (!swipeEnabled) return;
      if (phase === 'ballLaunched' || phase === 'settling') return;

      const touch = e.touches[0];
      dragging = true;
      lastTouchAngle = _touchAngle(touch);
      touchVelocityHistory = [];
      touchStartTime = performance.now();

      // If in ready state, stop any residual wheel motion so user "grabs" it
      if (phase === 'ready') {
        wheelAngularVel = 0;
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
      if (!dragging) return;
      const touch = e.touches[0];
      const currentAngle = _touchAngle(touch);

      // Angular delta (how much the finger moved around the wheel)
      let delta = currentAngle - lastTouchAngle;
      // Handle wrap-around at +/-PI
      if (delta > Math.PI) delta -= TWO_PI;
      if (delta < -Math.PI) delta += TWO_PI;

      // Apply rotation directly (1:1 with finger movement)
      wheelAngle += delta;

      // Track velocity: store recent deltas with timestamps
      const now = performance.now();
      touchVelocityHistory.push({ delta, time: now });
      // Keep only last 250ms of samples (per spin-wheel library best practice)
      while (touchVelocityHistory.length > 0 && now - touchVelocityHistory[0].time > 250) {
        touchVelocityHistory.shift();
      }

      lastTouchAngle = currentAngle;
      _scheduleRender();
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
      if (!dragging) return;
      dragging = false;

      // Calculate flick velocity from recent touch history
      let rawVel = 0;
      if (touchVelocityHistory.length >= 2) {
        const totalDelta = touchVelocityHistory.reduce((sum, v) => sum + v.delta, 0);
        const first = touchVelocityHistory[0].time;
        const last = touchVelocityHistory[touchVelocityHistory.length - 1].time;
        const timeSpan = (last - first) / 1000;
        if (timeSpan > 0.005) {
          rawVel = totalDelta / timeSpan; // rad/s
        }
      }

      // Amplify: small screen needs boost to feel like a big roulette wheel
      let flickVel = rawVel * VELOCITY_BOOST;

      // Cap at 80 rad/s
      flickVel = Math.sign(flickVel) * Math.min(Math.abs(flickVel), 80);

      // Debug: show velocity on screen (temporary)
      const dbg = document.getElementById('spinning-label');
      if (dbg) dbg.textContent = `Vel: ${Math.abs(flickVel).toFixed(1)} rad/s (raw: ${Math.abs(rawVel).toFixed(1)})`;

      if (phase === 'ready') {
        if (Math.abs(flickVel) > 2.0) {
          wheelAngularVel = flickVel;
          wheelLaunchTime = performance.now();
          phase = 'wheelCoasting';
          if (onWheelFlick) onWheelFlick(flickVel);
          _scheduleRender();
        }
      } else if (phase === 'wheelCoasting') {
        if (Math.abs(flickVel) > 1.5) {
          const ballVel = flickVel * (0.8 + Math.random() * 0.4);
          if (onBallFlick) onBallFlick(ballVel);
        }
      }
    }, { passive: true });

    // Also support mouse for desktop testing
    canvas.addEventListener('mousedown', e => {
      if (!swipeEnabled) return;
      if (phase === 'ballLaunched' || phase === 'settling') return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      dragging = true;
      lastTouchAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
      touchVelocityHistory = [];
      if (phase === 'ready') wheelAngularVel = 0;
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const currentAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
      let delta = currentAngle - lastTouchAngle;
      if (delta > Math.PI) delta -= TWO_PI;
      if (delta < -Math.PI) delta += TWO_PI;
      wheelAngle += delta;
      const now = performance.now();
      touchVelocityHistory.push({ delta, time: now });
      while (touchVelocityHistory.length > 0 && now - touchVelocityHistory[0].time > 250) {
        touchVelocityHistory.shift();
      }
      lastTouchAngle = currentAngle;
      _scheduleRender();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      let rawVel = 0;
      if (touchVelocityHistory.length >= 2) {
        const totalDelta = touchVelocityHistory.reduce((sum, v) => sum + v.delta, 0);
        const first = touchVelocityHistory[0].time;
        const last = touchVelocityHistory[touchVelocityHistory.length - 1].time;
        const timeSpan = (last - first) / 1000;
        if (timeSpan > 0.005) rawVel = totalDelta / timeSpan;
      }
      let flickVel = rawVel * VELOCITY_BOOST;
      flickVel = Math.sign(flickVel) * Math.min(Math.abs(flickVel), 80);
      if (phase === 'ready' && Math.abs(flickVel) > 2.0) {
        wheelAngularVel = flickVel;
        wheelLaunchTime = performance.now();
        phase = 'wheelCoasting';
        if (onWheelFlick) onWheelFlick(flickVel);
        _scheduleRender();
      } else if (phase === 'wheelCoasting' && Math.abs(flickVel) > 1.5) {
        const ballVel = flickVel * (0.8 + Math.random() * 0.4);
        if (onBallFlick) onBallFlick(ballVel);
      }
    });
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

    // Keep animating while any phase is active or wheel is moving
    const wheelStillMoving = Math.abs(wheelAngularVel) > 0.01 || dragging;
    if ((phase !== 'idle' && phase !== 'done') || wheelStillMoving) {
      rafId = requestAnimationFrame(_onRaf);
    } else {
      lastTimestamp = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Friction with delayed ramp-up
  // ---------------------------------------------------------------------------
  function _getFriction(baseFriction, launchTime) {
    // Returns effective friction factor. Near 1.0 (no friction) right after launch,
    // ramping to baseFriction over FRICTION_DELAY + FRICTION_RAMP seconds.
    const elapsed = (performance.now() - launchTime) / 1000;
    if (elapsed < FRICTION_DELAY) return 1.0; // zero friction
    const rampT = Math.min((elapsed - FRICTION_DELAY) / FRICTION_RAMP, 1.0);
    // Interpolate from 1.0 (no friction) to baseFriction
    return 1.0 + (baseFriction - 1.0) * rampT;
  }

  // ---------------------------------------------------------------------------
  // Physics update
  // ---------------------------------------------------------------------------
  function _update(dt) {
    // Wheel always drifts with friction (all phases except idle when stationary)
    if (!dragging && Math.abs(wheelAngularVel) > 0.01) {
      wheelAngle += wheelAngularVel * dt;
      const wFriction = wheelLaunchTime ? _getFriction(WHEEL_FRICTION, wheelLaunchTime) : WHEEL_FRICTION;
      wheelAngularVel *= Math.pow(wFriction, dt * 60);
    } else if (!dragging) {
      wheelAngularVel = 0;
    }

    if (phase === 'idle' || phase === 'done' || phase === 'ready') return;

    // wheelCoasting: wheel spinning, waiting for ball flick. Just let wheel decelerate.
    if (phase === 'wheelCoasting') {
      if (Math.abs(wheelAngularVel) < 0.3) {
        phase = 'ready';
        wheelAngularVel = 0;
      }
      return;
    }

    if (phase === 'ballLaunched') {
      ballAngle += ballAngularVel * dt;
      const bFriction = ballLaunchTime ? _getFriction(BALL_FRICTION, ballLaunchTime) : BALL_FRICTION;
      ballAngularVel *= Math.pow(bFriction, dt * 60);

      // Ball drops inward as it slows (quadratic for dramatic late drop, like real centrifugal force)
      const speedRatio = Math.min(1, Math.abs(ballAngularVel) / Math.abs(initialBallSpeed));
      ballRadius = lerp(outerR * 0.65, ballOrbitRadius, speedRatio * speedRatio);

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
    if (phase === 'wheelCoasting') {
      // Show ball sitting at top of rim, pulsing to prompt user to flick it
      ballAngle = -HALF_PI;
      ballRadius = ballOrbitRadius;
      _drawBall(cx, cy);
    } else if (phase === 'ballLaunched' || phase === 'settling' || phase === 'done') {
      _drawBall(cx, cy);
    }

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
  global.BobaWheel = {
    init, setSegments, setReady, spin, launchBall,
    isSpinning, isReady, getPhase, render,
    setTickCallback, enableSwipe,
    setWheelFlickCallback, setBallFlickCallback,
  };

}(window));
