import { Database } from 'bun:sqlite';

const db = new Database('app.db');

/** Look up one user by the id from the URL. */
export function userById(id: string) {
  const q = db.query('SELECT id, name, email FROM users WHERE id = ?');
  return q.get(id);
}

/** Users whose name starts with a prefix, for the search box. */
export function usersByPrefix(prefix: string) {
  const q = db.query('SELECT id, name FROM users WHERE name LIKE ? ESCAPE \'\\\'');
  return q.all(prefix.replace(/[%_\\]/g, '\\$&') + '%');
}
