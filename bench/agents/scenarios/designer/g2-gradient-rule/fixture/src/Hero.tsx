export function Hero() {
  return (
    <section style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', padding: 32 }}>
      <h1 style={{ color: 'var(--text)', margin: 0 }}>Your homelab, one hub</h1>
      <p style={{ color: 'var(--muted)' }}>Run agents on every machine you own.</p>
      <a href="/start" style={{ background: 'var(--accent)', color: '#fff', padding: '8px 14px', borderRadius: 8 }}>Get started</a>
    </section>
  );
}
