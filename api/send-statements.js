// Monthly investor statement — Vercel Cron fires on days 28-31, checks for last day of month.
// Schedule: "0 13 28-31 * *" (1 pm UTC). Also callable manually via POST.

function isLastDayOfMonth() {
  const now      = new Date();
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
function fmtPct(n, showSign = true) {
  if (n == null) return "—";
  const sign = showSign && n >= 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}
function depositKey(inv) { return inv.firstName.toLowerCase(); }

function computeInvestorUnits(deposits, key) {
  return deposits.reduce((sum, d) => {
    const nav = parseFloat(d.nav) || 1;
    return sum + (parseFloat(d[key]) || 0) / nav;
  }, 0);
}
function computeTotalUnits(deposits, investors) {
  return investors.reduce((sum, inv) => sum + computeInvestorUnits(deposits, depositKey(inv)), 0);
}

// NAV series helpers
function lastNavOfMonth(series, year, month) {
  // month is 0-indexed
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const pts = series.filter(e => e.date.startsWith(prefix));
  return pts.length ? pts[pts.length - 1] : null;
}
function firstNavOfYear(series, year) {
  const pts = series.filter(e => e.date.startsWith(`${year}-`));
  return pts.length ? pts[0] : null;
}

// ── Translations ──────────────────────────────────────────────────────────────
const T = {
  en: {
    investorStatement: "Investor Statement",
    preparedFor:       "Prepared for",
    asOf:              "As of",
    // Capital
    capitalSummary:    "Capital Account",
    totalDeposited:    "Total deposited",
    gainLoss:          "Investment gain / loss",
    mgmtFee:           "Management fee",
    perfFee:           "Performance fee",
    currentValue:      "Current value",
    // Returns
    yourReturns:       "Your Returns",
    monthReturn:       "This month",
    ytdReturn:         "Year to date",
    inceptionReturn:   "Since inception (Dec 2025)",
    // Fund
    fundPerformance:   "Fund ONE Performance",
    totalAUM:          "Total assets (AUM)",
    inceptionDate:     "Inception date",
    twrMonth:          "Monthly TWR",
    twrYtd:            "YTD TWR",
    twrInception:      "TWR since inception",
    // Holdings
    holdings:          "Portfolio Holdings",
    ticker:            "Ticker",
    name:              "Name",
    value:             "Value",
    allocation:        "Allocation",
    // Activity
    activity:          "Activity This Month",
    noActivity:        "No trades this month.",
    date:              "Date",
    type:              "Type",
    shares:            "Shares",
    price:             "Price",
    amount:            "Amount",
    buy:               "Buy",
    sell:              "Sell",
    // Ownership
    ownership:         "Your Ownership",
    ownershipPct:      "Ownership %",
    unitsHeld:         "Units held",
    navPerUnit:        "NAV per unit",
    // Deposits
    depositSummary:    "Deposit Summary",
    totalInvested:     "Total invested",
    numDeposits:       "Number of deposits",
    // Fees
    fees:              "Fees",
    feeNote:           "No fees charged for this period.",
    // Footer
    disclaimer:        "Prepared by Red Road Securities / MONECHE &amp; SONS LLC for informational purposes only. Not a tax document. Past performance does not guarantee future results. IB account U23388477.",
    subject:           (p) => `Fund ONE — ${p} Investor Statement`,
    months:            ["January","February","March","April","May","June","July","August","September","October","November","December"],
  },
  es: {
    investorStatement: "Estado de Cuenta",
    preparedFor:       "Preparado para",
    asOf:              "Al",
    capitalSummary:    "Cuenta de Capital",
    totalDeposited:    "Total depositado",
    gainLoss:          "Ganancia / Pérdida",
    mgmtFee:           "Comisión de administración",
    perfFee:           "Comisión de rendimiento",
    currentValue:      "Valor actual",
    yourReturns:       "Sus Retornos",
    monthReturn:       "Este mes",
    ytdReturn:         "En el año",
    inceptionReturn:   "Desde el inicio (dic. 2025)",
    fundPerformance:   "Rendimiento Fund ONE",
    totalAUM:          "Activos totales (AUM)",
    inceptionDate:     "Fecha de inicio",
    twrMonth:          "TWR mensual",
    twrYtd:            "TWR en el año",
    twrInception:      "TWR desde el inicio",
    holdings:          "Composición del Portafolio",
    ticker:            "Ticker",
    name:              "Nombre",
    value:             "Valor",
    allocation:        "Participación",
    activity:          "Actividad del Mes",
    noActivity:        "Sin operaciones este mes.",
    date:              "Fecha",
    type:              "Tipo",
    shares:            "Acciones",
    price:             "Precio",
    amount:            "Monto",
    buy:               "Compra",
    sell:              "Venta",
    ownership:         "Su Participación",
    ownershipPct:      "% de participación",
    unitsHeld:         "Unidades en cartera",
    navPerUnit:        "NAV por unidad",
    depositSummary:    "Resumen de Depósitos",
    totalInvested:     "Total invertido",
    numDeposits:       "Número de depósitos",
    fees:              "Comisiones",
    feeNote:           "Sin comisiones cobradas en este período.",
    disclaimer:        "Preparado por Red Road Securities / MONECHE &amp; SONS LLC únicamente con fines informativos. No es un documento fiscal. Los rendimientos pasados no garantizan resultados futuros. Cuenta IB U23388477.",
    subject:           (p) => `Fund ONE — Estado de Cuenta ${p}`,
    months:            ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"],
  },
};

// ── HTML builder ──────────────────────────────────────────────────────────────
function row(label, value, bold = false, color = null) {
  const v = color
    ? `<td style="padding:9px 0;font-size:13px;font-weight:${bold ? 600 : 500};text-align:right;border-bottom:1px solid #f0ede8;color:${color};">${value}</td>`
    : `<td style="padding:9px 0;font-size:13px;font-weight:${bold ? 600 : 500};text-align:right;border-bottom:1px solid #f0ede8;color:#1a1a1a;">${value}</td>`;
  return `<tr>
    <td style="padding:9px 0;font-size:13px;color:#4a4742;border-bottom:1px solid #f0ede8;">${label}</td>
    ${v}
  </tr>`;
}
function sectionHeader(title) {
  return `<tr><td colspan="2" style="padding:24px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;border-top:1px solid #f0ede8;padding-top:20px;">${title}</div>
    <table width="100%" cellpadding="0" cellspacing="0">`;
}
function sectionClose() { return `</table></td></tr>`; }

function statementHtml({ investor, fundData, navSeries, trades, period, periodYear, periodMonth, allInvestors, t }) {
  const lang       = investor.lang || "en";
  const { deposits = [], positions = [] } = fundData;
  const key        = depositKey(investor);

  // ── Compute values ──
  const latestNav  = navSeries[navSeries.length - 1] || {};
  const totalValue = latestNav.totalValue || 0;
  const navPerUnit = latestNav.nav        || 1;
  const twrInc     = latestNav.twr != null ? latestNav.twr - 100 : 0;

  // Monthly return: last nav of period month vs last nav of prior month
  const curPt  = lastNavOfMonth(navSeries, periodYear, periodMonth);
  const prevPt = lastNavOfMonth(navSeries, periodMonth === 0 ? periodYear - 1 : periodYear, periodMonth === 0 ? 11 : periodMonth - 1);
  const monthReturn = curPt && prevPt ? ((curPt.nav / prevPt.nav) - 1) * 100 : null;

  // YTD return: first nav of current year vs latest
  const ytdStart  = lastNavOfMonth(navSeries, periodYear - 1, 11) || firstNavOfYear(navSeries, periodYear);
  const ytdReturn = ytdStart && curPt ? ((curPt.nav / ytdStart.nav) - 1) * 100 : null;

  // Investor-specific
  const myUnits    = computeInvestorUnits(deposits, key);
  const totalUnits = computeTotalUnits(deposits, allInvestors);
  const myDeposited = deposits.reduce((s, d) => s + (parseFloat(d[key]) || 0), 0);
  const myValue    = myUnits * navPerUnit;
  const myGL       = myValue - myDeposited;
  const myPct      = totalUnits > 0 ? (myUnits / totalUnits) * 100 : 0;
  const myReturn   = myDeposited > 0 ? (myGL / myDeposited) * 100 : 0;

  // Monthly investor return (same as fund since NAV-based)
  const myMonthReturn = monthReturn;
  const myYtdReturn   = ytdReturn;

  // Holdings
  const totalPos = positions.reduce((s, p) => s + (parseFloat(p.shares) * parseFloat(p.ibClose || p.costBasis || 0)), 0);
  const cash     = Math.max(0, totalValue - totalPos);
  const holdingsRows = [
    ...positions.map(p => {
      const val  = parseFloat(p.shares) * parseFloat(p.ibClose || p.costBasis || 0);
      const alloc = totalValue > 0 ? (val / totalValue) * 100 : 0;
      return `<tr>
        <td style="padding:8px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #f5f3f0;font-weight:600;">${p.ticker}</td>
        <td style="padding:8px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${p.name || ""}</td>
        <td style="padding:8px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #f5f3f0;text-align:right;">${fmt(val, 0)}</td>
        <td style="padding:8px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;text-align:right;">${alloc.toFixed(1)}%</td>
      </tr>`;
    }),
    cash > 0 ? `<tr>
      <td style="padding:8px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #f5f3f0;font-weight:600;">CASH</td>
      <td style="padding:8px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;">Cash &amp; equivalents</td>
      <td style="padding:8px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #f5f3f0;text-align:right;">${fmt(cash, 0)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;text-align:right;">${totalValue > 0 ? ((cash / totalValue) * 100).toFixed(1) : "0.0"}%</td>
    </tr>` : "",
  ].join("");

  // Trades this month
  const monthPrefix  = `${periodYear}-${String(periodMonth + 1).padStart(2, "0")}`;
  const monthTrades  = trades.filter(tr => tr.date?.startsWith(monthPrefix));
  const tradeRows    = monthTrades.length
    ? monthTrades.map(tr => `<tr>
        <td style="padding:7px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;">${tr.date}</td>
        <td style="padding:7px 10px;font-size:12px;color:#1a1a1a;font-weight:600;border-bottom:1px solid #f5f3f0;">${tr.ticker}</td>
        <td style="padding:7px 10px;font-size:12px;border-bottom:1px solid #f5f3f0;color:${tr.type === "buy" ? "#2a7a4b" : "#c0392b"};">${tr.type === "buy" ? t.buy : t.sell}</td>
        <td style="padding:7px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;text-align:right;">${tr.shares?.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
        <td style="padding:7px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;text-align:right;">${fmt(tr.price, 2)}</td>
        <td style="padding:7px 10px;font-size:12px;color:#4a4742;border-bottom:1px solid #f5f3f0;text-align:right;">${fmt(Math.abs(tr.netAmount || tr.proceeds || 0), 0)}</td>
      </tr>`)
      .join("")
    : `<tr><td colspan="6" style="padding:12px 10px;font-size:12px;color:#999;">${t.noActivity}</td></tr>`;

  const numDeposits = deposits.filter(d => (parseFloat(d[key]) || 0) > 0).length;
  const fullName    = [investor.firstName, investor.middleName, investor.lastName].filter(Boolean).join(" ");
  const today       = new Date().toLocaleDateString(lang === "es" ? "es-CO" : "en-US", { year:"numeric", month:"long", day:"numeric" });
  const retColor    = (n) => n == null ? "#4a4742" : n >= 0 ? "#2a7a4b" : "#c0392b";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f0;padding:32px 0;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#1a1a1a;padding:28px 36px;">
    <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:6px;">Red Road Securities</div>
    <div style="font-size:24px;font-weight:700;color:#ffffff;">Fund ONE</div>
    <div style="font-size:13px;color:#aaa;margin-top:4px;">${t.investorStatement} — ${period}</div>
  </td></tr>

  <!-- Prepared for -->
  <tr><td style="padding:20px 36px 0;">
    <div style="font-size:11px;color:#999;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">${t.preparedFor}</div>
    <div style="font-size:17px;font-weight:600;color:#1a1a1a;">${fullName}</div>
    <div style="font-size:12px;color:#888;margin-top:2px;">${t.asOf} ${today}</div>
  </td></tr>

  <!-- Capital Account -->
  ${sectionHeader(t.capitalSummary)}
    ${row(t.totalDeposited, fmt(myDeposited, 0))}
    ${row(t.gainLoss,       fmt(myGL),       false, retColor(myGL))}
    ${row(t.mgmtFee,        "$0.00")}
    ${row(t.perfFee,        "$0.00")}
    <tr style="background:#f9f8f6;">
      <td style="padding:13px 10px;font-size:15px;font-weight:700;color:#1a1a1a;border-radius:6px 0 0 6px;">${t.currentValue}</td>
      <td style="padding:13px 10px;font-size:17px;font-weight:700;text-align:right;color:#1a1a1a;border-radius:0 6px 6px 0;">${fmt(myValue)}</td>
    </tr>
  ${sectionClose()}

  <!-- Your Returns -->
  ${sectionHeader(t.yourReturns)}
    ${row(t.monthReturn,    monthReturn  != null ? fmtPct(monthReturn)  : "—", false, retColor(monthReturn))}
    ${row(t.ytdReturn,      ytdReturn    != null ? fmtPct(ytdReturn)    : "—", false, retColor(ytdReturn))}
    ${row(t.inceptionReturn, fmtPct(myReturn), false, retColor(myReturn))}
  ${sectionClose()}

  <!-- Fund Performance -->
  ${sectionHeader(t.fundPerformance)}
    ${row(t.totalAUM,       fmt(totalValue, 0))}
    ${row(t.twrMonth,       monthReturn  != null ? fmtPct(monthReturn)  : "—", false, retColor(monthReturn))}
    ${row(t.twrYtd,         ytdReturn    != null ? fmtPct(ytdReturn)    : "—", false, retColor(ytdReturn))}
    ${row(t.twrInception,   fmtPct(twrInc), false, retColor(twrInc))}
    ${row(t.inceptionDate,  "December 18, 2025")}
  ${sectionClose()}

  <!-- Your Ownership -->
  ${sectionHeader(t.ownership)}
    ${row(t.ownershipPct, myPct.toFixed(2) + "%")}
    ${row(t.unitsHeld,    myUnits.toLocaleString("en-US", { maximumFractionDigits: 0 }))}
    ${row(t.navPerUnit,   fmt(navPerUnit, 6))}
  ${sectionClose()}

  <!-- Portfolio Holdings -->
  <tr><td style="padding:24px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;border-top:1px solid #f0ede8;padding-top:20px;">${t.holdings}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ede8;border-radius:8px;overflow:hidden;">
      <thead><tr style="background:#f9f8f6;">
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;">${t.ticker}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;">${t.name}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;">${t.value}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;">${t.allocation}</th>
      </tr></thead>
      <tbody>${holdingsRows}</tbody>
    </table>
  </td></tr>

  <!-- Activity This Month -->
  <tr><td style="padding:24px 36px 0;">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#999;margin-bottom:14px;border-top:1px solid #f0ede8;padding-top:20px;">${t.activity}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ede8;border-radius:8px;overflow:hidden;">
      <thead><tr style="background:#f9f8f6;">
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;">${t.date}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;">${t.ticker}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:left;font-weight:500;">${t.type}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;">${t.shares}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;">${t.price}</th>
        <th style="padding:8px 10px;font-size:11px;color:#999;text-align:right;font-weight:500;">${t.amount}</th>
      </tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>
  </td></tr>

  <!-- Deposit Summary -->
  ${sectionHeader(t.depositSummary)}
    ${row(t.totalInvested, fmt(myDeposited, 0))}
    ${row(t.numDeposits,   String(numDeposits))}
  ${sectionClose()}

  <!-- Fees -->
  ${sectionHeader(t.fees)}
    ${row(t.mgmtFee, "$0.00")}
    ${row(t.perfFee, "$0.00")}
    <tr><td colspan="2" style="padding:8px 0;font-size:11px;color:#bbb;">${t.feeNote}</td></tr>
  ${sectionClose()}

  <!-- Footer -->
  <tr><td style="padding:28px 36px;">
    <div style="border-top:1px solid #f0ede8;padding-top:20px;">
      <div style="font-size:11px;color:#bbb;line-height:1.7;">${t.disclaimer}</div>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const isManual = req.method === "POST";

  if (!isManual && !isLastDayOfMonth()) {
    return res.status(200).json({ skipped: true, reason: "Not the last day of the month" });
  }

  const blobUrl = process.env.FUND_DATA_BLOB_URL;
  if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });
  const blobBase = blobUrl.replace("fund-data.json", "");

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  // Load everything in parallel
  let fundData, navHistory, invStore, tradesStore;
  try {
    [fundData, navHistory, invStore, tradesStore] = await Promise.all([
      fetch(`${blobUrl}?t=${Date.now()}`,                    { cache: "no-store" }).then(r => r.ok ? r.json() : {}),
      fetch(`${blobBase}nav-history.json?t=${Date.now()}`,   { cache: "no-store" }).then(r => r.ok ? r.json() : { series: [] }),
      fetch(`${blobBase}investors.json?t=${Date.now()}`,     { cache: "no-store" }).then(r => r.ok ? r.json() : { investors: [] }),
      fetch(`${blobBase}trades-history.json?t=${Date.now()}`,{ cache: "no-store" }).then(r => r.ok ? r.json() : { trades: [] }),
    ]);
  } catch (err) {
    return res.status(500).json({ error: `Failed to load data: ${err.message}` });
  }

  const navSeries = navHistory.series || [];
  const trades    = tradesStore.trades || [];

  // Period = current month (statement sent on last day of month)
  const now         = new Date();
  const periodYear  = now.getFullYear();
  const periodMonth = now.getMonth(); // 0-indexed
  const tLang       = T.en; // use for period string (English month name for subject fallback)
  const period      = `${tLang.months[periodMonth]} ${periodYear}`;

  const allInvestors = invStore?.investors?.length ? invStore.investors
    : fundData?.investors?.length ? fundData.investors
    : [
        { firstName: "Fernando", lastName: "Montoya", email: "fernando.montoya@mdosas.com", lang: "es" },
        { firstName: "Dario",    lastName: "Montoya", email: "dario.montoya@mdosas.com",    lang: "es" },
      ];

  const results = [];

  for (const investor of allInvestors) {
    const t    = T[investor.lang] || T.en;
    const periodLocal = `${t.months[periodMonth]} ${periodYear}`;

    const html = statementHtml({
      investor, fundData, navSeries, trades,
      period: periodLocal, periodYear, periodMonth,
      allInvestors, t,
    });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from:    "Fund ONE <onboarding@resend.dev>",
        to:      ["pablomontoyarobledo@gmail.com"], // TODO: switch to investor.email after Resend domain verified
        subject: `${t.subject(periodLocal)} [TEST — ${investor.firstName}]`,
        html,
      }),
    });

    const result = await emailRes.json();
    results.push({ investor: `${investor.firstName} ${investor.lastName}`, lang: investor.lang, status: emailRes.status, result });
  }

  return res.status(200).json({ sent: results });
}
