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
  const str = abs.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (n < 0 ? "-$" : "$") + str;
}

function fmtPct(n) {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

// Map investor firstName (lowercase) → deposit field key
function depositKey(investor) {
  return investor.firstName.toLowerCase();
}

function computeInvestorUnits(deposits, key) {
  return deposits.reduce((sum, d) => {
    const nav = parseFloat(d.nav) || 1;
    return sum + (parseFloat(d[key]) || 0) / nav;
  }, 0);
}

function computeTotalUnits(deposits, investors) {
  return investors.reduce((sum, inv) => sum + computeInvestorUnits(deposits, depositKey(inv)), 0);
}

const T = {
  en: {
    preparedFor: "Prepared for",
    capitalSummary: "Capital Account Summary",
    totalDeposited: "Total deposited (since inception)",
    gainLoss: "Investment gain / loss",
    currentValue: "Your current value",
    ownership: "Your Ownership",
    ownershipPct: "Ownership %",
    unitsHeld: "Units held",
    navPerUnit: "NAV per unit",
    yourReturn: "Your return since inception",
    fundPerf: "Fund ONE Performance",
    totalFundValue: "Total fund value",
    twrLabel: "TWR since inception (Dec 2025)",
    depositHistory: "Your Deposit History",
    date: "DATE",
    amount: "AMOUNT",
    total: "Total",
    subject: (period) => `Fund ONE — ${period} Investor Statement`,
    disclaimer: "This statement is prepared by <strong>Red Road Securities / MONECHE &amp; SONS LLC</strong> for informational purposes only. It is not a tax document. Past performance does not guarantee future results. IB account U23388477.",
  },
  es: {
    preparedFor: "Preparado para",
    capitalSummary: "Resumen de Cuenta de Capital",
    totalDeposited: "Total depositado (desde el inicio)",
    gainLoss: "Ganancia / Pérdida de inversión",
    currentValue: "Su valor actual",
    ownership: "Su Participación",
    ownershipPct: "Participación %",
    unitsHeld: "Unidades en cartera",
    navPerUnit: "NAV por unidad",
    yourReturn: "Su retorno desde el inicio",
    fundPerf: "Rendimiento Fund ONE",
    totalFundValue: "Valor total del fondo",
    twrLabel: "TWR desde el inicio (dic. 2025)",
    depositHistory: "Historial de depósitos",
    date: "FECHA",
    amount: "MONTO",
    total: "Total",
    subject: (period) => `Fund ONE — Estado de Cuenta ${period}`,
    disclaimer: "Este estado de cuenta es preparado por <strong>Red Road Securities / MONECHE &amp; SONS LLC</strong> únicamente con fines informativos. No es un documento fiscal. Los rendimientos pasados no garantizan resultados futuros. Cuenta IB U23388477.",
  },
};

function statementHtml({ investor, data, period, allInvestors }) {
  const lang = investor.lang || "en";
  const t = T[lang] || T.en;
  const { deposits = [] } = data;

  // Use authoritative values from nav-history (IB-derived)
  const totalValue = data.totalValue || 0;
  const navPerUnit = data.navPerUnit || 1;
  const twr        = data.twr        || 0;

  const key        = depositKey(investor);
  const myUnits    = computeInvestorUnits(deposits, key);
  const totalUnits = computeTotalUnits(deposits, allInvestors);

  const myDeposited = deposits.reduce((s, d) => s + (parseFloat(d[key]) || 0), 0);
  const myValue     = myUnits * navPerUnit;
  const myGL        = myValue - myDeposited;
  const myReturn    = myDeposited > 0 ? (myGL / myDeposited) * 100 : 0;
  const myPct       = totalUnits > 0  ? (myUnits / totalUnits) * 100 : 0;

  const fullName = [investor.firstName, investor.middleName, investor.lastName].filter(Boolean).join(" ");

  const depRows = deposits
    .map(d => ({ date: d.date, amount: parseFloat(d[key]) || 0 }))
    .filter(d => d.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => `
      <tr>
        <td style="padding:7px 10px;border-bottom:1px solid #f0ede8;font-size:12px;color:#4a4742;">${d.date}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f0ede8;font-size:12px;color:#4a4742;text-align:right;">${fmt(d.amount, 0)}</td>
      </tr>`).join("");

  const today = new Date().toLocaleDateString(lang === "es" ? "es-CO" : "en-US", { year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f0;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">

  <tr><td style="background:#1a1a1a;padding:28px 36px;">
    <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:6px;">Red Road Securities</div>
    <div style="font-size:22px;font-weight:600;color:#ffffff;">Fund ONE</div>
    <div style="font-size:13px;color:#aaa;margin-top:4px;">Investor Statement — ${period}</div>
  </td></tr>

  <tr><td style="padding:20px 36px 0;border-bottom:1px solid #f0ede8;">
    <div style="font-size:11px;color:#999;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">${t.preparedFor}</div>
    <div style="font-size:16px;font-weight:500;color:#1a1a1a;">${fullName}</div>
    <div style="font-size:12px;color:#888;margin-bottom:16px;">${today}</div>
  </td></tr>

  <tr><td style="padding:24px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">${t.capitalSummary}</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:9px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${t.totalDeposited}</td>
        <td style="padding:9px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${fmt(myDeposited, 0)}</td>
      </tr>
      <tr>
        <td style="padding:9px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${t.gainLoss}</td>
        <td style="padding:9px 0;font-size:13px;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;color:${myGL >= 0 ? "#2a7a4b" : "#c0392b"};">${fmt(myGL)}</td>
      </tr>
      <tr style="background:#f9f8f6;">
        <td style="padding:12px 10px;font-size:14px;color:#1a1a1a;font-weight:600;border-radius:6px 0 0 6px;">${t.currentValue}</td>
        <td style="padding:12px 10px;font-size:16px;color:#1a1a1a;font-weight:700;text-align:right;border-radius:0 6px 6px 0;">${fmt(myValue)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">${t.ownership}</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${t.ownershipPct}</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${myPct.toFixed(2)}%</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${t.unitsHeld}</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${myUnits.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${t.navPerUnit}</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${fmt(navPerUnit, 4)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;">${t.yourReturn}</td>
        <td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right;color:${myReturn >= 0 ? "#2a7a4b" : "#c0392b"};">${fmtPct(myReturn)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">${t.fundPerf}</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${t.totalFundValue}</td>
        <td style="padding:8px 0;font-size:13px;color:#1a1a1a;font-weight:500;text-align:right;border-bottom:1px solid #f5f3f0;">${fmt(totalValue, 0)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#4a4742;">${t.twrLabel}</td>
        <td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right;color:${twr >= 0 ? "#2a7a4b" : "#c0392b"};">${fmtPct(twr)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;">${t.depositHistory}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ede8;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f9f8f6;">
          <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;letter-spacing:0.5px;">${t.date}</th>
          <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;letter-spacing:0.5px;">${t.amount}</th>
        </tr>
      </thead>
      <tbody>${depRows}</tbody>
      <tr style="background:#f9f8f6;">
        <td style="padding:9px 10px;font-size:13px;font-weight:600;color:#1a1a1a;">${t.total}</td>
        <td style="padding:9px 10px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">${fmt(myDeposited, 0)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:28px 36px;">
    <div style="border-top:1px solid #f0ede8;padding-top:20px;">
      <div style="font-size:11px;color:#bbb;line-height:1.6;">${t.disclaimer}</div>
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

  if (!isManual && !isLastDayOfMonth()) {
    return res.status(200).json({ skipped: true, reason: "Not the last day of the month" });
  }

  const blobUrl = process.env.FUND_DATA_BLOB_URL;
  if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });

  const blobBase = blobUrl.replace("fund-data.json", "");

  // Load fund data (deposits, investors) and nav-history in parallel
  let data, navHistory;
  try {
    [data, navHistory] = await Promise.all([
      fetch(`${blobUrl}?t=${Date.now()}`, { cache: "no-store" }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`${blobBase}nav-history.json?t=${Date.now()}`, { cache: "no-store" }).then(r => r.ok ? r.json() : { series: [] }),
    ]);
  } catch (err) {
    return res.status(500).json({ error: `Failed to load data: ${err.message}` });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  // Latest NAV point from nav-history (authoritative IB values)
  const navSeries  = navHistory.series || [];
  const latestNav  = navSeries[navSeries.length - 1] || {};
  const totalValue = latestNav.totalValue || 0;
  const navPerUnit = latestNav.nav       || 1;
  const twr        = latestNav.twr != null ? latestNav.twr - 100 : 0; // twr stored as index (100 = flat)

  // Merge live values into data so statementHtml can read them
  data.totalValue = totalValue;
  data.navPerUnit = navPerUnit;
  data.twr        = twr;
  data.navSeries  = navSeries;

  const now = new Date();
  const periodDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = periodDate.toLocaleString("en-US", { month: "long", year: "numeric" });

  const allInvestors = data.investors && data.investors.length
    ? data.investors
    : [
        { firstName: "Fernando", middleName: "", lastName: "Montoya", email: "fernando.montoya@mdosas.com", lang: "es" },
        { firstName: "Dario",    middleName: "", lastName: "Montoya", email: "dario.montoya@mdosas.com",    lang: "es" },
      ];

  const results = [];

  for (const investor of allInvestors) {
    const t    = T[investor.lang] || T.en;
    const html = statementHtml({ investor, data, period, allInvestors });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Fund ONE <onboarding@resend.dev>",
        to: ["pablomontoyarobledo@gmail.com"], // TODO: switch to investor.email after Resend domain verified
        subject: `${t.subject(period)} [TEST — ${investor.firstName}]`,
        html,
      }),
    });

    const result = await emailRes.json();
    results.push({ investor: `${investor.firstName} ${investor.lastName}`, status: emailRes.status, result });
  }

  return res.status(200).json({ sent: results });
}
