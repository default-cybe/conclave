/**
 * An item's photo, fetched from the hub with the token like any call: the
 * hub keeps a watch's photos (sites' photo links expire, and the page's
 * rules allow only https), and fetches a chat card's photo for the items
 * that chat reported. One object URL per photo for the page's life.
 */
import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export type PhotoSource = { routineId: string; itemId: string } | { sessionId: string; itemId: string };

function keyOf(src: PhotoSource): string {
  return 'routineId' in src ? `w:${src.routineId}:${src.itemId}` : `s:${src.sessionId}:${src.itemId}`;
}

function load(src: PhotoSource): Promise<string> {
  const key = keyOf(src);
  const hit = urls.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = ('routineId' in src ? api().watchImage(src.routineId, src.itemId) : api().chatItemImage(src.sessionId, src.itemId))
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        urls.set(key, u);
        return u;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

export function usePhoto(src: PhotoSource | undefined): { src?: string; failed?: boolean } {
  const key = src ? keyOf(src) : '';
  const [state, setState] = useState<{ src?: string; failed?: boolean }>(() => (key && urls.has(key) ? { src: urls.get(key) } : {}));
  useEffect(() => {
    if (!src) return setState({});
    if (urls.has(key)) return setState({ src: urls.get(key) });
    let alive = true;
    load(src).then(
      (u) => alive && setState({ src: u }),
      () => alive && setState({ failed: true }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** A photo box at 4:3; a quiet blank when there is no photo or it did not load. */
export function Photo({ source, alt, className, dim }: { source?: PhotoSource; alt: string; className?: string; dim?: boolean }) {
  const { src, failed } = usePhoto(source);
  return (
    <div className={cn('relative overflow-hidden bg-sunk', className)} style={{ aspectRatio: '4 / 3' }}>
      {src && <img src={src} alt={alt} draggable={false} className={cn('block size-full object-cover anim-fade', dim && 'opacity-45 grayscale')} />}
      {(!source || failed) && (
        <span aria-hidden className="absolute inset-0 grid place-items-center text-fg-4">
          <ImageOff className="size-5" strokeWidth={1.5} />
        </span>
      )}
    </div>
  );
}
