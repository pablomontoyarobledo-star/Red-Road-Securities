// Investor-facing "set up your account" email — sent either automatically
// (their first deposit was just allocated, see api/allocate-deposit.js) or
// on-demand by an admin inviting/resending for any investor already in
// investors.json (see api/investor-claim.js).

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

const T = {
  en: {
    subjectDeposit: "Your first deposit has been registered",
    subjectInvite:  "Set up your Fund ONE account",
    headlineDeposit: "Your first deposit has been registered",
    headlineInvite:  "Set up your account",
    intro:      "Welcome to Fund ONE. Use the link below to set your password and access your investor portal.",
    depositLabel: "Deposit",
    dateLabel:    "Date",
    cta:        "Set up my account",
    expiry:     "This link expires in 7 days.",
    footer:     "Red Road Securities / MONECHE &amp; SONS LLC",
  },
  es: {
    subjectDeposit: "Se ha registrado su primer depósito",
    subjectInvite:  "Configure su cuenta de Fund ONE",
    headlineDeposit: "Se ha registrado su primer depósito",
    headlineInvite:  "Configure su cuenta",
    intro:      "Bienvenido a Fund ONE. Use el enlace a continuación para establecer su contraseña y acceder a su portal de inversionista.",
    depositLabel: "Depósito",
    dateLabel:    "Fecha",
    cta:        "Configurar mi cuenta",
    expiry:     "Este enlace expira en 7 días.",
    footer:     "Red Road Securities / MONECHE &amp; SONS LLC",
  },
};

const CLAIM_BASE_URL = "https://red-road-securities.vercel.app";

export async function sendClaimAccountEmail({ to, firstName, lang, amount, date, token, resendKey = process.env.RESEND_API_KEY }) {
  if (!resendKey) throw new Error("RESEND_API_KEY not set");
  if (!to) throw new Error("sendClaimAccountEmail: 'to' is required");

  const t = T[lang] || T.en;
  const hasDeposit = amount != null && date;
  const headline = hasDeposit ? t.headlineDeposit : t.headlineInvite;
  const subject  = hasDeposit ? t.subjectDeposit  : t.subjectInvite;
  const claimUrl = `${CLAIM_BASE_URL}/?claim=${encodeURIComponent(token)}`;

  const depositRows = hasDeposit ? `
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
      <tr><td style="padding:8px 0;color:#888;">${t.dateLabel}</td><td style="padding:8px 0;font-weight:600;">${escapeHtml(date)}</td></tr>
      <tr><td style="padding:8px 0;color:#888;">${t.depositLabel}</td><td style="padding:8px 0;font-weight:600;color:#1a6b3c;">$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td></tr>
    </table>` : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:6px;">Red Road Securities</div>
      <h2 style="color:#1a1a1a;margin:0 0 4px;">Fund ONE</h2>
      <h3 style="color:#1a6b3c;margin:16px 0 8px;">${escapeHtml(headline)}</h3>
      <p style="color:#4a4742;font-size:14px;line-height:1.6;">${firstName ? `${escapeHtml(firstName)}, ` : ""}${t.intro}</p>
      ${depositRows}
      <a href="${claimUrl}" style="display:inline-block;padding:12px 24px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;margin:12px 0;background:#1a6b3c;color:#fff;">${escapeHtml(t.cta)}</a>
      <p style="font-size:12px;color:#aaa;margin-top:20px;">${escapeHtml(t.expiry)}</p>
      <p style="font-size:11px;color:#bbb;margin-top:24px;border-top:1px solid #f0ede8;padding-top:16px;">${t.footer}</p>
    </div>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    "Fund ONE <onboarding@resend.dev>",
      to:      [to],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Resend request failed (${r.status}): ${detail}`);
  }
}
