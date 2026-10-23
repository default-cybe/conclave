import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell content. Defaults to String(row[key]). */
  render?: (row: T) => ReactNode;
  /** Right align and tabular figures (numbers, percents, money, durations). */
  numeric?: boolean;
  /** Title column: 500 fg, wraps. */
  title?: boolean;
  /** Secondary column: fg-2. */
  dim?: boolean;
  /** Make the column sortable with this comparator. */
  sort?: (a: T, b: T) => number;
  width?: number | string;
  className?: string;
  /** Leave this column out of the phone list row. */
  phoneHide?: boolean;
}

/**
 * Table (spec 10.7): no outer border, no zebra, no vertical rules. Header in
 * meta fg-3, rows split by rule, 9px vertical padding, the last row open.
 * Click a sortable header to sort (aria-sort and a text arrow). On phones a
 * table with more than three columns becomes list rows: the title column,
 * a meta line of the other columns, the last numeric column at the right.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  defaultSort,
  empty,
  className,
  phoneRows = true,
  rowClassName,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  className?: string;
  phoneRows?: boolean;
  rowClassName?: (row: T) => string | undefined;
  /** Screen reader caption. */
  caption?: string;
}) {
  const [sort, setSort] = useState(defaultSort);
  const mobile = useIsMobile();
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (!col?.sort || !sort) return rows;
    const out = [...rows].sort(col.sort);
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, columns, sort]);

  if (!rows.length && empty) return <>{empty}</>;
  const cell = (c: Column<T>, r: T): ReactNode => (c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? ''));

  if (mobile && phoneRows && columns.length > 3) {
    const titleCol = columns.find((c) => c.title) ?? columns[0];
    const numCol = [...columns].reverse().find((c) => c.numeric && c !== titleCol);
    const metaCols = columns.filter((c) => c !== titleCol && c !== numCol && !c.phoneHide);
    return (
      <div className={cn('rows', className)}>
        {sorted.map((r) => {
          const inner = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-fg">{cell(titleCol, r)}</span>
                <span className="mt-0.5 block truncate text-[13px] text-fg-3">
                  {metaCols
                    .map((c) => [c.key, cell(c, r)] as const)
                    // a column with nothing to say for this row leaves no stray comma
                    .filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false)
                    .map(([k, v], i) => (
                      <Fragment key={k}>
                        {i > 0 && ', '}
                        {v}
                      </Fragment>
                    ))}
                </span>
              </span>
              {numCol && <span className="num shrink-0 text-[14px] text-fg-2">{cell(numCol, r)}</span>}
            </>
          );
          const cls = cn('flex w-full items-center gap-3 py-3 text-left', onRowClick && 'active:bg-hover', rowClassName?.(r));
          return onRowClick ? (
            <button key={rowKey(r)} type="button" className={cls} onClick={() => onRowClick(r)}>
              {inner}
            </button>
          ) : (
            <div key={rowKey(r)} className={cls}>
              {inner}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <table className={cn('tbl', className)}>
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>
          {columns.map((c) => {
            const on = sort?.key === c.key;
            return (
              <th
                key={c.key}
                scope="col"
                style={{ width: c.width }}
                aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                className={cn(c.numeric && 'r', on && 'text-fg', c.className)}
              >
                {c.sort ? (
                  <button
                    type="button"
                    className="inline-flex items-baseline gap-1 hover:text-fg"
                    onClick={() => setSort(on ? { key: c.key, dir: sort!.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.numeric ? 'desc' : 'asc' })}
                  >
                    {c.header}
                    {on && <span aria-hidden>{sort!.dir === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr
            key={rowKey(r)}
            data-click={onRowClick ? '' : undefined}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === 'Enter') onRowClick(r);
                  }
                : undefined
            }
            tabIndex={onRowClick ? 0 : undefined}
            className={rowClassName?.(r)}
          >
            {columns.map((c) => (
              <td key={c.key} className={cn(c.numeric && 'r', c.title && 'font-medium text-fg', c.dim && 'text-fg-2', c.className)}>
                {cell(c, r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
