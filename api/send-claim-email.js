// Admin-triggered "invite" or "resend" — sends any investor already in
// investors.json a claim-account link, regardless of whether they were just
// created (api/allocate-deposit.js already auto-sends one for that case) or
// have been on the roster for a while with no login of their own (e.g.
// Dario, Fernando, or any other pre-existing investor).
//
//   POST { investorId }   with  Authorization: Bearer <admin token>

import { readDoc, insertClaimToken, invalidateOutstandingClaimTokens } from "../lib/store.js";
import { isAdminRequest, issueClaimToken } from "../lib/auth.js";
import { sendClaimAccountEmail } from "../lib/claimEmail.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { investorId } = body;
  if (!investorId) return res.status(400).json({ error: "investorId required" });

  const investorsData = await readDoc("investors.json");
  const investor = (investorsData?.investors || []).find(i => i.id === investorId);
  if (!investor) return res.status(404).json({ error: "Investor not found" });
  if (!investor.email) return res.status(400).json({ error: "This investor has no email on file" });

  const email = investor.email.toLowerCase();

  // Old outstanding links must stop working once a fresh one is issued —
  // otherwise a leaked earlier email could still claim the account.
  await invalidateOutstandingClaimTokens(investorId);

  const { token, jti, expiresAt } = issueClaimToken({ investorId, email });
  await insertClaimToken({ jti, investorId, email, expiresAt });
  await sendClaimAccountEmail({
    to: investor.email, firstName: investor.firstName, lang: investor.lang || "en", token,
  });

  return res.status(200).json({ ok: true });
}
