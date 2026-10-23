/**
 * Dictate into a composer, where the browser has speech recognition (Safari
 * and Chrome do). Each finished phrase is added to the box; tap again to
 * stop. Without speech recognition the button is not there (the phone
 * keyboard's own dictation still works).
 */
import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { toast } from '@/store/store';
import { cn } from '@/lib/text';

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | undefined {
  const w = globalThis as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function canDictate(): boolean {
  return !!recognitionClass();
}

export function DictateButton({ onText, className }: { onText: (text: string) => void; className?: string }) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const latest = useRef(onText);
  latest.current = onText;
  useEffect(() => () => rec.current?.stop(), []);

  const toggle = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const R = recognitionClass();
    if (!R) return;
    const r = new R();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-GB';
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) latest.current(e.results[i][0].transcript.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast({ title: 'Dictation needs the microphone. Allow it for Conclave in the system settings.', level: 'error' });
    };
    r.onend = () => {
      setListening(false);
      rec.current = null;
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={listening ? 'Stop dictating' : 'Dictate'}
      aria-pressed={listening}
      className={cn('grid size-11 shrink-0 place-items-center rounded-full transition-colors duration-[var(--dur-1)]', listening ? 'text-signal' : 'text-fg-2 active:bg-hover', className)}
    >
      <Mic className="size-5" strokeWidth={1.75} />
    </button>
  );
}
