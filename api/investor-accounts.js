// Admin-only: which investors have already claimed a self-service account —
// drives the "Invite" vs "Resend" label in the admin Investors tab.
//
//   GET   with  Authorization: Bearer <admin token>

import { listClaimedInvestorIds } from "../lib/store.js";
import { isAdminRequest } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  const claimed = await listClaimedInvestorIds();
  return res.status(200).json({ claimed });
}
