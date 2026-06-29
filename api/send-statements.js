// Vercel Cron: runs daily on days 28-31, checks if today is the last day of the month.
// Schedule in vercel.json: "0 13 28-31 * *" (1pm UTC)

function isLastDayOfMonth() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return tomorrow.getDate() === 1;
}

function fmt(n, decimals = 2) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const str = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (n < 0 ? "-$" : "$") + str;
}

function fmtPct(n) {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function computeOwnership(deposits) {
  // Replicate the unit/NAV method from index.html
  let fernandoUnits = 0, darioUnits = 0;
  for (const d of deposits) {
    const nav = parseFloat(d.nav) || 1;
    const fAmt = parseFloat(d.fernando) || 0;
    const dAmt = parseFloat(d.dario) || 0;
    fernandoUnits += fAmt / nav;
    darioUnits += dAmt / nav;
  }
  const totalUnits = fernandoUnits + darioUnits;
  return { fernandoUnits, darioUnits, totalUnits };
}

function statementHtml({ investor, data, period }) {
  const { positions = [], deposits = [], perfData = {}, cashBalance = 0 } = data;

  // Compute totals
  const totalDeposited = deposits.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const fernandoDeposited = deposits.reduce((s, d) => s + (parseFloat(d.fernando) || 0), 0);
  const darioDeposited = deposits.reduce((s, d) => s + (parseFloat(d.dario) || 0), 0);

  const posValue = positions.reduce((s, p) => s + (parseFloat(p.shares) * parseFloat(p.ibClose || p.costBasis)), 0);
  const totalValue = posValue + cashBalance;

  const { fernandoUnits, darioUnits, totalUnits } = computeOwnership(deposits);
  const navPerUnit = totalUnits > 0 ? totalValue / totalUnits : 1;

  const isFernando = investor.name.toLowerCase().includes("fernando");
  const myUnits = isFernando ? fernandoUnits : darioUnits;
  const myPct = totalUnits > 0 ? (myUnits / totalUnits) * 100 : 0;
  const myValue = myUnits * navPerUnit;
  const myDeposited = isFernando ? fernandoDeposited : darioDeposited;
  const myGL = myValue - myDeposited;
  const myReturn = myDeposited > 0 ? (myGL / myDeposited) * 100 : 0;

  // TWR: use indexed return series (base 100), not absolute dollar values
  const twrSeries = (data.twrSeries || []);
  const twr = twrSeries.length >= 2
    ? ((twrSeries[twrSeries.length - 1] / twrSeries[0] - 1) * 100)
    : 0;

  // Investor's own deposits
  const myDeposits = deposits
    .map(d => ({
      date: d.date,
      amount: isFernando ? parseFloat(d.fernando) : parseFloat(d.dario),
    }))
    .filter(d => d.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const depRows = myDeposits.map(d => `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #f0ede8;font-size:12px;color:#4a4742;">${d.date}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f0ede8;font-size:12px;color:#4a4742;text-align:right;">${fmt(d.amount, 0)}</td>
    </tr>`).join("");

  // Period label: last month name
  const periodLabel = period || new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f0;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#1a1a1a;padding:28px 36px;">
    <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:6px;">Red Road Securities</div>
    <div style="font-size:22px;font-weight:600;color:#ffffff;">Fund ONE</div>
    <div style="font-size:13px;color:#aaa;margin-top:4px;">Investor Statement — ${periodLabel}</div>
  </td></tr>

  <!-- Investor info -->
  <tr><td style="padding:20px 36px 0;border-bottom:1px solid #f0ede8;">
    <div style="font-size:11px;color:#999;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Prepared for</div>
    <div style="font-size:16px;font-weight:500;color:#1a1a1a;">${investor.name}</div>
    <div style="font-size:12px;color:#888;margin-bottom:16px;">${today}</div>
  </td></tr>

  <!-- Capital Account Summary -->
  <tr><td style="padding:24px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">Capital Account Summary</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:9px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">Total deposited (since inception)</td>
        <td style="padding:9px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${fmt(myDeposited, 0)}</td>
      </tr>
      <tr>
        <td style="padding:9px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">Investment gain / loss</td>
        <td style="padding:9px 0;font-size:13px;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;color:${myGL >= 0 ? "#2a7a4b" : "#c0392b"};">${fmt(myGL)}</td>
      </tr>
      <tr style="background:#f9f8f6;">
        <td style="padding:12px 10px;font-size:14px;color:#1a1a1a;font-weight:600;border-radius:6px 0 0 6px;">Your current value</td>
        <td style="padding:12px 10px;font-size:16px;color:#1a1a1a;font-weight:700;text-align:right;border-radius:0 6px 6px 0;">${fmt(myValue)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Ownership & Return -->
  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">Your Ownership</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">Ownership %</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${myPct.toFixed(2)}%</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">Units held</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${myUnits.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">NAV per unit</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${fmt(navPerUnit, 4)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;">Your return since inception</td>
        <td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right;color:${myReturn >= 0 ? "#2a7a4b" : "#c0392b"};">${fmtPct(myReturn)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Fund Performance -->
  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">Fund ONE Performance</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">Total fund value</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${fmt(totalValue, 0)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;">TWR since inception (Dec 2025)</td>
        <td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right;color:${twr >= 0 ? "#2a7a4b" : "#c0392b"};">${fmtPct(twr)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Deposit History -->
  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">Your Deposit History</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ede8;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f9f8f6;">
          <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;letter-spacing:0.5px;">DATE</th>
          <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;letter-spacing:0.5px;">AMOUNT</th>
        </tr>
      </thead>
      <tbody>${depRows}</tbody>
      <tr style="background:#f9f8f6;">
        <td style="padding:9px 10px;font-size:13px;font-weight:600;color:#1a1a1a;">Total</td>
        <td style="padding:9px 10px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">${fmt(myDeposited, 0)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:28px 36px;margin-top:8px;">
    <div style="border-top:1px solid #f0ede8;padding-top:20px;">
      <div style="font-size:11px;color:#bbb;line-height:1.6;">
        This statement is prepared by <strong>Red Road Securities / MONECHE &amp; SONS LLC</strong> for informational purposes only.
        It is not a tax document. Past performance does not guarantee future results.
        IB account U23388477.
      </div>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export default async function handler(req, res) {
  const isManual = req.method === "POST";

  if (isManual) {
    const auth = req.headers["x-sync-secret"];
    if (auth !== process.env.SYNC_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!isManual && !isLastDayOfMonth()) {
    return res.status(200).json({ skipped: true, reason: "Not the last day of the month" });
  }

  const blobUrl = process.env.FUND_DATA_BLOB_URL;
  if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });

  let data;
  try {
    const blobRes = await fetch(`${blobUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (!blobRes.ok) throw new Error(`Blob fetch failed: ${blobRes.status}`);
    data = await blobRes.json();
  } catch (err) {
    return res.status(500).json({ error: `Failed to load fund data: ${err.message}` });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  const now = new Date();
  const periodDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = periodDate.toLocaleString("en-US", { month: "long", year: "numeric" });

  const investors = [
    { name: "Fernando Montoya", email: "fernando.montoya@mdosas.com" },
    { name: "Dario Montoya",    email: "dario.montoya@mdosas.com"    },
  ];

  const results = [];

  for (const investor of investors) {
    const html = statementHtml({ investor, data, period });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Fund ONE <onboarding@resend.dev>",
        to: ["pablomontoyarobledo@gmail.com"],
        subject: `Fund ONE — ${period} Investor Statement [TEST — for ${investor.name}]`,
        html,
      }),
    });

    const result = await emailRes.json();
    results.push({ investor: investor.name, status: emailRes.status, result });
  }

  return res.status(200).json({ sent: results, debug: { twrSeriesLength: data.twrSeries?.length, twrSeriesFirst: data.twrSeries?.[0], twrSeriesLast: data.twrSeries?.[data.twrSeries?.length-1] } });
}
