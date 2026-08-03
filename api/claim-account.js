// Unauthenticated self-service account setup — the claim token itself is the
// credential (signed, single-use, 7-day TTL; see lib/auth.js#verifyClaimToken).
//
//   POST { action: "verify",   token }
//   POST { action: "complete", token, password, firstName, lastName }

import { readDoc, backupAndWrite, markClaimTokenUsed, createInvestorAccount, setUserCredential, writeAuditLog } from "../lib/store.js";
import { verifyClaimToken, newScryptCredential, issueToken, MIN_PASSWORD_LENGTH } from "../lib/auth.js";

function findInvestor(investors, investorId) {
  return investors.find(i => i.id === investorId);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { action, token } = body;

  if (action === "verify") {
    const claim = await verifyClaimToken(token);
    // Never say *why* a link doesn't work (expired vs. already used vs.
    // forged) — that would confirm whether an email/investor exists.
    if (!claim) return res.status(401).json({ error: "Invalid or expired link" });

    const investorsData = await readDoc("investors.json");
    const investor = findInvestor(investorsData?.investors || [], claim.investorId);
    return res.status(200).json({
      ok: true,
      email: claim.email,
      firstName: investor?.firstName || "",
      lastName:  investor?.lastName  || "",
    });
  }

  if (action === "complete") {
    const claim = await verifyClaimToken(token);
    if (!claim) return res.status(401).json({ error: "Invalid or expired link" });

    const password = String(body.password || "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const consumed = await markClaimTokenUsed(claim.jti);
    if (!consumed) return res.status(409).json({ error: "This link has already been used" });

    const firstName = String(body.firstName || "").trim();
    const lastName  = String(body.lastName || "").trim();
    const name = [firstName, lastName].filter(Boolean).join(" ") || claim.email;

    await setUserCredential(claim.email, newScryptCredential(password));
    await createInvestorAccount({ email: claim.email, investorId: claim.investorId, name });

    // Best-effort: let the investor correct their own name at claim time.
    if (firstName || lastName) {
      try {
        const investorsData = await readDoc("investors.json");
        const investor = findInvestor(investorsData?.investors || [], claim.investorId);
        if (investor && (firstName !== investor.firstName || lastName !== investor.lastName)) {
          if (firstName) investor.firstName = firstName;
          if (lastName)  investor.lastName  = lastName;
          await backupAndWrite("investors.json", investorsData);
        }
      } catch (err) { console.error("[claim-account] investor name patch failed:", err.message); }
    }

    await writeAuditLog({ actor: claim.email, action: "account.claim", target: claim.investorId });

    return res.status(200).json({ ok: true, token: issueToken(claim.email), email: claim.email, name, admin: false });
  }

  return res.status(400).json({ error: "Unknown action" });
}
