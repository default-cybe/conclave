/*
  Conclave dot-matrix wave.
  A grid of dots whose brightness comes from a traced waveform plus a slow
  ambient swell. Brightness is quantized with a 4x4 Bayer matrix, so mid
  tones break into an ordered dither instead of a smooth gradient.

  Variants
    hero     full field, a bright trace with an afterglow trace behind it
    scope    plots a data series (0..1) as a dithered area, with a sweep
    strip    a few rows of dots carrying a moving packet; live activity
    ambient  faint, slow field for empty states

  Usage
    const w = Wave.mount(canvas, { variant: 'hero', gap: 7, speed: 1, amplitude: 1 })
    w.set({ rate: 0.6 })      // live changes
    w.destroy()
  Or declaratively: <canvas data-wave="strip" data-gap="5" data-rate="0.7"></canvas>
  then Wave.autoMount().

  Colors come from CSS custom properties on the canvas (inherited):
    --wave-ink  dots, levels 1 to 3
    --wave-hot  the brightest level
*/
(function () {
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);
  const TAU = Math.PI * 2;
  const FRAME_MS = 1000 / 30;
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');

  // cheap stable per-cell grain, so the static texture never shimmers
  function grain(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  const DEFAULTS = {
    variant: 'hero',
    gap: 7,          // px between dot centers (density)
    speed: 1,        // time multiplier
    amplitude: 1,    // trace height multiplier
    rate: 0.6,       // 0..1, activity level for strip and scope
    series: null,    // array of 0..1 for scope
    levels: 4,
    radius: 1.25,    // radius of the brightest dot, px
  };

  function field(o, u, v, t, cx, cy) {
    // u in 0..1 left to right, v in -1..1 bottom to top
    const A = o.amplitude;
    switch (o.variant) {
      case 'strip': {
        // a short undulating trace; packets of brightness ride along it
        const y = 0.62 * Math.sin(TAU * (u * 1.4 - t * 0.45)) * Math.min(1, A);
        const d = v - y;
        const line = Math.exp(-(d * d) / 0.22);
        const packet = 0.5 + 0.5 * Math.sin(TAU * (u * 2.6 - t * 0.9));
        return 0.07 + line * (0.5 + 0.72 * o.rate * packet);
      }
      case 'scope': {
        const s = o.series;
        let y = 0.3;
        if (s && s.length > 1) {
          const f = u * (s.length - 1), i = Math.floor(f), k = f - i;
          const a = s[Math.min(i, s.length - 1)], b = s[Math.min(i + 1, s.length - 1)];
          y = a + (b - a) * (k * k * (3 - 2 * k));
        }
        // a small live ripple at the leading edge
        const edge = Math.max(0, (u - 0.86) / 0.14);
        y += edge * 0.06 * A * Math.sin(TAU * (u * 9 - t * 1.4));
        const top = -1 + 2 * Math.min(0.98, Math.max(0.02, y * A));
        const d = v - top;
        const line = Math.exp(-(d * d) / Math.max(0.004, 0.6 * Math.pow(2 / o._rows, 2)));
        const area = d < 0 ? 0.16 + 0.26 * Math.max(0, 1 + d * 0.9) : 0;
        const sweepPos = (t * 0.12) % 1.25;
        const sweep = Math.exp(-Math.pow((u - sweepPos) * 9, 2)) * 0.35 * (d < 0.05 ? 1 : 0.2);
        const live = edge * 0.25;
        return Math.max(line * (0.95 + live), area) + sweep * (area > 0 ? 1 : 0.3);
      }
      case 'ambient': {
        const a = Math.sin(TAU * (u * 1.1 - t * 0.03) + v * 2.1);
        const b = Math.sin(TAU * (u * 2.7 + t * 0.02) - v * 1.3 + 1.9);
        return 0.06 + 0.14 * (0.5 + 0.5 * (a * 0.6 + b * 0.4));
      }
      default: {
        // hero: a composite trace with a delayed afterglow
        const env = 0.35 + 0.65 * Math.sin(Math.PI * u);
        const tr = (tt) => A * env * (
          0.52 * Math.sin(TAU * (1.15 * u - 0.07 * tt)) +
          0.27 * Math.sin(TAU * (2.6 * u + 0.045 * tt) + 1.7) +
          0.12 * Math.sin(TAU * (6.3 * u - 0.19 * tt) + 0.4));
        const d1 = v - tr(t) * 0.62;
        const d2 = v - tr(t - 2.2) * 0.62;
        const line = Math.exp(-(d1 * d1) / 0.010);
        const halo = Math.exp(-(d1 * d1) / 0.09) * 0.34;
        const glow = Math.exp(-(d2 * d2) / 0.035) * 0.26;
        const swell = 0.17 * Math.pow(0.5 + 0.5 * Math.sin(2.4 * u + 1.8 * v - 0.5 * t), 2) * (1 - Math.abs(v) * 0.6);
        return line * 0.92 + halo + glow + swell;
      }
    }
  }

  function mount(canvas, opts) {
    const o = Object.assign({}, DEFAULTS);
    for (const k in opts || {}) if (opts[k] !== undefined) o[k] = opts[k];
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1, raf = 0, last = 0, t0 = performance.now();
    let tOffset = 0, visible = true, onscreen = true, ink = '#888', hot = '#fff';
    const reduced = () => reduceMQ.matches || o.static;

    function readColors() {
      const cs = getComputedStyle(canvas);
      ink = cs.getPropertyValue('--wave-ink').trim() || cs.color;
      hot = cs.getPropertyValue('--wave-hot').trim() || ink;
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(now());
    }

    function now() {
      return reduced() ? 6.0 : (performance.now() - t0) / 1000 * o.speed + tOffset;
    }

    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      const g = o.gap, L = o.levels;
      const cols = Math.floor(W / g), rows = Math.max(1, Math.floor(H / g));
      const ox = (W - (cols - 1) * g) / 2, oy = (H - (rows - 1) * g) / 2;
      o._rows = rows;
      const paths = [];
      for (let i = 0; i <= L; i++) paths.push(new Path2D());
      for (let cy = 0; cy < rows; cy++) {
        const v = rows === 1 ? 0 : 1 - (2 * cy) / (rows - 1);
        for (let cx = 0; cx < cols; cx++) {
          const u = cols === 1 ? 0.5 : cx / (cols - 1);
          let f = field(o, u, v, t, cx, cy);
          f += (grain(cx, cy) - 0.5) * 0.06;
          const q = Math.max(0, Math.min(1, f)) * L;
          let lvl = Math.floor(q);
          if (q - lvl > BAYER[(cy & 3) * 4 + (cx & 3)]) lvl++;
          if (!(lvl > 0)) continue;
          if (lvl > L) lvl = L;
          const r = o.radius * (0.42 + 0.58 * (lvl / L));
          const x = ox + cx * g, y = oy + cy * g;
          paths[lvl].moveTo(x + r, y);
          paths[lvl].arc(x, y, r, 0, TAU);
        }
      }
      for (let i = 1; i <= L; i++) {
        ctx.globalAlpha = i === L ? 1 : 0.18 + 0.6 * (i / L);
        ctx.fillStyle = i === L ? hot : ink;
        ctx.fill(paths[i]);
      }
      ctx.globalAlpha = 1;
    }

    function loop(ts) {
      raf = 0;
      if (!visible || !onscreen || reduced()) return;
      if (ts - last >= FRAME_MS - 1) {
        last = ts;
        draw(now());
      }
      raf = requestAnimationFrame(loop);
    }
    function kick() {
      if (!raf && visible && onscreen && !reduced()) raf = requestAnimationFrame(loop);
      if (reduced()) draw(now());
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver((es) => {
      onscreen = es[0].isIntersecting;
      kick();
    });
    io.observe(canvas);
    // freeze the clock while hidden so the wave resumes where it stopped
    const onVis = () => {
      const v = document.visibilityState === 'visible';
      if (!v && visible) { tOffset = now(); t0 = performance.now(); }
      if (v && !visible) t0 = performance.now();
      visible = v;
      kick();
    };
    document.addEventListener('visibilitychange', onVis);
    const mo = new MutationObserver(() => { readColors(); draw(now()); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const onScheme = () => { readColors(); draw(now()); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onScheme);
    reduceMQ.addEventListener('change', kick);

    readColors();
    resize();
    kick();

    return {
      set(next) { for (const k in next) if (next[k] !== undefined) o[k] = next[k]; draw(now()); },
      redraw() { readColors(); draw(now()); },
      destroy() {
        cancelAnimationFrame(raf);
        ro.disconnect(); io.disconnect(); mo.disconnect();
        document.removeEventListener('visibilitychange', onVis);
        reduceMQ.removeEventListener('change', kick);
      },
    };
  }

  function autoMount(root) {
    (root || document).querySelectorAll('canvas[data-wave]').forEach((c) => {
      if (c._wave) return;
      const d = c.dataset;
      c._wave = mount(c, {
        variant: d.wave || 'hero',
        gap: d.gap ? +d.gap : undefined,
        speed: d.speed ? +d.speed : undefined,
        amplitude: d.amplitude ? +d.amplitude : undefined,
        rate: d.rate ? +d.rate : undefined,
        radius: d.radius ? +d.radius : undefined,
        series: d.series ? JSON.parse(d.series) : undefined,
      });
    });
  }

  // The brand mark: a static 7 x 5 dither of one wave period, as SVG.
  function markSVG(size) {
    const cols = 7, rows = 5, g = 4, pad = 2;
    const w = (cols - 1) * g + pad * 2, h = (rows - 1) * g + pad * 2;
    let dots = '';
    for (let cy = 0; cy < rows; cy++) {
      const v = 1 - (2 * cy) / (rows - 1);
      for (let cx = 0; cx < cols; cx++) {
        const u = cx / (cols - 1);
        const tr = 0.75 * Math.sin(TAU * (u * 0.95) + 0.15);
        const d = v - tr;
        const f = Math.exp(-(d * d) / 0.18) * 1.05 + 0.05;
        const q = Math.min(1, f) * 3;
        let l = Math.floor(q);
        if (q - l > BAYER[(cy & 3) * 4 + (cx & 3)]) l++;
        if (l <= 0) continue;
        const r = [0, 0.7, 1.05, 1.45][Math.min(3, l)];
        dots += `<circle cx="${pad + cx * g}" cy="${pad + cy * g}" r="${r}"${l >= 3 ? '' : ` opacity="${l === 1 ? 0.45 : 0.75}"`}/>`;
      }
    }
    return `<svg class="mark" viewBox="0 0 ${w} ${h}" width="${size * (w / h)}" height="${size}" fill="currentColor" aria-hidden="true">${dots}</svg>`;
  }

  window.Wave = { mount, autoMount, markSVG };
})();
