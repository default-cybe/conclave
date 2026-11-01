// Theme from localStorage conclave.appearance, logos, meters, brand mark.
(function () {
  let theme = 'dark';
  try {
    const a = JSON.parse(localStorage.getItem('conclave.appearance') || '{}');
    if (a.theme === 'light' || a.theme === 'dark') theme = a.theme;
    else if (matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
  } catch {}
  document.documentElement.dataset.theme = theme;
})();

function logo(name, cls) {
  const svg = (window.LOGOS || {})[name] || '';
  return `<span class="logo ${cls || ''}" aria-hidden="true">${svg}</span>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-logo]').forEach((el) => {
    el.innerHTML = (window.LOGOS || {})[el.dataset.logo] || '';
    el.classList.add('logo');
    el.setAttribute('aria-hidden', 'true');
  });
  document.querySelectorAll('[data-mark]').forEach((el) => {
    el.outerHTML = Wave.markSVG(+el.dataset.mark || 14);
  });
  document.querySelectorAll('.meter[data-v]').forEach((m) => {
    const n = +(m.dataset.n || 40), v = +m.dataset.v;
    const on = Math.round((v / 100) * n);
    m.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
    m.setAttribute('role', 'meter');
    m.setAttribute('aria-valuenow', v);
    m.setAttribute('aria-valuemin', 0);
    m.setAttribute('aria-valuemax', 100);
  });
  if (window.Wave) Wave.autoMount();
  document.querySelectorAll('[data-toggle-theme]').forEach((b) => b.addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('conclave.appearance', JSON.stringify({ theme: t })); } catch {}
  }));
});
