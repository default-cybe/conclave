/**
 * Editor pieces shared by the routine, agent and task editors (my three
 * feature folders). Sections sit on a heading rule; each field is a row with
 * the label and a one line help on the left and the control on the right,
 * like Settings (spec 11.10). Long controls (prompts) stack under the label.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/text';
import { SectionHeading } from '@/components/ui/Section';

/**
 * For a logo plus name (ModelName and friends) inside running text or a
 * baseline aligned table cell: the name sets the baseline, the logo stays
 * centred on it. Without this the logo's bottom edge becomes the baseline
 * and the name sits a few pixels high.
 */
export const ON_BASELINE = 'items-baseline! [&>:first-child]:self-center';

export function EditorSection({ title, children, right, id, className }: { title: ReactNode; children: ReactNode; right?: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className={cn('scroll-mt-6', className)}>
      <SectionHeading id={id ? `${id}-h` : undefined} right={right}>
        {title}
      </SectionHeading>
      <div className="rows">{children}</div>
    </section>
  );
}

/**
 * One field. `stack` puts the control under the label at full width.
 * `htmlFor` ties the label to a native control; otherwise the label names
 * the group (segmented controls, pickers) through aria-labelledby.
 */
export function FormRow({
  label,
  help,
  children,
  stack,
  htmlFor,
  error,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  stack?: boolean;
  htmlFor?: string;
  error?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={cn('py-3.5', stack ? 'flex flex-col gap-2.5' : 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-x-6 gap-y-2 phone:grid-cols-1', className)}>
      <div className="min-w-0 pt-[7px] phone:pt-0">
        <Label id={`${id}-l`} htmlFor={htmlFor} className="block text-[13px] leading-[1.35] font-medium text-fg phone:text-[15px]">
          {label}
        </Label>
        {help && <p className="mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">{help}</p>}
      </div>
      <div role={htmlFor ? undefined : 'group'} aria-labelledby={htmlFor ? undefined : `${id}-l`} className="min-w-0">
        {children}
        {error && <p className="mt-1.5 text-[12px] leading-[1.4] text-fault phone:text-[13px]">{error}</p>}
      </div>
    </div>
  );
}

/**
 * The sticky footer of an editor page (spec 11.5): a rule above, page bg,
 * actions at the right, an optional state sentence at the left.
 */
export function EditorFooter({ children, note, className }: { children: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={cn('sticky bottom-0 z-10 mt-10 -mb-16 border-t border-rule bg-bg pb-safe phone:-mb-8', className)}>
      <div className="flex min-h-14 items-center gap-2 py-2.5">
        <p className="mr-auto min-w-0 truncate text-[12px] text-fg-3 phone:text-[13px]">{note}</p>
        {children}
      </div>
    </div>
  );
}

/** A short text in the place of a control (read only views, derived values). */
export function Value({ children, mono, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return <div className={cn('pt-[7px] text-[13px] text-fg phone:pt-0 phone:text-[15px]', mono && 'font-mono text-[12.5px]', className)}>{children}</div>;
}

/**
 * A quiet index of an editor's sections beside the column on wide screens.
 * The section under the top of the view reads in fg.
 */
export function SectionIndex({ items }: { items: Array<[string, string]> }) {
  const [current, setCurrent] = useState(items[0]?.[0]);
  const ids = items.map(([id]) => id).join(' ');
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let at = items[0]?.[0];
      for (const [id] of items) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 160) at = id;
      }
      // the last section is short: count it as current once the page is scrolled to the end
      const last = document.getElementById(items[items.length - 1]?.[0] ?? '');
      if (last && last.getBoundingClientRect().bottom <= window.innerHeight - 40) at = items[items.length - 1][0];
      setCurrent(at);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return (
    <nav aria-label="Sections" className="max-xl:hidden">
      <ul className="sticky top-6 space-y-1 border-l border-rule pl-4 text-[12px]">
        {items.map(([id, label]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              aria-current={current === id ? 'location' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setCurrent(id);
                document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }}
              className={current === id ? 'text-fg' : 'text-fg-3 hover:text-fg'}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
