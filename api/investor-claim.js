// Self-service account claim + admin invite/status — folded into one file to
// stay under Vercel's per-deployment Serverless Function cap (was
// investor-accounts.js + claim-account.js + send-claim-email.js).
//
//   GET                                                                admin  → claimed investor ids
//   POST { action: "invite",   investorId }                            admin  → (re)send claim-account email
//   POST { action: "verify",   token }                                 public → verify a claim link
//   POST { action: "complete", token, password, firstName, lastName }  public → finish claiming the account
//
// The claim token itself is the credential for verify/complete (signed,
// single-use, 7-day TTL; see lib/auth.js#verifyClaimToken). Never say *why* a
// link doesn't work (expired vs. already used vs. forged) — that would
// confirm whether an email/investor exists.

import {
  readDoc, backupAndWrite, markClaimTokenUsed, createInvestorAccount, setUserCredential,
  writeAuditLog, listClaimedInvestorIds, insertClaimToken, invalidateOutstandingClaimTokens,
} from "../lib/store.js";
import { isAdminRequest, verifyClaimToken, newScryptCredential, issueToken, issueClaimToken, MIN_PASSWORD_LENGTH } from "../lib/auth.js";
import { sendClaimAccountEmail } from "../lib/claimEmail.js";

function findInvestor(investors, investorId) {
  return investors.find(i => i.id === investorId);
}

async function handleClaimedStatus(req, res) {
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });
  const claimed = await listClaimedInvestorIds();
  return res.status(200).json({ claimed });
}

async function handleInvite(req, res, body) {
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

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

async function handleVerify(req, res, body) {
  const claim = await verifyClaimToken(body.token);
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

async function handleComplete(req, res, body) {
  const claim = await verifyClaimToken(body.token);
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
    } catch (err) { console.error("[investor-claim] investor name patch failed:", err.message); }
  }

  await writeAuditLog({ actor: claim.email, action: "account.claim", target: claim.investorId });

  return res.status(200).json({ ok: true, token: issueToken(claim.email), email: claim.email, name, admin: false });
}

export default async function handler(req, res) {
  if (req.method === "GET") return handleClaimedStatus(req, res);

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body.action === "invite")   return handleInvite(req, res, body);
    if (body.action === "verify")   return handleVerify(req, res, body);
    if (body.action === "complete") return handleComplete(req, res, body);
    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
