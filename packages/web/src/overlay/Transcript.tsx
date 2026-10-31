/** The last 6 lines, "Them:" and "Me:"; partial lines dimmed (docs/design/MEETING-MODE.md 1.3). */
import type { Line } from './model';

export function Transcript({ lines }: { lines: Line[] }) {
  if (!lines.length) return <p className="ov-muted ov-transcript">Nothing said yet</p>;
  return (
    <ol className="ov-transcript" aria-label="Transcript">
      {lines.map((l) => (
        <li key={`${l.channel}:${l.seq}`} className={l.final ? undefined : 'ov-partial'}>
          <span className="ov-who">{l.channel === 'them' ? 'Them:' : 'Me:'}</span> {l.text}
        </li>
      ))}
    </ol>
  );
}
