// Pulls the NAV Daily flex query from IB (last 205 days), computes daily NAV/TWR,
// and merges results into nav-history.json in Vercel Blob.
// Called by the daily cron AND manually via GET /api/ib-nav-history?refresh=1

import { XMLParser } from "fast-xml-parser";
import { put }       from "@vercel/blob";

const BASE           = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const INCEPTION_DATE = "2025-12-18";
const INCEPTION_NAV  = 1.0;
const parser         = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchNavXml(token, queryId) {
  const sendRes  = await fetch(`${BASE}.SendRequest?v=3&t=${token}&q=${queryId}`);
  const sendData = parser.parse(await sendRes.text());
  const sendResp = sendData?.FlexStatementResponse;
  if (!sendResp || sendResp.Status !== "Success") {
    throw new Error(`IB NAV request failed: ${sendResp?.ErrorCode} — ${sendResp?.ErrorMessage}`);
  }
  const refCode = sendResp.ReferenceCode;
  const stmtUrl = sendResp.Url;

  let xml;
  for (let i = 0; i < 10; i++) {
    await sleep(i === 0 ? 3000 : 3000);
    const r = await fetch(`${stmtUrl}?v=3&t=${token}&q=${refCode}`);
    xml = await r.text();
    if (!xml.includes("<Status>Processing</Status>")) break;
  }
  if (!xml || xml.includes("<Status>Processing</Status>")) throw new Error("IB NAV query timed out");
  return xml;
}

function parseNavXml(xml) {
  const data  = parser.parse(xml);
  const stmt  = data?.FlexQueryResponse?.FlexStatements?.FlexStatement;
  if (!stmt) throw new Error("Could not parse IB NAV XML");

  // NAVInBase → NAVByReportDate rows
  let rows = stmt?.NAVInBase?.NAVByReportDate ?? [];
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];

  return rows
    .map(r => ({
      date:       String(r.reportDate || "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
      totalValue: parseFloat(r.total ?? r.totalLong ?? 0),
    }))
    .filter(r => r.date.length === 10 && r.totalValue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function groupDeposits(deposits) {
  const groups = {};
  for (const d of deposits) {
    if (!groups[d.date]) groups[d.date] = { cash: 0, units: 0 };
    const cash = (d.fernando || 0) + (d.dario || 0);
    const nav  = d.nav > 0 ? d.nav : INCEPTION_NAV;
    groups[d.date].cash  += cash;
    groups[d.date].units += cash / nav;
  }
  return groups;
}

function matchSettlements(ibDaily, depositGroups, tolerance = 0.10) {
  const jumps = [];
  for (let i = 1; i < ibDaily.length; i++) {
    const change = ibDaily[i].totalValue - ibDaily[i - 1].totalValue;
    if (change > 500) jumps.push({ date: ibDaily[i].date, amount: change, matched: false });
  }
  const settlement = {};
  for (const [depDate, info] of Object.entries(depositGroups).sort()) {
    const jump = jumps.find(j =>
      !j.matched && j.date >= depDate &&
      Math.abs(j.amount - info.cash) / info.cash < tolerance
    );
    const effectiveDate = jump ? jump.date : depDate;
    if (jump) jump.matched = true;
    settlement[effectiveDate] = (settlement[effectiveDate] || 0) + info.units;
  }
  return settlement;
}

// Cron + admin endpoint. Admin calls carry x-sync-secret; Vercel cron carries
// Bearer CRON_SECRET automatically once that env var is set. Until CRON_SECRET
// exists we cannot distinguish cron traffic, so unauthenticated GETs are allowed
// as a temporary fallback — set CRON_SECRET to close this.
function isAuthorized(req) {
  const syncSecret = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (syncSecret && req.headers["x-sync-secret"] === syncSecret) return true;
  if (cronSecret) return req.headers["authorization"] === `Bearer ${cronSecret}`;
  return true; // fallback until CRON_SECRET is configured
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const token     = process.env.IB_FLEX_TOKEN;
  const navQueryId = process.env.IB_NAV_QUERY_ID;
  if (!token || !navQueryId) {
    return res.status(500).json({ error: "IB_FLEX_TOKEN or IB_NAV_QUERY_ID not set" });
  }

  const blobUrl  = process.env.FUND_DATA_BLOB_URL;
  if (!blobUrl) return res.status(500).json({ error: "FUND_DATA_BLOB_URL not set" });
  const blobBase = blobUrl.replace("fund-data.json", "");

  // Fetch NAV XML from IB
  let ibDaily, rawXml;
  try {
    rawXml  = await fetchNavXml(token, navQueryId);
    ibDaily = parseNavXml(rawXml);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (!ibDaily.length) {
    return res.status(502).json({ error: "No NAV rows returned from IB", xmlSnippet: rawXml?.slice(0, 3000) });
  }

  // Load deposits for unit calculation
  let deposits = [];
  try {
    const r = await fetch(`${blobUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) { const fd = await r.json(); deposits = fd.deposits || []; }
  } catch {}

  // Load existing nav-history to merge with (preserve live IB-data points)
  let existing = { inception: { date: INCEPTION_DATE, nav: INCEPTION_NAV }, series: [] };
  try {
    const r = await fetch(`${blobBase}nav-history.json?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) existing = await r.json();
  } catch {}

  // Build unit schedule using auto-detected settlement dates
  const depositGroups  = groupDeposits(deposits);
  const unitSettlement = matchSettlements(ibDaily, depositGroups);

  // Base NAV = inception day total / 1000 units
  const inceptionPoint = ibDaily.find(d => d.date === INCEPTION_DATE);
  const baseNav        = inceptionPoint ? inceptionPoint.totalValue / 1000 : INCEPTION_NAV;

  // Build daily series
  let cumulativeUnits = 0;
  const newSeries     = [];

  for (const point of ibDaily) {
    if (unitSettlement[point.date]) cumulativeUnits += unitSettlement[point.date];
    if (cumulativeUnits <= 0) continue;

    const nav    = point.totalValue / cumulativeUnits;
    const twr    = (nav / baseNav) * 100;
    const prior  = newSeries[newSeries.length - 1];
    const dailyReturnPct = prior ? ((nav / prior.nav) - 1) * 100 : 0;
    const dailyPnlUsd    = prior ? (nav - prior.nav) * cumulativeUnits  : 0;

    newSeries.push({
      date:           point.date,
      nav:            Math.round(nav              * 1e8) / 1e8,
      totalValue:     Math.round(point.totalValue * 1e4) / 1e4,
      totalUnits:     Math.round(cumulativeUnits  * 1e4) / 1e4,
      twr:            Math.round(twr              * 1e4) / 1e4,
      dailyReturnPct: Math.round(dailyReturnPct   * 1e4) / 1e4,
      dailyPnlUsd:    Math.round(dailyPnlUsd      * 1e2) / 1e2,
      source:         "ib-nav",
    });
  }

  // Merge: IB NAV points are authoritative; preserve "ib-live" points for dates not in NAV query
  const merged = [...newSeries];
  for (const pt of (existing.series || [])) {
    if (pt.source === "ib-live" && !merged.find(e => e.date === pt.date)) {
      merged.push(pt);
    }
  }
  merged.sort((a, b) => a.date.localeCompare(b.date));

  const navHistory = {
    inception:    { date: INCEPTION_DATE, nav: Math.round(baseNav * 1e8) / 1e8 },
    series:       merged,
    lastIBPull:   new Date().toISOString(),
    ibPoints:     newSeries.length,
  };

  await put("nav-history.json", JSON.stringify(navHistory), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });

  // Month-end summary for verification
  const monthEnds = ["2025-12-31","2026-01-30","2026-02-27","2026-03-31","2026-04-30","2026-05-29","2026-06-30"];
  const summary   = monthEnds.map(d => {
    const pt = merged.find(e => e.date === d);
    return pt ? { date: d, twr: pt.twr?.toFixed(2), nav: pt.nav?.toFixed(6), totalValue: Math.round(pt.totalValue) } : { date: d, missing: true };
  });

  return res.status(200).json({ ok: true, dailyPoints: merged.length, ibPoints: newSeries.length, monthEndSummary: summary });
}
