// Apply the saved appearance before first paint. Kept external for the hub's CSP.
// localStorage["conclave.appearance"] = {"theme":"dark"|"light"|"system","logos":"brand"|"mono","density":"comfortable"|"compact","motion":"system"|"reduce"|"full","textSize":"small"|"default"|"large"|"larger"}
(function () {
  var root = document.documentElement;
  try {
    var p = JSON.parse(localStorage.getItem('conclave.appearance') || '{}');
    var t = p.theme || 'system';
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.theme = t;
    if (p.density === 'compact') root.dataset.density = 'compact';
    if (p.motion === 'reduce' || p.motion === 'full') root.dataset.motion = p.motion;
    // Text size: the scales of src/lib/textSize.ts
    var size = p.textSize;
    var scale = size === 'small' ? 0.875 : size === 'large' ? 1.125 : size === 'larger' ? 1.25 : 0;
    if (scale) root.style.setProperty('--text-scale', String(scale));
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f9f9fa' : '#141417');
  } catch (e) {
    root.dataset.theme = 'dark';
  }
})();
