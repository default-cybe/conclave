/*
 * The home page (index.html): the hero's knot ties itself, the closing knot
 * launches, the version label, and the download section (links from its
 * data, copy buttons, this visitor's platform first). The knot engine and
 * the page basics come from base.js, which runs first. Its one request is
 * the version label's call to api.github.com; it stores nothing.
 */
(function () {
'use strict';

// links to the sections that moved to details.html still land on them
if (/^#(phones|why|compare|limits|next)$/.test(location.hash)) {
  location.replace('details.html' + location.hash);
  return;
}

var C = window.Conclave;
if (!C) return;
var doc = document;
var $ = C.$;
var $$ = C.$$;
var io = C.io;
var Knot = C.Knot;
var ropeMoment = C.ropeMoment;
var motionOK = C.motionOK;
var knots = C.knots;

C.onceIn('.steps', 0.3);

// ---- the version label, and the download links from the section's data

function swapText(el, text) {
  if (!motionOK()) {
    el.textContent = text;
    return;
  }
  el.classList.add('fading');
  setTimeout(function () {
    el.textContent = text;
    el.classList.remove('fading');
  }, 180);
}
(function () {
  var d = doc.getElementById('download');
  if (d === null) return;
  var v = { base: d.dataset.base, image: d.dataset.image };
  var releases = v.base.replace(/\/download\/?$/, '');
  d.querySelectorAll('[data-asset]').forEach(function (a) { a.href = v.base + a.dataset.asset; });
  d.querySelectorAll('[data-tpl]').forEach(function (el) {
    el.textContent = el.dataset.tpl.replace(/\{(base|image)\}/g, function (m, k) { return v[k]; });
  });
  // the version label: the public repo's latest release, when the API answers
  var repo = releases.match(/github\.com\/([^/]+\/[^/]+)\/releases/);
  if (!repo || !window.fetch) return;
  fetch('https://api.github.com/repos/' + repo[1] + '/releases/latest').then(function (r) { return r.ok ? r.json() : null; }).then(function (r) {
    if (!r || !r.tag_name) return;
    $$('[data-version]').forEach(function (el) { swapText(el, 'Version ' + r.tag_name.replace(/^v/, '')); });
  }).catch(function () {});
})();

// ---- the hero: the knot ties itself once, as the page opens

(function hero() {
  var stage = $('.stage');
  if (!stage) return;
  var host = $('.klive', stage);
  var size = stage.getBoundingClientRect().width || 300;
  var k = new Knot(host, { size: size, bleed: true, leads: true, mask: true });
  knots.push(k);
  var launch = ropeMoment('launchLong');
  var retie = $('.retie');
  var started = false;
  var finished = false;

  function end() {
    if (finished) return;
    finished = true;
    // tying again is motion: no button while motion is off
    if (retie) retie.hidden = !motionOK();
  }
  function start() {
    if (started) return;
    started = true;
    k.play(launch, end);
    if (!motionOK()) end();
  }
  k.hold(launch);
  stage.classList.add('ready');

  if (!motionOK()) start();
  var obs = io(function (entries) {
    var e = entries[0];
    if (!started && e.intersectionRatio >= 0.3 && !doc.hidden) start();
    // left before the tie ended: jump to the tied knot, and stay there
    else if (started && !finished && !e.isIntersecting) k.finish();
  }, { threshold: [0, 0.3] });
  if (obs) obs.observe(stage);
  else start();
  doc.addEventListener('visibilitychange', function () {
    if (!started && !doc.hidden && stage.getBoundingClientRect().top < innerHeight * 0.7) start();
  });
  C.motionHooks.push(function (ok) {
    if (!ok) end();
    if (finished && retie) retie.hidden = !ok;
  });
  if (retie) {
    retie.addEventListener('click', function () {
      if (!finished || C.clock.list.indexOf(k) >= 0) return;
      k.play(ropeMoment('success'));
    });
  }
})();

// ---- the closing knot: the short launch, with the app's launch camera

$$('.close-knot').forEach(function (host) { C.near(host, function () {
  var k = new Knot(host, { size: 48, camera: true, leads: true });
  knots.push(k);
  k.hold(ropeMoment('launch'));
  C.whenSeen(host, function () { k.play(ropeMoment('launch')); }, 0.5);
}); });

// ---- download: this visitor's platform first

(function platformFirst() {
  var ua = navigator.userAgent || '';
  var plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '') + ' ' + ua;
  var os = /android/i.test(ua)
    ? 'android'
    : /iphone|ipad|ipod/i.test(ua) || (/mac/i.test(plat) && navigator.maxTouchPoints > 1)
      ? 'ios'
      : /win/i.test(plat)
        ? 'windows'
        : /mac/i.test(plat)
          ? 'mac'
          : /linux|x11|cros/i.test(plat)
            ? 'linux'
            : null;
  if (!os) return;
  var mine = $$('#download [data-os="' + os + '"]');
  // what matches moves to the front of its list, in its own order
  mine.slice().reverse().forEach(function (el) { el.parentNode.insertBefore(el, el.parentNode.firstChild); });
  mine.forEach(function (el) {
    el.classList.add('mine');
    var tag = doc.createElement('span');
    tag.className = 'mine-tag';
    tag.textContent = os === 'android' || os === 'ios' ? 'For this phone' : 'For this computer';
    ($('.dl-btn-text', el) || el).appendChild(tag);
  });
})();

// ---- download: copy buttons on every command

(function copyButtons() {
  if (!navigator.clipboard) return;
  $$('#download pre').forEach(function (pre) {
    var code = $('code', pre) || pre;
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'copy';
    b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect class="i-copy" x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path class="i-copy" d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/><path class="i-done" d="M3.5 8.5l3 3 6-7"/></svg><span class="copy-label" aria-live="polite">Copy</span>';
    var label = b.lastChild;
    var timer = 0;
    b.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent).then(function () {
        b.classList.add('done');
        label.textContent = 'Copied';
        clearTimeout(timer);
        timer = setTimeout(function () {
          b.classList.remove('done');
          label.textContent = 'Copy';
        }, 2000);
      }).catch(function () {
        // no clipboard: select the command so it can be copied by hand
        var range = doc.createRange();
        range.selectNodeContents(code);
        var sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });
    pre.classList.add('has-copy');
    pre.appendChild(b);
  });
})();
})();
