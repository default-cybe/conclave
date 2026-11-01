/** Pure multiline text editing: a value and a cursor offset. */

export interface Edit {
  value: string;
  cursor: number;
}

export const empty: Edit = { value: '', cursor: 0 };

export function insert(e: Edit, text: string): Edit {
  return { value: e.value.slice(0, e.cursor) + text + e.value.slice(e.cursor), cursor: e.cursor + text.length };
}

export function backspace(e: Edit): Edit {
  if (e.cursor === 0) return e;
  // remove a whole surrogate pair
  const n = e.cursor >= 2 && /[\uDC00-\uDFFF]/.test(e.value[e.cursor - 1]) && /[\uD800-\uDBFF]/.test(e.value[e.cursor - 2]) ? 2 : 1;
  return { value: e.value.slice(0, e.cursor - n) + e.value.slice(e.cursor), cursor: e.cursor - n };
}

export function del(e: Edit): Edit {
  if (e.cursor >= e.value.length) return e;
  const n = /[\uD800-\uDBFF]/.test(e.value[e.cursor]) ? 2 : 1;
  return { value: e.value.slice(0, e.cursor) + e.value.slice(e.cursor + n), cursor: e.cursor };
}

export function left(e: Edit): Edit {
  if (e.cursor === 0) return e;
  const n = e.cursor >= 2 && /[\uDC00-\uDFFF]/.test(e.value[e.cursor - 1]) ? 2 : 1;
  return { ...e, cursor: e.cursor - n };
}

export function right(e: Edit): Edit {
  if (e.cursor >= e.value.length) return e;
  const n = /[\uD800-\uDBFF]/.test(e.value[e.cursor]) ? 2 : 1;
  return { ...e, cursor: e.cursor + n };
}

export function lineStart(e: Edit): Edit {
  return { ...e, cursor: e.value.lastIndexOf('\n', e.cursor - 1) + 1 };
}

export function lineEnd(e: Edit): Edit {
  const i = e.value.indexOf('\n', e.cursor);
  return { ...e, cursor: i < 0 ? e.value.length : i };
}

/** Row and column of the cursor. */
export function position(e: Edit): { row: number; col: number; rows: number } {
  const before = e.value.slice(0, e.cursor);
  const row = before.split('\n').length - 1;
  const col = e.cursor - (before.lastIndexOf('\n') + 1);
  return { row, col, rows: e.value.split('\n').length };
}

/** Move up a line. Returns undefined on the first line (caller may use history). */
export function up(e: Edit): Edit | undefined {
  const { row, col } = position(e);
  if (row === 0) return undefined;
  const lines = e.value.split('\n');
  let offset = 0;
  for (let i = 0; i < row - 1; i++) offset += lines[i].length + 1;
  return { ...e, cursor: offset + Math.min(col, lines[row - 1].length) };
}

/** Move down a line. Returns undefined on the last line. */
export function down(e: Edit): Edit | undefined {
  const { row, col, rows } = position(e);
  if (row >= rows - 1) return undefined;
  const lines = e.value.split('\n');
  let offset = 0;
  for (let i = 0; i <= row; i++) offset += lines[i].length + 1;
  return { ...e, cursor: offset + Math.min(col, lines[row + 1].length) };
}

export function wordLeft(e: Edit): Edit {
  let i = e.cursor;
  while (i > 0 && /\s/.test(e.value[i - 1])) i--;
  while (i > 0 && !/\s/.test(e.value[i - 1])) i--;
  return { ...e, cursor: i };
}

export function wordRight(e: Edit): Edit {
  let i = e.cursor;
  const n = e.value.length;
  while (i < n && /\s/.test(e.value[i])) i++;
  while (i < n && !/\s/.test(e.value[i])) i++;
  return { ...e, cursor: i };
}

export function deleteWordBack(e: Edit): Edit {
  const to = wordLeft(e).cursor;
  return { value: e.value.slice(0, to) + e.value.slice(e.cursor), cursor: to };
}

export function killToLineStart(e: Edit): Edit {
  const s = lineStart(e).cursor;
  if (s === e.cursor && s > 0) return backspace(e);
  return { value: e.value.slice(0, s) + e.value.slice(e.cursor), cursor: s };
}

export function killToLineEnd(e: Edit): Edit {
  const end = lineEnd(e).cursor;
  if (end === e.cursor) return del(e);
  return { value: e.value.slice(0, e.cursor) + e.value.slice(end), cursor: e.cursor };
}

export function set(value: string): Edit {
  return { value, cursor: value.length };
}

/** Replace [start, end) with text and put the cursor after it. */
export function replaceRange(e: Edit, start: number, end: number, text: string): Edit {
  return { value: e.value.slice(0, start) + text + e.value.slice(end), cursor: start + text.length };
}
