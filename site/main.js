/* ============================================================================
   DESCENT — Helix Film 01
   Scroll-driven film page.

   Responsibilities
     1. Wire Lenis + GSAP ScrollTrigger (and survive without either).
     2. Map scroll progress -> film time -> video.currentTime.
     3. Detect unreliable seeking and degrade: frames -> autoplay -> static.
     4. Choreograph the four clip chapters against film time.
     5. Shift the accent colour from gold-green to cyan as you descend.
     6. Mouse-reactive particle / light overlay in WebGL.
     7. Respect prefers-reduced-motion, and honour a manual motion toggle.

   No modules, no build step: this file must run from file:// as well as from
   a static server.
   ========================================================================= */

(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  var FILM_FALLBACK_DURATION = 49;   /* 12 + 12 + 10 + 15 */
  var SEEK_SLOW_MS        = 120;     /* a seek slower than this counts as janky */
  var SEEK_TOLERANCE      = 0.08;    /* seconds of landing error we tolerate  */
  var PROBE_SAMPLES       = 6;       /* seeks we measure before judging      */
  var PROBE_FAILURES      = 4;       /* janky seeks needed before degrading  */
  var PROBE_WARMUP_MS     = 1200;    /* ignore seeks while the file buffers */
  var FRAME_CACHE_SIZE    = 48;

  var ACCENT_STOPS = [
    [0.00, 224, 200, 138],   /* gold            */
    [0.16, 212, 204, 132],   /* gold-green      */
    [0.38, 126, 199, 158],   /* moss            */
    [0.60,  82, 207, 197],   /* turquoise       */
    [0.82,  96, 226, 215],   /* cyan            */
    [1.00, 140, 240, 228]    /* bright cyan     */
  ];

  /* --------------------------------------------------------------- helpers */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(s) {
    s = Math.max(0, s);
    return pad2(Math.floor(s / 60)) + ':' + pad2(Math.floor(s % 60));
  }
  function firstSentence(text) {
    if (!text) return '';
    var m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
    var out = (m ? m[0] : text).replace(/\s+/g, ' ').trim();
    return out.length > 150 ? out.slice(0, 147).trim() + '…' : out;
  }

  /* ------------------------------------------------------------------ dom */

  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };

  var filmEl    = $('film');
  var pinEl     = $('film-pin');
  var videoEl   = $('film-video');
  var framesEl  = $('film-frames');
  var fxEl      = $('film-fx');
  var badgeEl   = $('film-badge');
  var posterEl  = $('film-poster');
  var stageEl   = $('hud-stage');
  var railEl    = $('rail');
  var stateEl   = $('hud-state');
  var tcNowEl   = $('tc-now');
  var tcTotalEl = $('tc-total');
  var navEl     = $('nav');
  var motionBtn = $('motion-toggle');

  if (!filmEl || !pinEl) return;

  /* ------------------------------------------------------- the clip table
     Read from the DOM so the timings live in exactly one place.            */

  var CLIPS = Array.prototype.map.call(
    document.querySelectorAll('#clips .clips__item'),
    function (li) {
      var textEl = li.querySelector('.clips__text');
      return {
        n: li.getAttribute('data-clip-n') || '',
        title: li.getAttribute('data-clip-title') || '',
        start: parseFloat(li.getAttribute('data-clip-start')) || 0,
        end: parseFloat(li.getAttribute('data-clip-end')) || 0,
        dur: parseFloat(li.getAttribute('data-clip-dur')) || 0,
        desc: firstSentence(textEl ? textEl.textContent : '')
      };
    }
  );

  var FILM_DURATION = CLIPS.reduce(function (m, c) { return Math.max(m, c.end); }, 0) ||
                      FILM_FALLBACK_DURATION;

  /* ------------------------------------------------------------ motion state */

  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var motionOn = !(reduceQuery && reduceQuery.matches);
  var userOverride = false;

  function applyMotionState() {
    root.classList.toggle('is-static', !motionOn);
    root.classList.toggle('motion-forced', motionOn && userOverride);
    if (posterEl) {
      /* Motion: the clean plate, cropped to fill the frame.
         Static: the titled poster, shown whole and uncropped. */
      posterEl.src = motionOn ? 'public/placeholder-frame.jpg' : 'public/poster.jpg';
    }
    if (motionBtn) {
      motionBtn.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
      var lbl = motionBtn.querySelector('.nav__toggle-label');
      if (lbl) lbl.textContent = motionOn ? 'Motion on' : 'Motion off';
    }
    if (!motionOn) {
      setMediaMode('static');
      if (fx && fx.stop) fx.stop();
    } else {
      if (fx && fx.start) fx.start();
      if (videoReady) setMediaMode('scrub');
      else if (videoMissing) setMediaMode('static');
    }
    updateBadge();
  }

  if (motionBtn) {
    motionBtn.addEventListener('click', function () {
      userOverride = true;
      motionOn = !motionOn;
      applyMotionState();
      if (motionOn && scrollTrigger && scrollTrigger.refresh) scrollTrigger.refresh();
    });
  }
  if (reduceQuery) {
    var onReduceChange = function (e) {
      if (userOverride) return;
      motionOn = !e.matches;
      applyMotionState();
    };
    if (reduceQuery.addEventListener) reduceQuery.addEventListener('change', onReduceChange);
    else if (reduceQuery.addListener) reduceQuery.addListener(onReduceChange);
  }

  /* --------------------------------------------------------------- the HUD */

  var chapterEls = [];
  var railBtns = [];

  if (stageEl && railEl) {
    CLIPS.forEach(function (c, i) {
      var card = document.createElement('div');
      card.className = 'chapter';
      card.setAttribute('data-index', String(i));
      card.innerHTML =
        '<span class="chapter__n">' + c.n + ' &nbsp;/&nbsp; ' + fmtTime(c.dur) + '</span>' +
        '<h3 class="chapter__title"></h3>' +
        '<p class="chapter__desc"></p>';
      card.querySelector('.chapter__title').textContent = c.title;
      card.querySelector('.chapter__desc').textContent = c.desc;
      stageEl.appendChild(card);
      chapterEls.push(card);

      var li = document.createElement('li');
      li.className = 'rail__item';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail__btn';
      btn.setAttribute('data-index', String(i));
      btn.setAttribute('aria-label', 'Jump to ' + c.title);
      btn.innerHTML =
        '<span class="rail__n">' + c.n + '</span>' +
        '<span class="rail__t"></span>' +
        '<span class="rail__bar"><i></i></span>';
      btn.querySelector('.rail__t').textContent = c.title;
      li.appendChild(btn);
      railEl.appendChild(li);
      railBtns.push(btn);
    });

    railEl.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.rail__btn') : null;
      if (!btn) return;
      var i = parseInt(btn.getAttribute('data-index'), 10);
      if (isNaN(i) || !CLIPS[i]) return;
      scrollToFilmTime(CLIPS[i].start + 0.15);
    });
  }

  if (tcTotalEl) tcTotalEl.textContent = fmtTime(FILM_DURATION);

  /* ------------------------------------------------------------ media state */

  var mediaMode = 'idle';      /* idle | scrub | frames | autoplay | static */
  var videoReady = false;
  var videoMissing = false;
  var videoDuration = FILM_DURATION;

  var probe = { samples: 0, slow: 0, queue: [], log: [], born: 0 };

  function setMediaMode(mode) {
    mediaMode = mode;
    if (videoEl) {
      videoEl.classList.toggle('is-ready', mode === 'scrub' || mode === 'autoplay');
      videoEl.loop = (mode === 'autoplay');
    }
    if (framesEl) framesEl.classList.toggle('is-live', mode === 'frames');
    if (stateEl) {
      stateEl.textContent =
        mode === 'scrub'    ? 'Scrub' :
        mode === 'frames'   ? 'Frame index' :
        mode === 'autoplay' ? 'Playback' :
        mode === 'static'   ? 'Static' : 'Scrub';
    }
    if (mode === 'autoplay' && videoEl) {
      videoEl.muted = true;
      var pr = videoEl.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
  }

  function updateBadge() {
    if (!badgeEl) return;
    var show = videoMissing;
    badgeEl.hidden = !show;
    if (show) badgeEl.textContent = 'Render pending — no video file present';
  }

  function onVideoReady() {
    videoReady = true;
    videoMissing = false;
    probe.born = (window.performance && performance.now) ? performance.now() : 0;
    updateBadge();
    if (isFinite(videoEl.duration) && videoEl.duration > 0) videoDuration = videoEl.duration;
    if (tcTotalEl) tcTotalEl.textContent = fmtTime(videoDuration);
    if (motionOn) {
      setMediaMode('scrub');
      seekVideo(getProgress() * videoDuration);
    }
  }

  function onVideoError() {
    videoMissing = true;
    videoReady = false;
    updateBadge();
    if (mediaMode !== 'static') setMediaMode('static');
  }

  /* Some browsers never fire `error` on the <video> when every <source>
     fails; they only set networkState to NETWORK_NO_SOURCE (3). Watch for
     that too, with a short grace period so a legitimate reload is not
     mistaken for a missing file. */
  var missingSince = 0;
  function checkVideoHealth() {
    if (!videoEl || videoReady || videoMissing) return;
    var ns = videoEl.networkState;
    if (ns === 3) {
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      if (!missingSince) missingSince = now;
      else if (now - missingSince > 700) onVideoError();
    } else {
      missingSince = 0;
    }
  }

  if (videoEl) {
    videoEl.addEventListener('loadedmetadata', onVideoReady);
    videoEl.addEventListener('error', onVideoError);

    /* The 720p source is optional. If it 404s, drop it and let the browser
       pick the full-resolution file instead. */
    Array.prototype.forEach.call(videoEl.querySelectorAll('source'), function (src) {
      src.addEventListener('error', function () {
        if (src.media) {
          src.parentNode.removeChild(src);
          try { videoEl.load(); } catch (e) {}
        }
      });
    });

    /* Measure how long a seek takes and how close it lands. If the file is
       not keyframe-encoded the browser has to decode forward from the nearest
       keyframe, which is slow and lands off-target.

       `seeked` events are attributed back to the request that caused them:
       Chrome fires one `seeking`/`seeked` pair per request, but a request
       issued while another is still in flight can be superseded, so the
       landed time is matched against the queue of outstanding requests
       instead of assuming the last one won. */
    videoEl.addEventListener('seeked', function () {
      var landed = videoEl.currentTime;
      var now = (window.performance && performance.now) ? performance.now() : 0;
      var i, entry = null;

      seekState.inflight = false;

      for (i = 0; i < probe.queue.length; i++) {
        if (Math.abs(probe.queue[i].target - landed) <= 0.05) { entry = probe.queue.splice(i, 1)[0]; break; }
      }
      if (!entry && probe.queue.length) {
        /* The video landed somewhere we did not ask for — the server refused
           the byte range, or the file cannot be decoded to that point. That
           is exactly the failure this probe exists to catch, so score it
           against the oldest outstanding request. */
        entry = probe.queue.shift();
      }

      if (entry) {
        var latency = now - entry.start;
        var err = Math.abs(landed - entry.target);

        if (now - probe.born >= PROBE_WARMUP_MS && videoEl.readyState >= 3) {
          probe.samples++;
          if (probe.samples <= 24) {
            probe.log.push({ ms: +latency.toFixed(1), err: +err.toFixed(3), t: +entry.target.toFixed(2) });
          }
          if (latency > SEEK_SLOW_MS || err > SEEK_TOLERANCE) probe.slow++;
          if (probe.samples >= PROBE_SAMPLES && probe.slow >= PROBE_FAILURES && mediaMode === 'scrub') {
            degrade();
          }
        }
      }

      /* the scroll moved on while we were decoding — go to where we are now */
      if (seekState.hasLatest && mediaMode === 'scrub' && videoEl.readyState >= 3 &&
          Math.abs(videoEl.currentTime - seekState.latest) > 1 / 120) {
        issueSeek(seekState.latest);
      }
    });
  }

  function degrade() {
    if (frames.available()) {
      setMediaMode('frames');
    } else {
      /* No image sequence and the video cannot be scrubbed reliably:
         fall back to simply playing the film. */
      setMediaMode('autoplay');
    }
  }

  /* Seeking is serialised. Setting `currentTime` while a previous seek is
     still decoding aborts it, so a file that is not keyframe-encoded would
     never advance at all — every frame's request would cancel the last one.
     One seek in flight at a time; the newest requested time is remembered
     and issued as soon as the current seek lands. */
  var seekState = { inflight: false, target: 0, start: 0, latest: null, hasLatest: false };

  function issueSeek(t) {
    var now = (window.performance && performance.now) ? performance.now() : 0;
    seekState.inflight = true;
    seekState.target = t;
    seekState.start = now;
    probe.queue.push({ target: t, start: now });
    if (probe.queue.length > 8) probe.queue.shift();
    try { videoEl.currentTime = t; } catch (e) {}
  }

  function seekVideo(t) {
    if (!videoReady || !videoEl || mediaMode !== 'scrub') return;
    seekState.latest = t;
    seekState.hasLatest = true;
    if (seekState.inflight) return;                    /* wait for the current seek */
    if (Math.abs(videoEl.currentTime - t) < 1 / 120) { seekState.hasLatest = false; return; }
    issueSeek(t);
  }

  /* --------------------------------------------------------- frame scrubber
     Optional: a WebP/PNG image sequence lets us scrub by frame index when
     the mp4 cannot be seeked accurately. See README.md for the manifest. */

  var frames = (function () {
    var manifest = null;
    var cache = {};
    var order = [];
    var current = -1;
    var ctx = null;
    var ready = false;
    var pad = 4;

    function urlFor(i) {
      var n = i + (manifest.offset || 0);
      return manifest.pattern.replace(/\{index\}/g, String(n).padStart(pad, '0'));
    }

    function get(i) {
      if (cache[i]) return cache[i];
      var img = new Image();
      img.decoding = 'async';
      img.src = urlFor(i);
      cache[i] = img;
      order.push(i);
      while (order.length > FRAME_CACHE_SIZE) {
        var old = order.shift();
        if (old !== current) delete cache[old];
      }
      return img;
    }

    function preload(centre) {
      for (var k = 1; k <= 8; k++) {
        if (centre + k < manifest.count) get(centre + k);
        if (centre - k >= 0) get(centre - k);
      }
    }

    function drawCover(img, w, h) {
      var iw = img.naturalWidth || img.width;
      var ih = img.naturalHeight || img.height;
      if (!iw || !ih) return;
      var scale = Math.max(w / iw, h / ih);
      var dw = iw * scale, dh = ih * scale;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }

    function resize() {
      if (!framesEl) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.max(1, Math.round(framesEl.clientWidth * dpr));
      var h = Math.max(1, Math.round(framesEl.clientHeight * dpr));
      if (framesEl.width !== w || framesEl.height !== h) {
        framesEl.width = w; framesEl.height = h;
      }
      if (!ctx) ctx = framesEl.getContext('2d');
    }

    function finish(m) {
      if (!m || !m.count || !m.fps) return;
      manifest = m;
      manifest.pattern = String(m.pattern || 'public/frames/frame_{index}.webp');
      manifest.offset = Number(m.offset) || 0;
      pad = Math.max(4, String(Math.max(1, manifest.count - 1 + manifest.offset)).length);
      ready = true;
      resize();
    }

    return {
      available: function () { return ready; },
      init: function () {
        var inline = document.getElementById('frames-manifest');
        if (inline) {
          try { finish(JSON.parse(inline.textContent)); } catch (e) {}
        }
        if (!ready && window.fetch) {
          fetch('public/frames/manifest.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(finish)
            .catch(function () {});
        }
      },
      render: function (t) {
        if (!ready) return;
        resize();
        if (!ctx) ctx = framesEl.getContext('2d');
        var idx = clamp(Math.round(t * manifest.fps), 0, manifest.count - 1);
        if (idx === current) return;
        current = idx;
        var img = get(idx);
        var paint = function () {
          if (!ctx || current !== idx) return;
          ctx.clearRect(0, 0, framesEl.width, framesEl.height);
          drawCover(img, framesEl.width, framesEl.height);
        };
        if (img.complete && img.naturalWidth) paint();
        else img.onload = paint;
        preload(idx);
      },
      reset: function () { current = -1; }
    };
  })();

  frames.init();

  /* ------------------------------------------------------------ scroll engine */

  var hasGSAP = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  var hasLenis = typeof window.Lenis !== 'undefined';
  var lenis = null;
  var proxy = { p: 0 };
  var scrollTrigger = null;

  if (!hasGSAP) root.classList.add('no-gsap');

  if (hasGSAP) {
    gsap.registerPlugin(ScrollTrigger);

    var tl = gsap.timeline({
      scrollTrigger: {
        trigger: filmEl,
        start: 'top top',
        end: 'bottom bottom',
        pin: pinEl,
        pinSpacing: false,
        scrub: true,
        invalidateOnRefresh: true,
        anticipatePin: 1
      }
    });
    tl.to(proxy, { p: 1, ease: 'none', duration: 1 });
    scrollTrigger = tl.scrollTrigger;
  }

  if (hasLenis && hasGSAP) {
    lenis = new Lenis({
      duration: 1.05,
      smoothWheel: true,
      touchMultiplier: 1.6,
      wheelMultiplier: 1
    });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  function filmScrollLength() {
    return Math.max(1, filmEl.offsetHeight - window.innerHeight);
  }

  function getProgress() {
    if (hasGSAP) return clamp(proxy.p, 0, 1);
    var r = filmEl.getBoundingClientRect();
    return clamp(-r.top / filmScrollLength(), 0, 1);
  }

  function scrollToFilmTime(t) {
    var p = clamp(t / FILM_DURATION, 0, 1);
    var top = filmEl.getBoundingClientRect().top + (window.pageYOffset || 0);
    var y = top + p * filmScrollLength();
    if (lenis) lenis.scrollTo(y, { duration: 1.15 });
    else window.scrollTo({ top: y, behavior: motionOn ? 'smooth' : 'auto' });
  }

  /* smooth in-page navigation */
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = a.getAttribute('href');
    if (!id || id === '#') return;
    var target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: -1, duration: 1.1 });
    else target.scrollIntoView({ behavior: motionOn ? 'smooth' : 'auto', block: 'start' });
    if (history.replaceState) history.replaceState(null, '', id);
  });

  /* ------------------------------------------------------------- frame loop */

  var lastProgress = -1;
  var lastAccent = '';
  var lastTimeLabel = '';
  var lastChapter = -1;

  function accentAt(p) {
    for (var i = 0; i < ACCENT_STOPS.length - 1; i++) {
      var a = ACCENT_STOPS[i], b = ACCENT_STOPS[i + 1];
      if (p <= b[0]) {
        var t = smoothstep(a[0], b[0], p);
        return [
          Math.round(lerp(a[1], b[1], t)),
          Math.round(lerp(a[2], b[2], t)),
          Math.round(lerp(a[3], b[3], t))
        ];
      }
    }
    var last = ACCENT_STOPS[ACCENT_STOPS.length - 1];
    return [last[1], last[2], last[3]];
  }

  function applyAccent(p) {
    var rgb = accentAt(p);
    var key = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    if (key === lastAccent) return;
    lastAccent = key;
    root.style.setProperty('--accent', 'rgb(' + key + ')');
    root.style.setProperty('--accent-rgb', key);
    if (fx && fx.setAccent) fx.setAccent(rgb);
  }

  function applyChapters(filmT) {
    var active = -1;
    for (var i = 0; i < CLIPS.length; i++) {
      var c = CLIPS[i];
      var local = (filmT - c.start) / Math.max(0.001, (c.end - c.start));
      var cel = chapterEls[i];
      if (cel) {
        var a = smoothstep(0.0, 0.10, local) * (1 - smoothstep(0.86, 1.0, local));
        cel.style.opacity = a.toFixed(3);
        cel.style.transform = 'translate3d(0,' + ((1 - a) * 22).toFixed(2) + 'px,0)';
      }
      var btn = railBtns[i];
      if (btn) {
        var on = filmT >= c.start && filmT < c.end;
        if (on) active = i;
        btn.classList.toggle('is-active', on);
        var bar = btn.querySelector('.rail__bar i');
        if (bar) {
          var fill = clamp((filmT - c.start) / Math.max(0.001, (c.end - c.start)), 0, 1);
          bar.style.transform = 'scaleX(' + fill.toFixed(3) + ')';
        }
      }
    }
    if (active !== lastChapter) {
      lastChapter = active;
      if (stageEl) stageEl.setAttribute('data-active-clip', active >= 0 ? CLIPS[active].title : '');
    }
  }

  function applyReveal(y) {
    var vh = window.innerHeight || 1;

    var heads = document.querySelectorAll('[data-reveal="headline"]');
    var bodies = document.querySelectorAll('[data-reveal="body"]');
    var hero = document.querySelector('.hero__content');

    /* Motion off: nothing is revealed, nothing moves, nothing fades. */
    if (!motionOn) {
      root.style.setProperty('--nav-in', '1');
      if (navEl) navEl.classList.add('is-live');
      Array.prototype.forEach.call(heads, function (el) {
        el.style.opacity = '1'; el.style.transform = 'none';
      });
      Array.prototype.forEach.call(bodies, function (el) {
        el.style.opacity = '1'; el.style.transform = 'none';
      });
      if (hero) { hero.style.opacity = '1'; hero.style.transform = 'none'; }
      return;
    }

    var reveal = clamp(y / (0.10 * vh), 0, 1);       /* the first 10% of a screen */
    var headline = smoothstep(0.00, 0.42, reveal);
    var body = smoothstep(0.34, 0.72, reveal);
    var navIn = smoothstep(0.60, 1.00, reveal);

    Array.prototype.forEach.call(heads, function (el) {
      el.style.opacity = (0.52 + 0.48 * headline).toFixed(3);
      el.style.transform = 'translate3d(0,' + ((1 - headline) * 18).toFixed(2) + 'px,0)';
    });
    Array.prototype.forEach.call(bodies, function (el) {
      el.style.opacity = body.toFixed(3);
      el.style.transform = 'translate3d(0,' + ((1 - body) * 14).toFixed(2) + 'px,0)';
    });

    root.style.setProperty('--nav-in', navIn.toFixed(3));
    if (navEl) navEl.classList.toggle('is-live', navIn > 0.5);

    /* the hero hands off to the film */
    var heroOut = smoothstep(0.30 * vh, 1.05 * vh, y);
    if (hero) {
      hero.style.opacity = (1 - heroOut).toFixed(3);
      hero.style.transform = 'translate3d(0,' + (-heroOut * 46).toFixed(2) + 'px,0)';
    }
  }

  function tick() {
    var p = getProgress();
    var y = window.pageYOffset || window.scrollY || 0;

    applyReveal(y);
    checkVideoHealth();

    /* watchdog: a seek that never reports back must not freeze the film */
    if (seekState.inflight && videoEl && videoReady) {
      var nowMs = (window.performance && performance.now) ? performance.now() : 0;
      if (nowMs - seekState.start > 2500) {
        seekState.inflight = false;
        if (mediaMode === 'scrub' && seekState.hasLatest) issueSeek(seekState.latest);
      }
    }

    if (Math.abs(p - lastProgress) < 0.00001) return;
    lastProgress = p;

    applyAccent(p);

    var filmT = p * FILM_DURATION;
    var mediaT = p * videoDuration;

    if (motionOn) {
      if (mediaMode === 'frames') {
        frames.render(filmT);
      } else if (mediaMode === 'scrub') {
        seekVideo(mediaT);
      } else if (mediaMode === 'autoplay' && videoEl) {
        mediaT = videoEl.currentTime;
        filmT = (videoDuration > 0 ? mediaT / videoDuration : 0) * FILM_DURATION;
      }
    }

    applyChapters(filmT);

    var label = fmtTime(filmT);
    if (label !== lastTimeLabel) {
      lastTimeLabel = label;
      if (tcNowEl) tcNowEl.textContent = label;
    }

    if (fx && fx.setScroll) fx.setScroll(p);
  }

  var running = false;
  function startLoop() {
    if (running) return;
    running = true;
    if (hasGSAP) gsap.ticker.add(tick);
    else (function loop() { tick(); requestAnimationFrame(loop); })();
  }

  window.addEventListener('resize', function () {
    if (scrollTrigger && scrollTrigger.refresh) scrollTrigger.refresh();
    if (fx && fx.resize) fx.resize();
    frames.reset();
  }, { passive: true });

  /* --------------------------------------------------------- the WebGL layer */

  var fx = (function () {
    var canvas = fxEl;
    if (!canvas) return null;

    var gl = null, progPoints = null, progLight = null;
    var bufRand = null, bufSize = null, bufDepth = null, bufQuad = null;
    var uni = {}, lightUni = {};
    var count = 320;
    var dpr = 1;
    var cursor = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, active: 0, tactive: 0 };
    var accent = [224, 200, 138];
    var scroll = 0;
    var raf = 0;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var live = false;
    var visible = true;

    var VS_POINTS = [
      'attribute vec2 aRand;',
      'attribute float aSize;',
      'attribute float aDepth;',
      'uniform float uTime;',
      'uniform float uScroll;',
      'uniform float uDpr;',
      'varying float vFade;',
      'void main() {',
      '  float x = aRand.x * 2.0 - 1.0;',
      '  float y = aRand.y * 2.0 - 1.0;',
      '  float t = uTime;',
      '  y += sin(t * (0.05 + aRand.x * 0.08) + aRand.y * 6.2831) * 0.13 * (0.35 + aDepth);',
      '  x += cos(t * (0.04 + aRand.y * 0.06) + aRand.x * 6.2831) * 0.055;',
      '  y += uScroll * (0.55 + aDepth * 1.75);',
      '  y = mod(y + 1.0, 2.0) - 1.0;',
      '  gl_Position = vec4(x, y, 0.0, 1.0);',
      '  float breathe = 0.65 + 0.35 * sin(t * 0.7 + aRand.x * 12.0);',
      '  gl_PointSize = aSize * uDpr * breathe;',
      '  vFade = (0.26 + 0.74 * aRand.y) * (0.40 + 0.60 * aDepth);',
      '}'
    ].join('\n');

    var FS_POINTS = [
      'precision mediump float;',
      'uniform vec3 uAccent;',
      'uniform float uIntensity;',
      'varying float vFade;',
      'void main() {',
      '  vec2 c = gl_PointCoord - vec2(0.5);',
      '  float d = length(c);',
      '  float a = smoothstep(0.5, 0.0, d);',
      '  a = pow(a, 2.4);',
      '  float alpha = a * vFade * uIntensity;',
      '  if (alpha < 0.003) discard;',
      '  vec3 col = mix(uAccent, vec3(1.0), 0.42);',
      '  gl_FragColor = vec4(col * alpha, alpha);',
      '}'
    ].join('\n');

    var VS_QUAD = [
      'attribute vec2 aPos;',
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = aPos * 0.5 + 0.5;',
      '  gl_Position = vec4(aPos, 0.0, 1.0);',
      '}'
    ].join('\n');

    var FS_LIGHT = [
      'precision mediump float;',
      'uniform vec2 uCursor;',
      'uniform float uAspect;',
      'uniform vec3 uAccent;',
      'uniform float uIntensity;',
      'varying vec2 vUv;',
      'void main() {',
      '  vec2 d = vUv - (uCursor * 0.5 + 0.5);',
      '  d.x *= uAspect;',
      '  float r = length(d);',
      '  float g = exp(-r * r * 7.0);',
      '  float a = g * uIntensity * 0.40;',
      '  if (a < 0.002) discard;',
      '  gl_FragColor = vec4(uAccent * a, a);',
      '}'
    ].join('\n');

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        if (window.console) console.warn('[descent] shader error', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    }

    function makeProgram(vs, fs) {
      var v = compile(gl.VERTEX_SHADER, vs);
      var f = compile(gl.FRAGMENT_SHADER, fs);
      if (!v || !f) return null;
      var p = gl.createProgram();
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        if (window.console) console.warn('[descent] link error', gl.getProgramInfoLog(p));
        return null;
      }
      return p;
    }

    function init() {
      var opts = { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' };
      try { gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts); }
      catch (e) { gl = null; }
      if (!gl) return false;

      progPoints = makeProgram(VS_POINTS, FS_POINTS);
      progLight = makeProgram(VS_QUAD, FS_LIGHT);
      if (!progPoints || !progLight) return false;

      var rand = new Float32Array(count * 2);
      var size = new Float32Array(count);
      var depth = new Float32Array(count);
      for (var i = 0; i < count; i++) {
        rand[i * 2] = Math.random();
        rand[i * 2 + 1] = Math.random();
        size[i] = 1.1 + Math.random() * 4.4;
        depth[i] = Math.random();
      }

      bufRand = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufRand);
      gl.bufferData(gl.ARRAY_BUFFER, rand, gl.STATIC_DRAW);

      bufSize = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufSize);
      gl.bufferData(gl.ARRAY_BUFFER, size, gl.STATIC_DRAW);

      bufDepth = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufDepth);
      gl.bufferData(gl.ARRAY_BUFFER, depth, gl.STATIC_DRAW);

      bufQuad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

      uni = {
        aRand: gl.getAttribLocation(progPoints, 'aRand'),
        aSize: gl.getAttribLocation(progPoints, 'aSize'),
        aDepth: gl.getAttribLocation(progPoints, 'aDepth'),
        uTime: gl.getUniformLocation(progPoints, 'uTime'),
        uScroll: gl.getUniformLocation(progPoints, 'uScroll'),
        uDpr: gl.getUniformLocation(progPoints, 'uDpr'),
        uAccent: gl.getUniformLocation(progPoints, 'uAccent'),
        uIntensity: gl.getUniformLocation(progPoints, 'uIntensity')
      };
      lightUni = {
        aPos: gl.getAttribLocation(progLight, 'aPos'),
        uCursor: gl.getUniformLocation(progLight, 'uCursor'),
        uAspect: gl.getUniformLocation(progLight, 'uAspect'),
        uAccent: gl.getUniformLocation(progLight, 'uAccent'),
        uIntensity: gl.getUniformLocation(progLight, 'uIntensity')
      };

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.disable(gl.DEPTH_TEST);
      resize();
      return true;
    }

    function resize() {
      if (!gl) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    }

    function draw(time) {
      if (!gl) return;
      resize();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      var w = canvas.width, h = canvas.height;
      var aspect = w / Math.max(1, h);
      var acc = [accent[0] / 255, accent[1] / 255, accent[2] / 255];

      /* cursor light */
      gl.useProgram(progLight);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
      gl.enableVertexAttribArray(lightUni.aPos);
      gl.vertexAttribPointer(lightUni.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3f(lightUni.uAccent, acc[0], acc[1], acc[2]);
      gl.uniform2f(lightUni.uCursor, (cursor.x * 2 - 1), (1 - cursor.y * 2));
      gl.uniform1f(lightUni.uAspect, aspect);
      gl.uniform1f(lightUni.uIntensity, cursor.active);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      /* motes */
      gl.useProgram(progPoints);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufRand);
      gl.enableVertexAttribArray(uni.aRand);
      gl.vertexAttribPointer(uni.aRand, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufSize);
      gl.enableVertexAttribArray(uni.aSize);
      gl.vertexAttribPointer(uni.aSize, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufDepth);
      gl.enableVertexAttribArray(uni.aDepth);
      gl.vertexAttribPointer(uni.aDepth, 1, gl.FLOAT, false, 0, 0);
      gl.uniform3f(uni.uAccent, acc[0], acc[1], acc[2]);
      gl.uniform1f(uni.uTime, time);
      gl.uniform1f(uni.uScroll, scroll);
      gl.uniform1f(uni.uDpr, dpr);
      gl.uniform1f(uni.uIntensity, 0.85);
      gl.drawArrays(gl.POINTS, 0, count);
    }

    function loop() {
      raf = requestAnimationFrame(loop);
      if (!visible) return;
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var t = (now - t0) / 1000;
      cursor.x += (cursor.tx - cursor.x) * 0.08;
      cursor.y += (cursor.ty - cursor.y) * 0.08;
      cursor.active += (cursor.tactive - cursor.active) * 0.06;
      draw(t);
    }

    function onMove(e) {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var x = (e.clientX - r.left) / r.width;
      var y = (e.clientY - r.top) / r.height;
      var inside = x >= -0.3 && x <= 1.3 && y >= -0.3 && y <= 1.3;
      cursor.tx = clamp(x, 0, 1);
      cursor.ty = clamp(y, 0, 1);
      cursor.tactive = inside ? 1 : 0;
    }

    return {
      init: function () {
        if (!init()) { canvas.classList.remove('is-live'); return; }
        live = true;
        window.addEventListener('pointermove', onMove, { passive: true });
        window.addEventListener('pointerdown', onMove, { passive: true });
        if (window.IntersectionObserver) {
          new IntersectionObserver(function (entries) {
            visible = entries[0].isIntersecting;
          }, { threshold: 0 }).observe(filmEl);
        }
        this.start();
      },
      start: function () {
        if (!live || raf) return;
        canvas.classList.add('is-live');
        raf = requestAnimationFrame(loop);
      },
      stop: function () {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        canvas.classList.remove('is-live');
      },
      resize: resize,
      setAccent: function (rgb) { accent = rgb; },
      setScroll: function (p) { scroll = p; }
    };
  })();

  /* --------------------------------------------------- the render manifest
     `public/video/manifest.json` is written by the generation pipeline. If
     it is there, the credits section quotes the model that actually made
     the film instead of a guess. If it is not, the copy in the HTML stands. */

  var MODEL_NAMES = {
    seedance_2_5: 'Seedance 2.5',
    seedance_2_5_fast: 'Seedance 2.5',
    cinema_studio_4_0: 'Cinema Studio 4.0',
    kling_4_0: 'Kling 4.0',
    kling_4_0_flash: 'Kling 4.0 Flash',
    veo_3_1: 'Veo 3.1',
    wan_3_0: 'WAN 3.0',
    wan_3_0_prime: 'WAN 3.0 Prime'
  };

  function readRenderManifest() {
    if (!window.fetch) return;
    fetch('public/video/manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        if (!m) return;
        var modelEl = $('render-model');
        var resEl = $('render-res');
        var fpsEl = $('render-fps');
        if (modelEl && m.model) {
          modelEl.textContent = MODEL_NAMES[m.model] || String(m.model).replace(/_/g, ' ');
        }
        if (resEl && m.resolution) resEl.textContent = m.resolution;
        if (fpsEl && m.fps) fpsEl.textContent = m.fps + ' fps';
      })
      .catch(function () {});
  }

  /* ------------------------------------------------------------------ start */

  if (fx && fx.init) fx.init();

  /* The <video> element starts loading while the parser is still running, so
     `loadedmetadata` may already have fired before this script ran. */
  if (videoEl) {
    if (videoEl.readyState >= 1) onVideoReady();
    else if (videoEl.error) onVideoError();
  }

  applyMotionState();
  startLoop();
  tick();
  readRenderManifest();

  window.addEventListener('load', function () {
    if (hasGSAP && ScrollTrigger.refresh) ScrollTrigger.refresh();
    tick();
  });

  /* A tiny surface for debugging / review. */
  window.Descent = {
    get progress() { return lastProgress; },
    get mode() { return mediaMode; },
    get clips() { return CLIPS; },
    get duration() { return FILM_DURATION; },
    get lenis() { return lenis; },
    get probe() { return probe; },
    seek: function (t) { scrollToFilmTime(t); },
    scrollTo: function (y, immediate) {
      if (lenis) lenis.scrollTo(y, { immediate: !!immediate, duration: 1.1 });
      else window.scrollTo({ top: y, behavior: 'auto' });
    }
  };
})();
