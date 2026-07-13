import { put } from "@vercel/blob";

const BLOB_BASE  = "https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/";
const CACHE_FILE = "price-cache.json";
const CACHE_TTL  = 3 * 60 * 1000; // 3 minutes

const YF_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin":          "https://finance.yahoo.com",
  "Referer":         "https://finance.yahoo.com/",
};

async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
  const r   = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!price || price <= 0) throw new Error("no price in response");
  return price;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  // TEMP: send the real allocation email for any pending deposit right now.
  if (req.query.diag === "notify") {
    const key = process.env.RESEND_API_KEY;
    if (!key) return res.status(200).json({ ok: false, reason: "RESEND_API_KEY not set" });
    const SFX = process.env.BLOB_SUFFIX || "";
    const suf = n => SFX ? n.replace(/\.json$/, `-${SFX}.json`) : n;
    let pending = { deposits: [] }, investors = [];
    try { pending = await (await fetch(`${BLOB_BASE}${suf("pending-deposits.json")}?t=${Date.now()}`, { cache: "no-store" })).json(); } catch {}
    try { const inv = await (await fetch(`${BLOB_BASE}${suf("investors.json")}?t=${Date.now()}`, { cache: "no-store" })).json();
      investors = (inv.investors || []).map(i => ({ key: i.id.startsWith("inv_") ? i.id.slice(4) : i.id, label: `${i.firstName} ${i.lastName}`.trim() })); } catch {}
    if (!investors.length) investors = [{ key: "fernando", label: "Fernando" }, { key: "dario", label: "Dario" }];
    const sent = [];
    for (const dep of (pending.deposits || [])) {
      const base = "https://red-road-securities.vercel.app";
      const bs = "display:inline-block;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;margin:4px;";
      const btns = investors.map(i => `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=${i.key}" style="${bs}background:#1a6b3c;color:#fff;">Allocate to ${i.label}</a>`).join("") +
        `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=new" style="${bs}background:#1a3a6b;color:#fff;">New investor</a>`;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Fund ONE <onboarding@resend.dev>", to: ["pablomontoyarobledo@gmail.com"],
          subject: `New deposit detected — $${dep.amount.toLocaleString("en-US")} on ${dep.date}`,
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;"><h2 style="color:#1a6b3c;">New Deposit Detected</h2><p><b>$${dep.amount.toLocaleString("en-US",{minimumFractionDigits:2})}</b> on ${dep.date}<br>${dep.description||""}</p><p>Allocate to an investor:</p>${btns}</div>` }),
      });
      sent.push({ id: dep.id, amount: dep.amount, ok: r.ok, status: r.status });
    }
    return res.status(200).json({ ok: true, sent });
  }

  const tickersParam = req.query.tickers || "VTI,BND";
  const tickers = tickersParam.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);

  // Try blob cache first
  try {
    const cr = await fetch(`${BLOB_BASE}${CACHE_FILE}?t=${Date.now()}`, { cache: "no-store" });
    if (cr.ok) {
      const cached = await cr.json();
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL && tickers.every(t => cached.prices[t] != null)) {
        return res.status(200).json({ prices: cached.prices, fromCache: true, ageSeconds: Math.round(age / 1000) });
      }
    }
  } catch {}

  // Fetch live prices — try both Yahoo query1 and query2 for each ticker
  const prices = {};
  await Promise.all(tickers.map(async ticker => {
    // Try query1 first, then query2
    for (const host of ["query1", "query2"]) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        const r   = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const data  = await r.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && price > 0) { prices[ticker] = price; return; }
      } catch {}
    }
    // Also try the v7 quote endpoint as last resort
    try {
      const url   = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&fields=regularMarketPrice`;
      const r     = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data  = await r.json();
        const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice;
        if (price && price > 0) { prices[ticker] = price; return; }
      }
    } catch {}
  }));

  // Cache result in blob
  try {
    await put(CACHE_FILE, JSON.stringify({ prices, fetchedAt: new Date().toISOString() }), {
      access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
    });
  } catch {}

  const missing = tickers.filter(t => !prices[t]);
  return res.status(200).json({
    prices,
    fromCache: false,
    fetchedAt: new Date().toISOString(),
    ...(missing.length ? { partial: true, missing } : {}),
  });
}
