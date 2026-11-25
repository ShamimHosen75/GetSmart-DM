/* SIDM home page: scroll reveals, number count-up and the "How to use" demo.
   Plain JavaScript, no libraries. The page works fully without it. */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var STEP_MS = 4200;

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

  /* ---------- How-to demo ---------- */
  function setupDemo(root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
    var current = 0;
    var timer = null;
    var playing = !reduce;
    var visible = false;
    var hovered = false;

    root.classList.add('ready');

    function panel() { return panels[current]; }

    function go(step) {
      var p = panel();
      var n = p.querySelectorAll('.demo-step').length;
      step = ((step % n) + n) % n;
      p.setAttribute('data-step', String(step));
      p.querySelectorAll('.demo-step').forEach(function (b, i) {
        if (i === step) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      });
      // restart the step bar animation
      p.classList.remove('tick');
      void p.offsetWidth;
      if (running()) p.classList.add('tick');
      schedule();
    }

    function running() { return playing && visible && !hovered && !document.hidden; }

    function schedule() {
      clearTimeout(timer);
      root.classList.toggle('auto', running());
      if (!running()) { panel().classList.remove('tick'); return; }
      timer = setTimeout(function () {
        go(+panel().getAttribute('data-step') + 1);
      }, STEP_MS);
    }

    function select(i, focus) {
      current = i;
      tabs.forEach(function (t, j) {
        var on = j === i;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
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
          playing = false; // the visitor took over
          go(+b.getAttribute('data-go'));
        });
      });
      // "Try it" hot spots inside the mock: each one moves to the step it names.
      p.querySelectorAll('[data-hot]').forEach(function (h) {
        h.addEventListener('click', function () {
          playing = false;
          go(+h.getAttribute('data-hot'));
        });
      });
    });

    var stage = root;
    stage.addEventListener('mouseenter', function () { hovered = true; schedule(); });
    stage.addEventListener('mouseleave', function () { hovered = false; schedule(); });
    document.addEventListener('visibilitychange', schedule);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) go(+panel().getAttribute('data-step'));
        else schedule();
      }, { threshold: 0.35 }).observe(root);
    }

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
