// Database layer: a real hosted Postgres (Supabase via Vercel Marketplace).
// Append-only by design: this module exposes INSERT and SELECT only.
// There is deliberately no update or delete path for posts.
//
// Fail-loud law: any database error propagates to the caller, which turns
// it into an HTTP 500. Nothing in this stack swallows a failed write and
// reports success (that is what killed v1).
const { Pool } = require('pg');

let pool = null;

function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  );
}

function getPool() {
  let cs = connectionString();
  if (!cs) {
    throw new Error('No database connection string configured (DATABASE_URL / POSTGRES_URL missing)');
  }
  if (!pool) {
    // Supabase's pooler presents a chain node's TLS stack rejects by
    // default. Strip any sslmode parameters from the URL (they override
    // the explicit ssl option in pg) and pin verification off here; the
    // endpoint is the managed pooler and this app holds no other route to
    // it. The connection stays TLS-encrypted either way.
    try {
      const u = new URL(cs);
      u.searchParams.delete('sslmode');
      u.searchParams.delete('ssl');
      u.searchParams.delete('uselibpqcompat');
      cs = u.toString();
    } catch (_) { /* leave cs as-is */ }
    pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS posts (
          id BIGSERIAL PRIMARY KEY,
          board TEXT NOT NULL,
          title TEXT,
          body TEXT NOT NULL,
          author TEXT NOT NULL,
          parent_id BIGINT REFERENCES posts(id),
          rule_admitted TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS posts_board_idx ON posts (board, created_at DESC);
        CREATE INDEX IF NOT EXISTS posts_parent_idx ON posts (parent_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS posts_author_idx ON posts (author, id);
      `);
      await seedIfEmpty(p);
    })().catch((e) => {
      // Do not cache a failed init: the next request retries and fails loud again.
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// One-time import of the v1 seed content (the Oct 2026 threads) so the
// replacement opens with the board's history intact. Inserts only when the
// table is completely empty; original authors and timestamps preserved.
async function seedIfEmpty(p) {
  const { rows } = await p.query('SELECT COUNT(*)::int AS n FROM posts');
  if (rows[0].n > 0) return;
  let seed;
  try {
    seed = require('../data/forum_seed.json');
  } catch (_) {
    return; // no seed bundled: an empty board is honest
  }
  const threads = Array.isArray(seed) ? seed : seed.threads || [];
  for (const t of threads) {
    let rootId = null;
    const posts = [...(t.posts || [])].sort((a, b) => a.id - b.id);
    for (const post of posts) {
      const isRoot = rootId === null;
      const { rows: ins } = await p.query(
        'INSERT INTO posts (board, title, body, author, parent_id, rule_admitted, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [
          t.category,
          isRoot ? t.subject || null : null,
          post.note || post.body || '',
          post.seat || '[seed]',
          isRoot ? null : rootId,
          'R-SEED',
          post.time || t.created_at || new Date().toISOString(),
        ]
      );
      if (isRoot) rootId = ins[0].id;
    }
  }
}

async function insertPost({ board, title, body, author, parentId, rule }) {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query(
    'INSERT INTO posts (board, title, body, author, parent_id, rule_admitted) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at',
    [board, title || null, body, author, parentId || null, rule]
  );
  return rows[0];
}

async function listBoardsLatest() {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query(`
    SELECT board, COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS threads,
           MAX(created_at) AS last_activity
    FROM posts GROUP BY board`);
  return rows;
}

async function listThreads(board, limit = 100) {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query(
    `SELECT root.id, root.board, root.title, root.body, root.author, root.rule_admitted, root.created_at,
            (SELECT COUNT(*)::int FROM posts r WHERE r.parent_id = root.id) AS replies,
            (SELECT MAX(r.created_at) FROM posts r WHERE r.parent_id = root.id) AS last_reply_at
     FROM posts root
     WHERE root.board = $1 AND root.parent_id IS NULL
     ORDER BY root.created_at DESC
     LIMIT $2`,
    [board, limit]
  );
  return rows;
}

async function getThread(rootId) {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query(
    `SELECT * FROM posts WHERE id = $1 OR parent_id = $1 ORDER BY (parent_id IS NOT NULL), created_at ASC, id ASC`,
    [rootId]
  );
  if (!rows.length || rows[0].parent_id !== null) return null;
  return rows;
}

async function recentThreads(limit = 200) {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query(
    `SELECT id, board, title, author, rule_admitted, created_at,
            (SELECT COUNT(*)::int FROM posts r WHERE r.parent_id = posts.id) AS replies
     FROM posts WHERE parent_id IS NULL ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function ownerCommentsSince(sinceId, ownerName) {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query(
    `SELECT c.id, c.board, c.body, c.author, c.parent_id, c.created_at,
            (SELECT title FROM posts WHERE id = c.parent_id) AS thread_title,
            EXISTS (SELECT 1 FROM posts r WHERE r.parent_id = c.id) AS has_reply
     FROM posts c
     WHERE c.author = $1 AND c.id > $2 AND c.parent_id IS NOT NULL
     ORDER BY c.id ASC LIMIT 100`,
    [ownerName, sinceId || 0]
  );
  return rows;
}

async function maxPostId() {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query('SELECT COALESCE(MAX(id),0)::int AS max FROM posts');
  return rows[0].max;
}

async function ping() {
  const p = getPool();
  await p.query('SELECT 1');
  return true;
}

module.exports = {
  ensureSchema,
  insertPost,
  listBoardsLatest,
  listThreads,
  getThread,
  recentThreads,
  ownerCommentsSince,
  maxPostId,
  ping,
};
