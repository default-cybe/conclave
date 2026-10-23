/*
 * Conclave in detail (details.html): the feature knots and their moments,
 * the hub diagram, the counters, the compare picker. The knot engine and the
 * page basics come from base.js, which runs first. Nothing here makes a
 * request or stores anything.
 */
(function () {
'use strict';

var C = window.Conclave;
if (!C) return;
var $ = C.$;
var $$ = C.$$;
var io = C.io;
var Knot = C.Knot;
var ropeMoment = C.ropeMoment;
var statusMoment = C.statusMoment;
var ropeRest = C.ropeRest;
var motionOK = C.motionOK;
var knots = C.knots;
var whenSeen = C.whenSeen;
var near = C.near;
var onScreen = C.onScreen;

// ---- reveals

C.reveal('.card, .feature-text > *, .feature > .shot, .limits > li, .hub figcaption');
C.onceIn('.thread', 0);
C.onceIn('.phones-wrap', 0.25);
C.onceIn('.next-wrap', 0.3);

// ---- counters

$$('.stat .v').forEach(function (v) {
  var target = Number(v.dataset.count);
  var dec = Number(v.dataset.dec || 0);
  var stat = v.closest('.stat');
  var done = false;
  var obs = io(function (entries) {
    if (!entries[0].isIntersecting || done) return;
    done = true;
    obs.disconnect();
    if (!motionOK()) return;
    var t0 = 0;
    v.textContent = (0).toFixed(dec);
    var tick = function (now) {
      if (!t0) t0 = now;
      var k = C.clamp((now - t0) / 900);
      v.textContent = (target * C.easeOutCubic(k)).toFixed(dec);
      if (k < 1 && motionOK()) requestAnimationFrame(tick);
      else v.textContent = target.toFixed(dec);
    };
    requestAnimationFrame(tick);
  }, { threshold: 0.6 });
  if (obs) obs.observe(stat);
});

// ---- the feature knots: the moment each feature is about, as the app uses it

var central = null;
var centerIO = io(function (entries) {
  entries.forEach(function (e) {
    if (e.isIntersecting) central = e.target;
    else if (central === e.target) central = null;
  });
  knots.forEach(function (k) { k.wake(); });
}, { rootMargin: '-38% 0px -38% 0px' });

// a second opinion's words, wrapped so they can stream in
$$('.m-say').forEach(function (p) {
  p.innerHTML = p.textContent.split(' ').map(function (w, i) { return '<span style="--w:' + i + '">' + w + ' </span>'; }).join('');
});

var REST = { state: 'brand', loop: false, dur: 0, pose: ropeRest, end: ropeRest };

$$('.f-knot').forEach(function (host) { near(host, function () { featureKnot(host); }); });
function featureKnot(host) {
  var kind = host.dataset.knot;
  var article = host.closest('.feature');
  var shot = $('.shot', article);
  var k = new Knot(host, { size: 32 });
  knots.push(k);
  // the screenshot's moment: the ring, the lifted part, and an approval answered
  whenSeen(shot, function () {
    shot.classList.add('go');
    if (!motionOK()) return;
    if (kind === 'waiting') setTimeout(function () { if (motionOK()) k.play(ropeMoment('success')); }, 2100);
    setTimeout(function () { shot.classList.add('done'); }, 3200);
  }, 0.45);
  if (kind === 'thinking' || kind === 'tool' || kind === 'run') {
    var m = kind === 'run' ? ropeMoment('run') : statusMoment(kind);
    // at most one looping knot: the feature nearest the middle of the screen
    k.gate = function () { return central === article; };
    if (centerIO) centerIO.observe(article);
    else k.gate = function () { return true; };
    if (motionOK()) {
      k.hold(m);
      k.ended = false;
      k.wake();
    } else k.play(m);
    return;
  }
  if (kind === 'waiting') {
    k.play(statusMoment('waiting'));
    return;
  }
  if (kind === 'receive' || kind === 'success') {
    k.hold(ropeMoment(kind));
    whenSeen(host, function () { k.play(ropeMoment(kind)); });
    return;
  }
  if (kind === 'send') {
    // a share leaves, then one arrives: send, 400ms, receive. Once a visit.
    k.play(REST);
    whenSeen(host, function () {
      if (!motionOK()) return;
      k.play(ropeMoment('send'), function () {
        if (!motionOK()) return k.play(REST);
        k.hold(ropeMoment('receive'));
        setTimeout(function () { k.play(ropeMoment('receive')); }, 400);
      });
    });
  }
}

// ---- the hub diagram: lines draw from the hub, then it ties, then the streams

$$('.hub-knot').forEach(function (host) { near(host.parentElement, function () { hubKnot(host); }); });
function hubKnot(host) {
  var box = host.parentElement;
  var fig = box.closest('.hub');
  var k = new Knot(host, { size: 120 });
  knots.push(k);
  var run = ropeMoment('run');
  k.gate = function () { return k.seen; };
  onScreen(box, k);
  k.play(REST);
  whenSeen(box, function () {
    if (box.offsetParent === null) return;
    fig.classList.add('drawn');
    if (!motionOK()) return;
    k.play(run);
    // the last line lands 5 x 120ms + 700ms after the first starts
    setTimeout(function () {
      k.play(ropeMoment('success'), function () { fig.classList.add('flow'); });
    }, 1300);
  });
}

// ---- also in the box: a faint light follows a fine pointer

if (C.mq('(hover: hover) and (pointer: fine)').matches) {
  var spot = null;
  var spotXY = null;
  document.addEventListener('pointermove', function (e) {
    var card = e.target.closest && e.target.closest('.more .card');
    if (!card) return;
    spotXY = [e.clientX, e.clientY, card];
    if (spot) return;
    spot = requestAnimationFrame(function () {
      spot = null;
      var c = spotXY[2];
      var r = c.getBoundingClientRect();
      c.style.setProperty('--x', Math.round(spotXY[0] - r.left) + 'px');
      c.style.setProperty('--y', Math.round(spotXY[1] - r.top) + 'px');
    });
  }, { passive: true });
}

// ---- compare: pick one product on small screens, and a fade at the open edge

(function compare() {
  var wrap = $('.compare-wrap');
  if (!wrap) return;
  var section = wrap.closest('section');
  var picker = $('.picker', section);
  var buttons = $$('button', picker);
  var small = C.mq('(max-width: 999px)');
  // rows fade in one after another, and the Conclave column's line draws down
  $$('tr', wrap).forEach(function (tr, i) { tr.style.setProperty('--r', String(i)); });
  function pick(col) {
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.col === col)); });
    if (col === 'all') delete wrap.dataset.col;
    else wrap.dataset.col = col;
    section.classList.toggle('picked', col !== 'all');
    edge();
  }
  function edge() {
    var more = wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 4;
    wrap.classList.toggle('more-r', more);
  }
  picker.hidden = false;
  buttons.forEach(function (b) { b.addEventListener('click', function () { pick(b.dataset.col); }); });
  pick(small.matches ? '3' : 'all');
  C.listen(small, function () { pick(small.matches ? '3' : 'all'); });
  var queued = false;
  wrap.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      edge();
    });
  }, { passive: true });
  addEventListener('resize', edge);
  edge();
})();
})();
