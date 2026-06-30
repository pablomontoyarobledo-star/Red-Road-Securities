import { XMLParser } from "fast-xml-parser";

const BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req, res) {
  const token   = process.env.IB_FLEX_TOKEN;
  const queryId = process.env.IB_FLEX_QUERY_ID;

  if (!token || !queryId) {
    return res.status(500).json({ error: "IB_FLEX_TOKEN or IB_FLEX_QUERY_ID not set" });
  }

  // Step 1: Request the report generation
  let sendXml;
  try {
    const r = await fetch(`${BASE}.SendRequest?v=3&t=${token}&q=${queryId}`);
    sendXml = await r.text();
  } catch (err) {
    return res.status(502).json({ error: `IB SendRequest failed: ${err.message}` });
  }

  const sendData = parser.parse(sendXml);
  const sendResp = sendData?.FlexStatementResponse;

  if (!sendResp || sendResp.Status !== "Success") {
    return res.status(502).json({
      error: `IB rejected request: ${sendResp?.ErrorCode} — ${sendResp?.ErrorMessage}`,
    });
  }

  const refCode = sendResp.ReferenceCode;
  const stmtUrl = sendResp.Url;

  // Step 2: Poll until the report is ready (IB needs a few seconds)
  let stmtXml;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt === 0 ? 2000 : 3000);
    try {
      const r = await fetch(`${stmtUrl}?v=3&t=${token}&q=${refCode}`);
      stmtXml = await r.text();
      // IB returns a "pending" XML while building the report
      if (!stmtXml.includes("<Status>Processing</Status>")) break;
    } catch (err) {
      return res.status(502).json({ error: `IB GetStatement failed: ${err.message}` });
    }
  }

  if (!stmtXml || stmtXml.includes("<Status>Processing</Status>")) {
    return res.status(504).json({ error: "IB report timed out — try again in a moment" });
  }

  // Step 3: Parse the XML
  const stmtData = parser.parse(stmtXml);
  const stmt = stmtData?.FlexQueryResponse?.FlexStatements?.FlexStatement;

  if (!stmt) {
    return res.status(502).json({ error: "Could not parse IB statement XML", raw: stmtXml?.slice(0, 500) });
  }

  // Open positions
  let rawPositions = stmt?.OpenPositions?.OpenPosition ?? [];
  if (!Array.isArray(rawPositions)) rawPositions = [rawPositions];

  const positions = rawPositions
    .filter(p => p && p.assetCategory === "STK")
    .map(p => ({
      ticker:    p.symbol,
      name:      p.description,
      shares:    parseFloat(p.position)       || 0,
      costBasis: parseFloat(p.costBasisPrice) || 0,
      ibClose:   parseFloat(p.markPrice)      || 0,
    }));

  // Cash balance — find the base-currency (USD) total row
  let cashRows = stmt?.CashReport?.CashReportCurrency ?? [];
  if (!Array.isArray(cashRows)) cashRows = [cashRows];
  // IB includes summary rows; pick the one with accountId set and currency=BASE
  const cashRow = cashRows.find(c => c && c.currency === "BASE" && c.accountId) ||
                  cashRows.find(c => c && c.currency === "USD"  && c.accountId);
  const cashBalance = parseFloat(cashRow?.endingCash || cashRow?.endingSettledCash || 0);

  // Recent trades (last 30 days, stocks only)
  let rawTrades = stmt?.Trades?.Trade ?? [];
  if (!Array.isArray(rawTrades)) rawTrades = [rawTrades];
  const trades = rawTrades
    .filter(t => t && t.assetCategory === "STK")
    .map(t => ({
      date:     t.tradeDate,
      ticker:   t.symbol,
      type:     parseFloat(t.quantity) > 0 ? "buy" : "sell",
      shares:   Math.abs(parseFloat(t.quantity) || 0),
      price:    parseFloat(t.tradePrice) || 0,
      proceeds: parseFloat(t.proceeds)   || 0,
    }));

  return res.status(200).json({
    positions,
    cashBalance,
    trades,
    lastUpdated: new Date().toISOString(),
    accountId: stmt.accountId || "U23388477",
  });
}
