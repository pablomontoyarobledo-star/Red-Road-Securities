// Authenticated data gateway.
//
//   POST { action: "login", email, password }
//     → verifies credentials server-side (PBKDF2), returns an HMAC session token
//   GET  ?file=<name>   with  Authorization: Bearer <token>
//     → serves whitelisted datasets from Neon (documents never reach the client
//       except through this authenticated proxy)
//
// Session tokens: base64url(email|exp) + "." + HMAC-SHA256(SYNC_SECRET, email|exp).
// Tokens expire after 30 days.

import { getUserCredentialOverride, setUserCredential, readDoc, recordLoginFailure, resetLoginFailures, getLoginFailureState } from "../lib/store.js";
import { USERS, issueToken, verifyToken, verifyPassword, newScryptCredential, lookupUser } from "../lib/auth.js";
import { computeTotalUnitsAtDate, investorKeysFor, depositBelongsTo } from "../lib/nav.js";

// After this many consecutive failures for an email, lock out further
// attempts (regardless of whether the password submitted is correct) for
// the lockout window. Resets to zero on any successful login.
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS         = 15 * 60 * 1000;

// Files any logged-in investor may read; admin additionally gets pending-deposits.
// ib-cache.json is the latest raw IB snapshot (positions + close prices +
// account total) — the dashboard uses it to live-adjust the fund value.
const READABLE       = new Set(["fund-data.json", "investors.json", "nav-history.json", "trades-history.json", "ib-cache.json"]);
const READABLE_ADMIN = new Set([...READABLE, "pending-deposits.json"]);

function hasSyncSecret(req) {
  const s = process.env.SYNC_SECRET;
  if (s && req.headers["x-sync-secret"] === s) return true;
  const c = process.env.CRON_SECRET;
  return !!(c && req.headers["authorization"] === `Bearer ${c}`);
}

// A non-admin investor may see fund-wide figures (positions, NAV, cash) but
// must never see another investor's individual deposit records — those carry
// another person's name and exact contribution amount. Scope deposits down to
// the requesting investor's own before the response leaves the server.
//
// The client computes ownership % as (my units / total fund units), so it
// still needs an accurate fund-wide unit total even though it can no longer
// see the other deposits that total is built from — attach it precomputed
// (same math as lib/nav.js uses for NAV) rather than exposing the records.
function scopeFundDataToInvestor(fundData, keys) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const totalUnitsOutstanding = computeTotalUnitsAtDate(fundData.deposits, todayStr);
  return {
    ...fundData,
    deposits: (fundData.deposits || []).filter(d => depositBelongsTo(d, keys)),
    totalUnitsOutstanding,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (body.action === "login") {
      const email = String(body.email || "").trim().toLowerCase();

      // Rate-limit by email regardless of whether it's a known account —
      // otherwise brute-forcing an unrecognized-but-guessed email would be
      // untracked. Locked out just means "try again later", not "wrong
      // password", so it doesn't leak which emails are real accounts.
      const failState = email ? await getLoginFailureState(email).catch(() => null) : null;
      if (failState && failState.failCount >= MAX_LOGIN_ATTEMPTS) {
        const elapsed = Date.now() - new Date(failState.updatedAt).getTime();
        if (elapsed < LOCKOUT_MS) {
          return res.status(429).json({ error: "Too many failed attempts — try again later" });
        }
      }

      const entry = await lookupUser(email).catch(() => null);
      if (!entry || !body.password) {
        if (email) recordLoginFailure(email).catch(() => {});
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // A changed password lives in Neon (user_credentials) and overrides the
      // hardcoded entry; otherwise fall back to the PBKDF2 hash in lib/auth.js.
      // Self-service accounts (claimed via api/claim-account.js) have no
      // hardcoded fallback — user_credentials is their only credential.
      const override = await getUserCredentialOverride(email).catch(() => null);
      const cred = override || (USERS[email] ? { salt: USERS[email].salt, pwHash: USERS[email].pwHash, algo: "pbkdf2" } : null);
      if (!cred) {
        recordLoginFailure(email).catch(() => {});
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (!verifyPassword(String(body.password), cred)) {
        recordLoginFailure(email).catch(() => {});
        return res.status(401).json({ error: "Invalid credentials" });
      }

      resetLoginFailures(email).catch(() => {});

      // Transparently upgrade off PBKDF2 onto scrypt (memory-hard) the moment
      // we have the plaintext password in hand from a successful login.
      if (cred.algo === "pbkdf2") {
        setUserCredential(email, newScryptCredential(String(body.password))).catch(() => {});
      }

      return res.status(200).json({ token: issueToken(email), email, name: entry.name, admin: entry.admin });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  if (req.method === "GET") {
    const file = String(req.query?.file || "");
    // Admin tooling may also read with the sync secret directly
    const session = hasSyncSecret(req)
      ? { email: "admin", admin: true }
      : await verifyToken((req.headers["authorization"] || "").replace(/^Bearer\s+/i, ""));
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const allowed = session.admin ? READABLE_ADMIN : READABLE;
    if (!allowed.has(file)) return res.status(403).json({ error: "File not allowed" });

    try {
      const data = await readDoc(file);
      if (data == null) return res.status(404).json({ error: "Not found" });

      // fund-data.json's deposits array carries every investor's name and
      // contribution amount — scope it to the caller's own records unless
      // they're an admin (or a scripted sync-secret/cron caller, which is
      // fund-operations tooling, not a specific investor).
      if (file === "fund-data.json" && !session.admin) {
        const investorsDoc = await readDoc("investors.json").catch(() => null);
        const inv = (investorsDoc?.investors || [])
          .find(i => (i.email || "").toLowerCase() === session.email.toLowerCase());
        const scoped = inv ? scopeFundDataToInvestor(data, investorKeysFor(inv)) : { ...data, deposits: [] };
        return res.status(200).json(scoped);
      }

      return res.status(200).json(data);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
