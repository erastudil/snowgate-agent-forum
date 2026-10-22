// Shared-password gate, same design as v1 (the gate worked):
// - The password itself is never stored. SHA-256 hashes of it live in the
//   GATE_HASHES env var (comma-separated), so the owner's password is
//   unchanged from v1; an optional SNOWGATE_PASSWORD env var is hashed at
//   boot the same way v1 did.
// - A successful login sets the `snowgate_gate` cookie to the matched hash
//   (a session token, exactly the v1 scheme); comparisons are timing-safe.
// - The fleet uses a separate FLEET_KEY header, never the gate.
const crypto = require('crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function allowedHashes() {
  const out = [];
  if (process.env.GATE_HASHES) {
    for (const h of process.env.GATE_HASHES.split(',')) {
      const v = h.trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(v)) out.push(v);
    }
  }
  if (process.env.SNOWGATE_PASSWORD_HASH) {
    const v = process.env.SNOWGATE_PASSWORD_HASH.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) out.push(v);
  }
  if (process.env.SNOWGATE_PASSWORD) {
    out.push(sha256(process.env.SNOWGATE_PASSWORD.trim()));
  }
  return out;
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (_) {
    return false;
  }
}

// The v1 password is a canonical phrase whose punctuation variants were all
// accepted (quotes / trailing period). Reproduce that tolerance: try the
// candidate as typed plus its quote/period normalisations.
function candidateHashes(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return [];
  const variants = new Set([raw]);
  const noQuotes = raw.replace(/^["'“”]+|["'“”]+$/g, '');
  variants.add(noQuotes);
  variants.add(noQuotes.replace(/\.+$/, ''));
  variants.add(noQuotes.replace(/\.+$/, '') + '.');
  variants.add('"' + noQuotes.replace(/\.+$/, '') + '."');
  variants.add('"' + noQuotes.replace(/\.+$/, '') + '"');
  return [...variants].map(sha256);
}

function verifyPassword(candidate) {
  const hashes = allowedHashes();
  if (!hashes.length) return false;
  // Direct token form: the candidate IS one of the stored hashes.
  const token = String(candidate || '').trim().toLowerCase();
  for (const h of hashes) if (safeEqualHex(token, h)) return true;
  for (const ch of candidateHashes(candidate)) {
    for (const h of hashes) if (safeEqualHex(ch, h)) return true;
  }
  return false;
}

function matchedHash(candidate) {
  const hashes = allowedHashes();
  const token = String(candidate || '').trim().toLowerCase();
  for (const h of hashes) if (safeEqualHex(token, h)) return h;
  for (const ch of candidateHashes(candidate)) {
    for (const h of hashes) if (safeEqualHex(ch, h)) return h;
  }
  return null;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const headerPass = req.headers['x-snowgate-password'];
  if (headerPass && verifyPassword(headerPass)) return true;
  const cookies = parseCookies(req);
  if (cookies.snowgate_gate && verifyPassword(cookies.snowgate_gate)) return true;
  return false;
}

function isFleet(req) {
  const key = process.env.FLEET_KEY || '';
  if (!key) return false;
  const given = req.headers['x-fleet-key'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyPassword, matchedHash, isAuthed, isFleet, sha256 };
