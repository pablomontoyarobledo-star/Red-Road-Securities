// TEST ONLY — injects a fake deposit into pending-deposits.json and sends the email
// DELETE this file before going to production
import { put } from "@vercel/blob";

const BLOB_BASE = process.env.FUND_DATA_BLOB_URL?.replace("fund-data.json", "") || "";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const fakeDeposit = {
    id:          `2026-07-03_12345.00`,
    date:        "2026-07-03",
    amount:      12345.00,
    currency:    "USD",
    description: "TEST DEPOSIT — wire transfer",
  };

  // Load existing pending
  let pending = { deposits: [] };
  try {
    const r = await fetch(`${BLOB_BASE}pending-deposits.json?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) pending = await r.json();
  } catch {}

  // Avoid duplicate if already injected
  if (!pending.deposits.find(d => d.id === fakeDeposit.id)) {
    pending.deposits.push(fakeDeposit);
    await put("pending-deposits.json", JSON.stringify(pending), {
      access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
    });
  }

  // Send the notification email
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  const dep      = fakeDeposit;
  const base     = "https://red-road-securities.vercel.app";
  const btnStyle = "display:inline-block;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;margin:4px;";
  const investors = [
    { key: "fernando", label: "Fernando" },
    { key: "dario",    label: "Dario"    },
  ];
  const allocBtns = investors.map(inv =>
    `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=${inv.key}" style="${btnStyle}background:#1a6b3c;color:#fff;">Allocate to ${inv.label}</a>`
  ).join("\n");
  const newBtn = `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=new" style="${btnStyle}background:#1a3a6b;color:#fff;">New investor</a>`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    "Fund ONE <onboarding@resend.dev>",
      to:      ["pablomontoyarobledo@gmail.com"],
      subject: `[TEST] New deposit detected — $${dep.amount.toLocaleString("en-US")} on ${dep.date}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <div style="background:#e67e2220;border:1px solid #e67e22;border-radius:6px;padding:8px 12px;font-size:12px;color:#e67e22;margin-bottom:16px;">TEST — this is a simulated deposit</div>
          <h2 style="color:#1a6b3c;margin-bottom:4px;">New Deposit Detected</h2>
          <p style="color:#666;margin-top:0;">Fund ONE · Red Road Securities</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
            <tr><td style="padding:8px 0;color:#888;">Date</td><td style="padding:8px 0;font-weight:600;">${dep.date}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Amount</td><td style="padding:8px 0;font-weight:600;color:#1a6b3c;">$${dep.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Currency</td><td style="padding:8px 0;">${dep.currency}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Description</td><td style="padding:8px 0;">${dep.description}</td></tr>
          </table>
          <p style="font-size:14px;margin-bottom:12px;">Allocate this deposit to an investor:</p>
          ${allocBtns}
          ${newBtn}
          <p style="font-size:11px;color:#aaa;margin-top:24px;">This is a test. The deposit also appears in the admin panel under Pending Deposits.</p>
        </div>
      `,
    }),
  });

  const emailData = await emailRes.json();
  return res.status(200).json({ ok: true, deposit: fakeDeposit, email: emailData });
}
