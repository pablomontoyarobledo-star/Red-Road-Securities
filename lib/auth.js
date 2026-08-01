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
import { getRevokedBefore } from "./store.js";

// Credentials live server-side only — never shipped to the browser.
export const USERS = {
  "pablomontoyarobledo@gmail.com":  { salt: "59504906f46fd7465716714946e181c0", pwHash: "313290f0660bf830feaeafbe6bd40f9bef7845697ac621bc1bcd9ec7afb4e6cf", name: "Pablo Montoya — Manager", admin: true  },
  "dario.montoya@mdosas.com":       { salt: "4b5fd6d20cd93ea26971e222a7af91cd", pwHash: "caf2b22ed9880313e46ce290d0af5a3d28abac729b6dec96253d85346abce7b7", name: "Dario Montoya",            admin: false },
  "fernando.montoya@mdosas.com":    { salt: "fb75245a1916299296edbd554d73db22", pwHash: "941bf8e89969456714cda3b9bce3de6958f7cbc52b0732cd23ceb1d6e5ba1549", name: "Fernando Montoya",         admin: false },
};

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hmac(payload) {
  const key = process.env.SESSION_HMAC_SECRET || process.env.SYNC_SECRET || "";
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
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
  if (!USERS[email] || Date.now() > parseInt(exp, 10)) return null;

  if (iat != null) {
    const revokedBefore = await getRevokedBefore(email).catch(() => null);
    if (revokedBefore != null && parseInt(iat, 10) < revokedBefore) return null;
  }

  return { email, admin: USERS[email].admin };
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
