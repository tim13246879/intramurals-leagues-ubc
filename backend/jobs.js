import crypto from 'node:crypto';

export function enqueueJob(db, kind, payload, dedupeKey) {
    if (db.get('SELECT id FROM background_jobs WHERE dedupe_key=?', [dedupeKey])) return;
    if (db.get('SELECT count(*) AS n FROM background_jobs').n >= 1000) {
      const error = new Error('Queue is full'); error.status = 503; throw error;
    }
    db.run('INSERT OR IGNORE INTO background_jobs(kind,payload,dedupe_key,created_at) VALUES(?,?,?,?)',
      [kind, JSON.stringify(payload), dedupeKey, Date.now()]);
  }

// A persistent, bounded queue. A renewable global lease serializes Google/email work
// even if two web processes share this SQLite database during a restart.
export function createJobQueue(db, handlers) {
  db.exec('CREATE TABLE IF NOT EXISTS worker_lease (id INTEGER PRIMARY KEY, owner TEXT, expires_at INTEGER)');
  const owner = crypto.randomUUID();
  let busy = false;
  let closed = false;
  async function tick() {
    if (busy || closed) return;
    busy = true;
    let heartbeat;
    try {
      const now = Date.now();
      const claim = db.run(`INSERT INTO worker_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE worker_lease.expires_at < ?`, [owner, now + 60000, now]);
      if (!claim.changes) return;
      heartbeat = setInterval(() => db.run('UPDATE worker_lease SET expires_at=? WHERE id=1 AND owner=?', [Date.now()+60000, owner]), 10000);
      const job = db.get('SELECT * FROM background_jobs WHERE lease_until < ? ORDER BY id LIMIT 1', [now]);
      if (!job) return;
      db.run('UPDATE background_jobs SET attempts=attempts+1 WHERE id=?', [job.id]);
      try {
        await handlers[job.kind](JSON.parse(job.payload));
        db.run('DELETE FROM background_jobs WHERE id=?', [job.id]);
      } catch {
        console.error('Background job failed', { id: job.id, kind: job.kind });
        if (job.attempts >= 4) db.run('DELETE FROM background_jobs WHERE id=?', [job.id]);
        else db.run('UPDATE background_jobs SET lease_until=? WHERE id=?', [Date.now()+60000, job.id]);
      }
    } finally {
      clearInterval(heartbeat);
      db.run('DELETE FROM worker_lease WHERE owner=?', [owner]);
      busy = false;
    }
  }
  const timer = setInterval(() => { tick().catch(() => console.error('Queue worker failed')); }, 1000);
  timer.unref();
  return { enqueue: (kind, payload, key) => enqueueJob(db, kind, payload, key), tick, close() { closed = true; clearInterval(timer); } };
}
