/* SIDM home page: scroll reveals, number count-up and the "How to use" demo.
   Plain JavaScript, no libraries. The page works fully without it. */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Scroll reveal ---------- */
  var revealSel = [
    '.products .product-card', '.stat-list li', '.how .section-head', '.demo',
    'section .section-head', '.part-banner .wrap', '.cards .card', '.flow li',
    '.shot', '.steps .step', '.use-list li', '.guide-card', '.faq details'
  ].join(',');

  function setupReveal() {
    if (reduce || !('IntersectionObserver' in window)) return;
    var items = document.querySelectorAll(revealSel);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) {
      var sibs = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
      el.style.setProperty('--d', Math.min(sibs, 6) * 70 + 'ms');
      el.classList.add('reveal');
      io.observe(el);
    });
  }

  /* ---------- Count-up numbers ---------- */
  function setupCounters() {
    var nums = document.querySelectorAll('[data-count]');
    if (reduce || !nums.length || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        var el = e.target;
        var end = +el.getAttribute('data-count');
        var suffix = el.getAttribute('data-suffix') || '';
        if (!end) return;
        var t0 = null;
        function tick(t) {
          if (t0 === null) t0 = t;
          var k = Math.min((t - t0) / 1200, 1);
          k = 1 - Math.pow(1 - k, 3);
          el.textContent = Math.round(end * k).toLocaleString('en-US') + (k === 1 ? suffix : '');
          if (k < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.6 });
    nums.forEach(function (n) { io.observe(n); });
  }

  /* ---------- Pause decorative loops while off screen ---------- */
  function setupPause() {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('paused', !e.isIntersecting); });
    });
    document.querySelectorAll('.hero, .marquee').forEach(function (el) { io.observe(el); });
  }

  /* ---------- How-to demo ----------
     Plays like a screen recording: on each step a pointer glides to the
     button that step is about, clicks it, and the next step follows.
     Visitors can click a step or a glowing spot themselves (that pauses
     the tour), and the Pause / Play button stops or restarts it. */
  function setupDemo(root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
    var toggle = root.querySelector('.demo-toggle');
    var current = 0;
    var playing = true;
    var visible = !('IntersectionObserver' in window);
    var run = 0; // bumps on every change, so an old sequence stops itself
    var timers = [];
    var STATES = ['playing', 'installing'];

    root.classList.add('ready');

    function panel() { return panels[current]; }
    function count(p) { return p.querySelectorAll('.demo-step').length; }
    function stepOf(p) { return +p.getAttribute('data-step'); }

    function clear() {
      run++;
      timers.forEach(clearTimeout);
      timers = [];
    }

    function later(ms, id, fn) {
      timers.push(setTimeout(function () { if (id === run) fn(); }, ms));
    }

    function shownIn(el, p, n) {
      for (var a = el; a && a !== p; a = a.parentElement) {
        if (a.classList.contains('sc') && !a.classList.contains('sc' + n)) return false;
      }
      return true;
    }

    function hotFor(p, n) {
      // the spot that leads on from this step (n + 1, or back to 0 after the last)
      var next = n + 1 >= count(p) ? 0 : n + 1;
      var all = p.querySelectorAll('[data-hot="' + next + '"]');
      for (var i = 0; i < all.length; i++) if (shownIn(all[i], p, n)) return all[i];
      return null;
    }

    function pointerOf(p) { return p.querySelector('.mk-pointer'); }

    function hidePointer(p) {
      var ptr = pointerOf(p);
      if (ptr) ptr.classList.remove('show', 'press');
    }

    function movePointer(p, el, glide) {
      var ptr = pointerOf(p);
      if (!ptr || !el) return;
      var stage = ptr.parentElement.getBoundingClientRect();
      var r = el.getBoundingClientRect();
      var x = r.left - stage.left + r.width * 0.55;
      var y = r.top - stage.top + r.height * 0.6;
      if (!ptr.classList.contains('show')) {
        // enter from the lower right corner of the stage
        ptr.style.transition = 'none';
        ptr.style.transform = 'translate(' + (stage.width - 40) + 'px,' + (stage.height - 40) + 'px)';
        void ptr.offsetWidth;
        ptr.style.transition = '';
        ptr.classList.add('show');
      }
      ptr.classList.toggle('jump', !glide);
      ptr.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }

    function setBar(p, n, ms) {
      p.querySelectorAll('.demo-bar').forEach(function (bar, i) {
        bar.classList.remove('run');
        bar.style.animationDuration = '';
        if (i === n && ms) {
          void bar.offsetWidth;
          bar.style.animationDuration = ms + 'ms';
          bar.classList.add('run');
        }
      });
    }

    function show(n) {
      var p = panel();
      var total = count(p);
      n = ((n % total) + total) % total;
      p.setAttribute('data-step', String(n));
      STATES.forEach(function (c) { p.classList.remove(c); });
      p.querySelectorAll('.demo-step').forEach(function (b, i) {
        if (i === n) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      });
      return n;
    }

    function go(n) {
      clear();
      n = show(n);
      var p = panel();
      if (!(playing && visible && !document.hidden)) {
        hidePointer(p);
        setBar(p, -1);
        root.classList.remove('auto');
        return;
      }
      root.classList.add('auto');
      var id = run;
      var last = n === count(p) - 1;
      var hot = hotFor(p, n);
      var dwell = last ? 2600 : 1200;
      var glideMs = reduce ? 0 : 750;
      var after = hot && hot.getAttribute('data-after') ? +hot.getAttribute('data-after') : 300;
      setBar(p, n, dwell + glideMs + 300 + after);
      later(dwell, id, function () {
        movePointer(p, hot, !reduce);
        later(glideMs + 50, id, function () {
          var ptr = pointerOf(p);
          if (ptr) ptr.classList.add('press');
          if (hot) hot.classList.add('pressed');
          later(250, id, function () {
            if (ptr) ptr.classList.remove('press');
            if (hot) hot.classList.remove('pressed');
            var state = hot && hot.getAttribute('data-state');
            if (state) p.classList.add(state);
            later(after, id, function () {
              if (last) hidePointer(p);
              go(hot ? +hot.getAttribute('data-hot') : n + 1);
            });
          });
        });
      });
    }

    function setPlaying(on) {
      playing = on;
      if (toggle) {
        toggle.querySelector('.dt-label').textContent = on ? 'Pause demo' : 'Play demo';
        toggle.classList.toggle('is-paused', !on);
      }
    }

    function select(i, focus) {
      current = i;
      tabs.forEach(function (t, j) {
        var on = j === i;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
        if (!on) { clear(); hidePointer(panels[j]); }
      });
      if (focus) tabs[i].focus();
      go(0);
    }

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i); });
      t.addEventListener('keydown', function (e) {
        var k = e.key;
        var j = k === 'ArrowRight' ? i + 1 : k === 'ArrowLeft' ? i - 1 : k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : null;
        if (j === null) return;
        e.preventDefault();
        select((j + tabs.length) % tabs.length, true);
      });
    });

    panels.forEach(function (p) {
      p.querySelectorAll('.demo-step').forEach(function (b) {
        b.addEventListener('click', function () {
          setPlaying(false); // the visitor took over
          go(+b.getAttribute('data-go'));
        });
      });
      p.querySelectorAll('[data-hot]').forEach(function (h) {
        h.addEventListener('click', function () {
          setPlaying(false);
          var state = h.getAttribute('data-state');
          var to = +h.getAttribute('data-hot');
          if (state) {
            clear();
            p.classList.add(state);
            var id = run;
            later(+h.getAttribute('data-after') || 0, id, function () { go(to); });
          } else {
            go(to);
          }
        });
      });
    });

    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener('click', function () {
        setPlaying(!playing);
        go(stepOf(panel()));
      });
    }

    document.addEventListener('visibilitychange', function () { go(stepOf(panel())); });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        var was = visible;
        visible = entries[0].isIntersecting;
        if (visible !== was) go(stepOf(panel()));
      }, { threshold: 0.2 }).observe(root);
    }

    setPlaying(true);
    select(0);
  }

  function init() {
    setupReveal();
    setupCounters();
    setupPause();
    var demo = document.querySelector('[data-demo]');
    if (demo) setupDemo(demo);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
