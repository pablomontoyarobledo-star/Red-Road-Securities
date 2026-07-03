// Returns S&P 500 (^GSPC) daily closes indexed to 100 at Dec 18 2025,
// aligned to the dates array passed as ?dates=YYYY-MM-DD,YYYY-MM-DD,...
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const period1 = Math.floor(new Date("2025-12-15").getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&period1=${period1}&period2=${period2}`;

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
