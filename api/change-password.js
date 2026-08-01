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
import { USERS, verifyToken, verifyPassword, newScryptCredential, issueToken } from "../lib/auth.js";

const MIN_LENGTH = 10;

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
  if (String(newPassword).length < MIN_LENGTH) {
    return res.status(400).json({ error: `newPassword must be at least ${MIN_LENGTH} characters` });
  }

  const entry = USERS[session.email];
  if (!entry) return res.status(401).json({ error: "Unauthorized" });

  const override = await getUserCredentialOverride(session.email).catch(() => null);
  const cred = override || { salt: entry.salt, pwHash: entry.pwHash, algo: "pbkdf2" };
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
