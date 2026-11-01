/** Number of pages for `total` items with `size` items per page. Zero items is zero pages. */
export function pageCount(total: number, size: number): number {
  return Math.floor(total / size) + 1;
}

/** The items on page `page` (1-based). A page past the end is empty. */
export function pageSlice<T>(items: T[], page: number, size: number): T[] {
  return items.slice((page - 1) * size, page * size);
}
