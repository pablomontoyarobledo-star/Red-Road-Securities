// Authenticated self-service password change.
//
//   POST { currentPassword, newPassword }   with  Authorization: Bearer <token>
//     → verifies the caller's current password, stores a new scrypt-hashed
//       credential, revokes every outstanding session for the account (so a
//       leaked old token stops working immediately), and returns a freshly
//       issued token for the caller's own session to keep working.
//
// Any authenticated user (not just admin) may change their own password;
// this never accepts a target email from the client — it always acts on the
// session's own identity.

import { getUserCredentialOverride, setUserCredential, revokeSessionsNow, writeAuditLog } from "../lib/store.js";
import { USERS, verifyToken, verifyPassword, newScryptCredential, issueToken, MIN_PASSWORD_LENGTH } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const bearer  = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const session = await verifyToken(bearer);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }
  if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  // verifyToken() already confirmed session.email is a known user (hardcoded
  // or a claimed self-service account) — no separate USERS check needed here.
  // A self-service account has no hardcoded fallback; user_credentials is its
  // only credential (written at claim time via api/investor-claim.js).
  const override = await getUserCredentialOverride(session.email).catch(() => null);
  const cred = override || (USERS[session.email] ? { salt: USERS[session.email].salt, pwHash: USERS[session.email].pwHash, algo: "pbkdf2" } : null);
  if (!cred) return res.status(401).json({ error: "Unauthorized" });
  if (!verifyPassword(String(currentPassword), cred)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  await setUserCredential(session.email, newScryptCredential(String(newPassword)));

  // Invalidate every token issued before this moment for this account,
  // including the one used to make this request.
  await revokeSessionsNow(session.email);
  await writeAuditLog({ actor: session.email, action: "password.change" });

  // Issue a fresh token (iat is now, so it's past the revocation cutoff) so
  // the caller's own session keeps working without forcing a re-login.
  return res.status(200).json({ ok: true, token: issueToken(session.email) });
}
