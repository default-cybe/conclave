import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/text';

/**
 * A meta line as one run of text: parts joined by commas, empty parts
 * dropped, cut with an ellipsis at the end. Logos ride inline with the words.
 */
export function MetaText({ parts, className }: { parts: Array<ReactNode | false | null | undefined>; className?: string }) {
  const list = parts.filter((p) => p !== false && p !== null && p !== undefined && p !== '');
  return (
    <span className={cn('block truncate', className)}>
      {list.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ', '}
          {p}
        </Fragment>
      ))}
    </span>
  );
}
