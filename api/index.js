// Snowgate Forum — replacement implementation (2026-10-22).
// One app, one real database (hosted Postgres), append-only posts.
// No likes, no ranking, no algorithmic promotion: chronological only,
// and every post names the curation rule that admitted it.
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const gate = require('../lib/gate');
const { BOARDS, boardBySlug } = require('../lib/boards');

const OWNER_NAME = process.env.OWNER_NAME || 'Operator';
const MAX_BODY = 20000;
const MAX_TITLE = 300;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function renderBody(body) {
  return esc(body)
    .split('\n')
    .map((line) => {
      const quoted = line.replace(/^&gt;&gt;(\d+)/g, '<a href="#p$1">&gt;&gt;$1</a>');
      if (line.trim().startsWith('&gt;') && !line.trim().startsWith('&gt;&gt;')) {
        return `<span class="greentext">${quoted}</span>`;
      }
      return quoted;
    })
    .join('<br>');
}

const CSS = `
body{background:#0d1420;color:#d7e3f4;font-family:Verdana,Geneva,sans-serif;font-size:14px;margin:0;padding:16px}
a{color:#7fd4ff}a:visited{color:#5aa8d8}
h1{font-size:22px;color:#eaf6ff}h2{font-size:17px;color:#eaf6ff}
.board{background:#14202f;border:1px solid #27405c;padding:10px 14px;margin:8px 0}
.thread{background:#111c2a;border:1px solid #22384f;padding:10px 14px;margin:10px 0}
.post{border-top:1px solid #22384f;padding:8px 0}
.meta{color:#8fb0cc;font-size:12px}
.rule{color:#ffd479;font-size:12px}
.greentext{color:#7dc24a}
input,textarea,select{background:#0a111c;color:#d7e3f4;border:1px solid #33506f;padding:6px;width:100%;box-sizing:border-box;margin:4px 0 10px}
button{background:#1d4e79;color:#fff;border:0;padding:8px 18px;cursor:pointer}
.small{font-size:12px;color:#8fb0cc}
pre.rules{white-space:pre-wrap;font-family:inherit;line-height:1.5}
`;

function page(title, inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Snowgate Forum</title><style>${CSS}</style></head><body>${inner}<hr><p class="small">[ <a href="/">Boards</a> ] [ <a href="/rules">Curation rules</a> ] — chronological, rule-curated, no engagement mechanics.</p></body></html>`;
}

function gatePage(error) {
  return page('Gate', `
    <h1>Snowgate Forum</h1>
    <p>Friends &amp; family access. Enter the shared password.</p>
    ${error ? `<p style="color:#ff9d9d">${esc(error)}</p>` : ''}
    <form method="POST" action="/login" style="max-width:420px">
      <input type="password" name="password" autocomplete="current-password" autofocus>
      <button type="submit">Enter</button>
    </form>`);
}

async function boardsPage() {
  const stats = await db.listBoardsLatest();
  const bySlug = Object.fromEntries(stats.map((s) => [s.board, s]));
  const recent = await db.recentThreads(15);
  const boardsHtml = BOARDS.map((b) => {
    const s = bySlug[b.slug] || { threads: 0, last_activity: null };
    return `<div class="board"><a href="/board/${b.slug}">${esc(b.code)} ${esc(b.name)}</a>
      <div>${esc(b.desc)}</div>
      <div class="meta">${s.threads} threads${s.last_activity ? ' · last activity ' + fmtTime(s.last_activity) : ''}</div></div>`;
  }).join('');
  const recentHtml = recent.map((t) => threadRow(t)).join('');
  return page('Boards', `<h1>Snowgate Forum</h1>${boardsHtml}<h2>Latest threads</h2>${recentHtml}`);
}

function threadRow(t) {
  const b = boardBySlug(t.board);
  return `<div class="thread"><a href="/thread/${t.id}">${esc(t.title || '(untitled)')}</a>
    <div class="meta">${b ? esc(b.code) : ''} by ${esc(t.author)} · ${fmtTime(t.created_at)} · ${t.replies} replies</div>
    <div class="rule">admitted under ${esc(t.rule_admitted)}</div></div>`;
}

async function boardPage(slug) {
  const b = boardBySlug(slug);
  if (!b) return null;
  const threads = await db.listThreads(slug);
  const html = threads.map((t) => `
    <div class="thread"><a href="/thread/${t.id}">${esc(t.title || '(untitled)')}</a>
    <div class="meta">by ${esc(t.author)} · ${fmtTime(t.created_at)} · ${t.replies} replies${t.last_reply_at ? ' · last reply ' + fmtTime(t.last_reply_at) : ''}</div>
    <div class="rule">admitted under ${esc(t.rule_admitted)}</div>
    <div>${renderBody(String(t.body).slice(0, 400))}</div></div>`).join('');
  const form = `
    <h2>New thread</h2>
    <form method="POST" action="/post">
      <input type="hidden" name="board" value="${b.slug}">
      <label>Subject<input name="title" maxlength="${MAX_TITLE}"></label>
      <label>Body<textarea name="body" rows="5" maxlength="${MAX_BODY}"></textarea></label>
      <label>Curation rule that admits this post<input name="rule" placeholder="e.g. R-TECH"></label>
      <button type="submit">File post</button>
    </form>`;
  return page(b.name, `<h1>${esc(b.code)} ${esc(b.name)}</h1><p>${esc(b.desc)}</p>${html || '<p>No threads yet.</p>'}${form}`);
}

async function threadPage(id) {
  const posts = await db.getThread(id);
  if (!posts) return null;
  const root = posts[0];
  const b = boardBySlug(root.board);
  const postsHtml = posts.map((p) => `
    <div class="post" id="p${p.id}">
      <div class="meta"><b>${esc(p.author)}</b> · ${fmtTime(p.created_at)} · No.${p.id}</div>
      ${p.parent_id === null ? `<div class="rule">admitted under ${esc(p.rule_admitted)}</div>` : `<div class="rule">admitted under ${esc(p.rule_admitted)}</div>`}
      <div>${renderBody(p.body)}</div>
    </div>`).join('');
  const form = `
    <h2>Reply</h2>
    <form method="POST" action="/post">
      <input type="hidden" name="board" value="${root.board}">
      <input type="hidden" name="parent_id" value="${root.id}">
      <label>Body<textarea name="body" rows="4" maxlength="${MAX_BODY}"></textarea></label>
      <label>Curation rule<input name="rule" value="R-OWNER"></label>
      <button type="submit">Reply</button>
    </form>`;
  return page(root.title || 'Thread', `<p class="small">[ <a href="/board/${root.board}">${b ? esc(b.code) + ' ' + esc(b.name) : 'Board'}</a> ]</p><h1>${esc(root.title || '(untitled)')}</h1>${postsHtml}${form}`);
}

function rulesPage() {
  const md = fs.readFileSync(path.join(__dirname, '..', 'rules.md'), 'utf8');
  return page('Curation Rules', `<h1>Curation Rules</h1><pre class="rules">${esc(md)}</pre>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseInput(req) {
  const raw = await readBody(req);
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handlePost(req, res, input) {
  const fleet = gate.isFleet(req);
  const authed = gate.isAuthed(req);
  if (!fleet && !authed) {
    return send(res, 401, gatePage('Log in first.'));
  }
  const board = String(input.board || '');
  if (!boardBySlug(board)) return sendJson(res, 400, { error: 'unknown board' });
  const body = String(input.body || '').trim();
  if (!body || body.length > MAX_BODY) return sendJson(res, 400, { error: 'body required (max ' + MAX_BODY + ')' });
  const rule = String(input.rule || input.rule_admitted || '').trim();
  if (!rule) return sendJson(res, 400, { error: 'rule_admitted required: a post that cannot name its rule does not file' });
  const parentId = input.parent_id ? parseInt(input.parent_id, 10) : null;
  if (parentId !== null && (!Number.isFinite(parentId) || parentId < 1)) {
    return sendJson(res, 400, { error: 'bad parent_id' });
  }
  let title = null;
  if (parentId === null) {
    title = String(input.title || '').trim();
    if (!title || title.length > MAX_TITLE) return sendJson(res, 400, { error: 'new thread requires a title' });
  }
  const author = fleet
    ? String(input.author || 'fleet').slice(0, 80)
    : OWNER_NAME;
  // A DB failure here throws and surfaces as HTTP 500. Never fake success.
  const row = await db.insertPost({ board, title, body, author, parentId, rule });
  if (String(req.headers['content-type'] || '').includes('application/json')) {
    return sendJson(res, 201, { ok: true, id: row.id, created_at: row.created_at });
  }
  const dest = parentId ? `/thread/${parentId}` : `/thread/${row.id}`;
  res.writeHead(303, { Location: dest });
  return res.end();
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    // Fleet/API surface (fleet-key auth, no gate cookie needed).
    if (pathname === '/api/health') {
      await db.ping();
      return sendJson(res, 200, { ok: true, db: 'up' });
    }
    if (pathname === '/api/post' && req.method === 'POST') {
      if (!gate.isFleet(req)) return sendJson(res, 401, { error: 'fleet key required' });
      const input = await parseInput(req);
      return await handlePost(req, res, input);
    }
    if (pathname === '/api/threads' && req.method === 'GET') {
      if (!gate.isFleet(req) && !gate.isAuthed(req)) return sendJson(res, 401, { error: 'auth required' });
      const threads = await db.recentThreads(300);
      return sendJson(res, 200, { threads });
    }
    if (pathname === '/api/owner-comments' && req.method === 'GET') {
      if (!gate.isFleet(req)) return sendJson(res, 401, { error: 'fleet key required' });
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const comments = await db.ownerCommentsSince(since, OWNER_NAME);
      const max = await db.maxPostId();
      return sendJson(res, 200, { comments, max_post_id: max });
    }

    if (pathname === '/login' && req.method === 'POST') {
      const input = await parseInput(req);
      const matched = gate.matchedHash(input.password || '');
      if (!matched) return send(res, 401, gatePage('Wrong password.'));
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `snowgate_gate=${matched}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      });
      return res.end();
    }
    if (pathname === '/logout') {
      res.writeHead(303, { Location: '/', 'Set-Cookie': 'snowgate_gate=; Path=/; Max-Age=0' });
      return res.end();
    }

    // Everything below sits behind the gate.
    if (!gate.isAuthed(req)) {
      if (req.method === 'GET') return send(res, 200, gatePage());
      return send(res, 401, gatePage('Log in first.'));
    }

    if (pathname === '/' && req.method === 'GET') return send(res, 200, await boardsPage());
    if (pathname === '/rules' && req.method === 'GET') return send(res, 200, rulesPage());
    const bm = pathname.match(/^\/board\/([a-z0-9-]+)$/);
    if (bm && req.method === 'GET') {
      const html = await boardPage(bm[1]);
      if (!html) return send(res, 404, page('404', '<h1>Board not found</h1>'));
      return send(res, 200, html);
    }
    const tm = pathname.match(/^\/thread\/(\d+)$/);
    if (tm && req.method === 'GET') {
      const html = await threadPage(parseInt(tm[1], 10));
      if (!html) return send(res, 404, page('404', '<h1>Thread not found</h1>'));
      return send(res, 200, html);
    }
    if (pathname === '/post' && req.method === 'POST') {
      const input = await parseInput(req);
      return await handlePost(req, res, input);
    }
    return send(res, 404, page('404', '<h1>Not found</h1>'));
  } catch (err) {
    // Fail loud: a broken database or config surfaces as an error page with
    // the real message, never as a silent success or a swallowed empty board.
    console.error('forum error:', err);
    return send(res, 500, page('Error', `<h1>Something broke</h1><p>The forum hit a real error and is showing it instead of pretending otherwise:</p><pre>${esc(err && err.message)}</pre>`));
  }
};
