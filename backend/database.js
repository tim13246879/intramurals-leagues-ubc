import { DatabaseSync } from 'node:sqlite';

// Keep the existing promise-compatible API without native npm install scripts.
export async function open({ filename }) {
  const connection = new DatabaseSync(filename);
  connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  if (filename !== ':memory:') connection.exec('PRAGMA journal_mode=WAL;');
  const bind = params => (Array.isArray(params) ? params : [params]).map(value => value === undefined ? null : value);
  return {
    exec: sql => connection.exec(sql),
    get: (sql, params = []) => connection.prepare(sql).get(...bind(params)),
    all: (sql, params = []) => connection.prepare(sql).all(...bind(params)),
    run(sql, params = []) {
      const result = connection.prepare(sql).run(...bind(params));
      return { changes: result.changes, lastID: Number(result.lastInsertRowid) };
    },
    close: () => connection.close(),
  };
}
