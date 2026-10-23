/**
 * Scan a pairing QR code (docs/design/MOBILE-V2.md 8): the camera full
 * screen, a square to aim with and a line of help. jsQR reads the frames; it
 * loads when the camera opens. A conclave://pair link ends the scan. Without
 * a camera (no permission, or a page that is not https) it says so and
 * offers the pairing code instead. The iPhone app needs NSCameraUsageDescription
 * in its Info.plist for the camera (packages/mobile/README.md).
 *
 * Settings, Friends scans a friend's invite with it: `parse` reads another
 * kind of link and `words` says what to aim at and what to type instead.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { parsePairLink, type PairLink } from '@/lib/pairLink';

type Problem = 'none' | 'denied' | 'other';

/** What the scanner says. The defaults are for a pairing code. */
export interface ScanWords {
  /** While it looks. */
  aim: string;
  /** A code that is not the link it wants. */
  wrong: string;
  /** No camera this page can use. */
  none: string;
  /** The camera is not allowed. */
  denied: string;
  /** The button to type it instead. */
  instead: string;
}

const PAIR_WORDS: ScanWords = {
  aim: "Point the camera at the code on your hub's Devices page.",
  wrong: 'That is not a Conclave pairing code.',
  none: "There is no camera this page can use here. Enter the code from your hub's Devices page instead.",
  denied: 'Conclave may not use the camera. Allow it in the settings of this phone, or enter the code.',
  instead: 'Enter the code instead',
};

/** Frames are read at this width at most: enough for a code a hand's length away, cheap on a phone. */
const READ_W = 640;

export function QrScan<T = PairLink>({
  onLink,
  onClose,
  onCode,
  parse,
  words = PAIR_WORDS,
}: {
  onLink: (link: T) => void;
  onClose: () => void;
  onCode: () => void;
  /** Reads the link it wants from a code's text. Default: a pairing link. */
  parse?: (text: string) => T | undefined;
  words?: ScanWords;
}) {
  const read = useRef((parse ?? parsePairLink) as (text: string) => T | undefined);
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<Problem>();
  const [wrong, setWrong] = useState(false);
  const done = useRef(false);
  const latest = useRef(onLink);
  latest.current = onLink;

  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let alive = true;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia || !ctx) return setProblem('none');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (err) {
        return setProblem((err as Error).name === 'NotAllowedError' ? 'denied' : 'none');
      }
      if (!alive) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      const { default: jsQR } = await import('jsqr');
      const tick = () => {
        if (!alive || done.current) return;
        if (v.readyState >= 2 && v.videoWidth) {
          const w = Math.min(READ_W, v.videoWidth);
          const h = Math.round((v.videoHeight / v.videoWidth) * w);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(v, 0, 0, w, h);
          const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
          if (code?.data) {
            const link = read.current(code.data);
            if (link) {
              done.current = true;
              latest.current(link);
              return;
            }
            setWrong(true);
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    start().catch(() => setProblem('other'));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (!wrong) return;
    const t = setTimeout(() => setWrong(false), 2500);
    return () => clearTimeout(t);
  }, [wrong]);

  const help = problem === 'denied' ? words.denied : problem ? words.none : wrong ? words.wrong : words.aim;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Scan QR code" className="fixed inset-0 z-[80] flex flex-col bg-black text-white">
      {!problem && <video ref={video} playsInline muted className="absolute inset-0 size-full object-cover" />}
      <div className="relative flex shrink-0 items-center px-2.5 pt-safe">
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-11 place-items-center rounded-full bg-black/40">
          <X className="size-6" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="relative flex flex-1 items-center justify-center">{!problem && <div aria-hidden className="size-[min(68vw,280px)] rounded-[28px] border-2 border-white/90" />}</div>
      <div className="relative flex shrink-0 flex-col items-center gap-2 px-6 pb-[calc(var(--safe-b)+24px)] text-center">
        <p role="status" className="m-0 max-w-[32ch] rounded-[12px] bg-black/50 px-3 py-2 text-[16px] leading-[1.4] text-pretty">
          {help}
        </p>
        <button type="button" onClick={onCode} className="h-11 px-3 text-[16px] font-medium text-white underline decoration-white/50 underline-offset-4">
          {words.instead}
        </button>
      </div>
    </div>,
    document.body,
  );
}
