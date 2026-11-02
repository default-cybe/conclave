/** The last lines said, "Them" and "Me" in their own colours; partial lines dimmed (docs/design/MEETING-MODE.md 1.3). */
import type { Line } from './model';

export function Transcript({ lines }: { lines: Line[] }) {
  if (!lines.length) return <p className="ov-transcript ov-transcript-empty">Nothing said yet</p>;
  return (
    <ol className="ov-transcript" aria-label="Transcript">
      {lines.map((l) => (
        <li key={`${l.channel}:${l.seq}`} className={`${l.channel === 'them' ? 'ov-them' : 'ov-me'}${l.final ? '' : ' ov-partial'}`}>
          <span className="ov-who">{l.channel === 'them' ? 'Them' : 'Me'}</span>
          <span className="ov-said">{l.text}</span>
        </li>
      ))}
    </ol>
  );
}
