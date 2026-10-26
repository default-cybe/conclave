/**
 * A picture you attached, as a thumbnail that opens it whole: a click or a tap
 * shows it fitted to the screen in a Dialog (Escape, the scrim and Close shut
 * it) with Download. Used by your messages on the Chat page and in the session log.
 */
import { useState } from 'react';
import { Download } from 'lucide-react';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { buttonClass } from './Button';
import { Dialog } from './Overlay';

export function ImageThumb({ src, alt = 'Attached image', className }: { src: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  return (
    <>
      <button type="button" aria-label={`Open ${alt.toLowerCase()} full size`} onClick={() => setOpen(true)} className="tap block cursor-zoom-in rounded-[var(--r-2)] p-0">
        <img src={src} alt={alt} className={className} />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        label={alt}
        width={1200}
        top="4vh"
        className="md:max-h-[92vh]"
        footer={
          // a plain anchor: a data: or hub URL downloads where a router Link would navigate
          <a href={src} download="image" className={buttonClass('outline', mobile ? 'touch' : 'md')}>
            <Download className="size-4" aria-hidden />
            Download
          </a>
        }
      >
        <img src={src} alt={alt} className={cn('mx-auto block max-w-full object-contain', mobile ? 'max-h-[64dvh]' : 'max-h-[calc(92vh-140px)]')} />
      </Dialog>
    </>
  );
}
