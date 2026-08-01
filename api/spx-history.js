// Returns S&P 500 total-return (^SP500TR, dividends reinvested) daily closes
// indexed to 100 at Dec 18 2025, aligned to the dates array passed as
// ?dates=YYYY-MM-DD,YYYY-MM-DD,... — total return, not ^GSPC price-only, so
// it's an apples-to-apples comparison against Fund ONE's own dividend-
// inclusive TWR (see the inline note below).
// Also supports ?mode=monthly to return monthly % returns for ^SP500TR, EFA, VT

const INCEPTION = "2025-12-18";

async function fetchMonthlyReturns(ticker) {
  const period1 = Math.floor(new Date("2025-11-01").getTime() / 1000); // one month before inception for base
  const period2 = Math.floor(Date.now() / 1000);
  const encoded = encodeURIComponent(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1mo&period1=${period1}&period2=${period2}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const json = await r.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);

  const closes = result.indicators.quote[0].close;
  const months = result.timestamp.map((ts, i) => {
    const date = new Date(ts * 1000);
    // Yahoo monthly timestamps are start-of-month; label as YYYY-MM
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { key, close: closes[i] };
  }).filter(m => m.close != null && m.key >= "2025-11");

  // Compute monthly returns: each month vs prior month close
  const returns = {};
  for (let i = 1; i < months.length; i++) {
    const ret = (months[i].close / months[i - 1].close - 1) * 100;
    returns[months[i].key] = parseFloat(ret.toFixed(3));
  }
  return returns;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.query.mode === "monthly") {
    try {
      const [spxtr, efa, vt] = await Promise.all([
        fetchMonthlyReturns("^SP500TR"),
        fetchMonthlyReturns("EFA"),
        fetchMonthlyReturns("VT"),
      ]);
      // Collect all month keys present in any series, from inception onward
      const keys = [...new Set([...Object.keys(spxtr), ...Object.keys(efa), ...Object.keys(vt)])]
        .filter(k => k >= "2025-12")
        .sort();
      const months = keys.map(k => ({ key: k, spxtr: spxtr[k] ?? null, efa: efa[k] ?? null, vt: vt[k] ?? null }));
      return res.status(200).json({ months });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // ^SP500TR (total return, dividends reinvested) — not ^GSPC (price only).
  // Fund ONE's own TWR already includes dividends (they flow into IB's
  // totalValue), so comparing it against a price-only index would overstate
  // relative performance by roughly the index's dividend yield. The
  // ?mode=monthly branch above already uses ^SP500TR for the same reason;
  // this keeps the daily chart and the monthly table on the same benchmark
  // definition instead of silently disagreeing.
  const period1 = Math.floor(new Date("2025-12-15").getTime() / 1000); // daily chart
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ESP500TR?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await r.json();
    const result = json.chart?.result?.[0];
    if (!result) return res.status(502).json({ error: "No data from Yahoo" });

    // Build date → price map
    const priceMap = {};
    result.timestamp.forEach((ts, i) => {
      const c = result.indicators.quote[0].close[i];
      if (c) priceMap[new Date(ts * 1000).toISOString().slice(0, 10)] = c;
    });

    // Find base price at inception
    let base = priceMap["2025-12-18"];
    if (!base) {
      const k = Object.keys(priceMap).sort().find(d => d >= "2025-12-18");
      base = priceMap[k];
    }
    if (!base) return res.status(502).json({ error: "No inception price found" });

    // If specific dates requested, align and forward-fill; otherwise return full map
    const datesParam = req.query.dates;
    if (datesParam) {
      const dates = datesParam.split(",");
      let last = base;
      const series = dates.map(d => {
        if (priceMap[d]) last = priceMap[d];
        return Math.round((last / base) * 10000) / 100;
      });
      return res.status(200).json({ series, base, points: series.length });
    }

    return res.status(200).json({ priceMap, base });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
