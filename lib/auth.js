// Shared admin authentication for mutating API endpoints.
//
// Accepts either:
//   - a valid admin session token (Authorization: Bearer <token>) — issued at
//     login, same token the browser already holds once Pablo is signed in
//   - the sync secret (x-sync-secret header) — used by scripts/manual calls
//   - the cron secret (Authorization: Bearer <CRON_SECRET>) — used by Vercel cron
//
// Session tokens: base64url(email|iat|exp) + "." + HMAC-SHA256(SESSION_HMAC_SECRET, email|iat|exp).
//
// SESSION_HMAC_SECRET is deliberately separate from SYNC_SECRET: SYNC_SECRET
// is an API bypass credential (x-sync-secret header, used by scripts/cron),
// while this key only ever signs session tokens. Reusing one secret for both
// meant a SYNC_SECRET leak also let an attacker forge session tokens for any
// user, including admin — set SESSION_HMAC_SECRET in the environment to close
// that. Falls back to SYNC_SECRET if unset so existing deployments keep
// working until the new var is configured, but that fallback should not be
// relied on — set SESSION_HMAC_SECRET and rotate SYNC_SECRET afterward.

import crypto from "node:crypto";
import { getRevokedBefore, getInvestorAccountByEmail, getClaimToken } from "./store.js";

// Credentials live server-side only — never shipped to the browser.
export const USERS = {
  "pablomontoyarobledo@gmail.com":  { salt: "59504906f46fd7465716714946e181c0", pwHash: "313290f0660bf830feaeafbe6bd40f9bef7845697ac621bc1bcd9ec7afb4e6cf", name: "Pablo Montoya — Manager", admin: true  },
  "dario.montoya@mdosas.com":       { salt: "4b5fd6d20cd93ea26971e222a7af91cd", pwHash: "caf2b22ed9880313e46ce290d0af5a3d28abac729b6dec96253d85346abce7b7", name: "Dario Montoya",            admin: false },
  "fernando.montoya@mdosas.com":    { salt: "fb75245a1916299296edbd554d73db22", pwHash: "941bf8e89969456714cda3b9bce3de6958f7cbc52b0732cd23ceb1d6e5ba1549", name: "Fernando Montoya",         admin: false },
};

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLAIM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Shared with api/change-password.js and api/claim-account.js so the two
// "set a password" paths can't drift on what "strong enough" means.
export const MIN_PASSWORD_LENGTH = 10;

// ── Password hashing ────────────────────────────────────────────────────────
//
// The original scheme (still what USERS above holds) is PBKDF2-SHA256 at
// 100k iterations — a NIST-acceptable KDF, but not memory-hard, so it's
// cheaper to attack at scale on GPUs than scrypt/argon2/bcrypt. New/changed
// credentials (see lib/store.js#setUserCredential) use scrypt instead;
// verifyPassword() checks whichever algorithm a given credential was stored
// with, so both live side by side during the transition.
function pbkdf2Hash(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}
function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

// { salt, pwHash, algo: "pbkdf2" | "scrypt" }
export function verifyPassword(password, cred) {
  const computed = cred.algo === "scrypt" ? scryptHash(password, cred.salt) : pbkdf2Hash(password, cred.salt);
  if (computed.length !== cred.pwHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(cred.pwHash));
}

// Build a fresh scrypt-hashed credential for a new/changed password.
export function newScryptCredential(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, pwHash: scryptHash(password, salt), algo: "scrypt" };
}

function hmac(payload) {
  const key = process.env.SESSION_HMAC_SECRET || process.env.SYNC_SECRET || "";
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

// Resolve an email to a known user, checking the hardcoded USERS allowlist
// first (unchanged, no DB round trip) and falling back to a self-service
// account claimed via api/claim-account.js. Used by login (api/data.js) and
// by verifyToken() below so a claimed account's session tokens verify too.
export async function lookupUser(email) {
  if (USERS[email]) return { email, name: USERS[email].name, admin: USERS[email].admin };
  const account = await getInvestorAccountByEmail(email).catch(() => null);
  if (account) return { email, name: account.name, admin: false };
  return null;
}

export function issueToken(email) {
  const iat     = Date.now();
  const exp     = iat + TOKEN_TTL_MS;
  const payload = `${email}|${iat}|${exp}`;
  return Buffer.from(payload).toString("base64url") + "." + hmac(payload);
}

// Async because a revoked-sessions check requires a DB round trip — a leaked
// token needs to be invalidatable before its natural 30-day expiry (e.g. on
// password change), which a purely-stateless signature can't support.
export async function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  let payload;
  try { payload = Buffer.from(b64, "base64url").toString(); } catch { return null; }
  const expected = hmac(payload);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const parts = payload.split("|");
  // Accept both the current 3-part (email|iat|exp) and prior 2-part
  // (email|exp) payload shapes so tokens issued before this change don't all
  // get logged out at once; tokens without an iat simply can't be revoked
  // early (they'll still expire naturally).
  const [email, iat, exp] = parts.length === 3 ? parts : [parts[0], null, parts[1]];
  if (Date.now() > parseInt(exp, 10)) return null;

  // USERS is the fast path (no query); a claimed self-service account falls
  // through to a DB lookup, same as lookupUser() above.
  let admin;
  if (USERS[email]) {
    admin = USERS[email].admin;
  } else {
    const account = await getInvestorAccountByEmail(email).catch(() => null);
    if (!account) return null;
    admin = false;
  }

  if (iat != null) {
    const revokedBefore = await getRevokedBefore(email).catch(() => null);
    if (revokedBefore != null && parseInt(iat, 10) < revokedBefore) return null;
  }

  return { email, admin };
}

// ── Claim tokens (self-service account setup) ───────────────────────────────
//
// Same signed-payload shape as a session token, but with a "claim" type
// marker so one can never be replayed as the other, and backed by the
// claim_tokens table for single-use/revocation — a signature alone can't
// express "already used" or "superseded by a resend".
export function issueClaimToken({ investorId, email }) {
  const iat = Date.now();
  const exp = iat + CLAIM_TOKEN_TTL_MS;
  const jti = crypto.randomBytes(16).toString("hex");
  const payload = `claim|${investorId}|${email}|${iat}|${exp}|${jti}`;
  const token = Buffer.from(payload).toString("base64url") + "." + hmac(payload);
  return { token, jti, expiresAt: new Date(exp) };
}

// Read-only check — does NOT consume the token, so an investor can safely
// reopen the same link (e.g. to re-verify) before completing setup. Only
// markClaimTokenUsed() in api/claim-account.js's "complete" step consumes it.
export async function verifyClaimToken(token) {
  if (!token || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  let payload;
  try { payload = Buffer.from(b64, "base64url").toString(); } catch { return null; }
  const expected = hmac(payload);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const parts = payload.split("|");
  if (parts.length !== 6 || parts[0] !== "claim") return null;
  const [, investorId, email, , exp, jti] = parts;
  if (Date.now() > parseInt(exp, 10)) return null;

  const row = await getClaimToken(jti).catch(() => null);
  if (!row || row.usedAt || row.investorId !== investorId || row.email !== email) return null;

  return { investorId, email, jti };
}

function bearerToken(req) {
  return (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
}

// True if the request carries a valid admin session token, the sync secret,
// or the cron secret. Use for any endpoint that mutates fund/investor data.
export async function isAdminRequest(req) {
  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret && req.headers["x-sync-secret"] === syncSecret) return true;

  const cronSecret = process.env.CRON_SECRET;
  const bearer = bearerToken(req);
  if (cronSecret && bearer === cronSecret) return true;

  const session = await verifyToken(bearer);
  return !!(session && session.admin);
}

// Who is making this request, for audit-log attribution — an admin's email,
// or "sync-secret"/"cron" for scripted/cron callers. Returns null if none of
// the accepted credentials are present (caller should already have rejected
// the request via isAdminRequest before this matters).
export async function identifyActor(req) {
  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret && req.headers["x-sync-secret"] === syncSecret) return "sync-secret";

  const cronSecret = process.env.CRON_SECRET;
  const bearer = bearerToken(req);
  if (cronSecret && bearer === cronSecret) return "cron";

  const session = await verifyToken(bearer);
  return session ? session.email : null;
}
