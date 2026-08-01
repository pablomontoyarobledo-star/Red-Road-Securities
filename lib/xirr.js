// Money-weighted rate of return (XIRR) — the annualized rate that makes the
// NPV of a series of dated cash flows equal zero. Used to score each
// investor's own return, accounting for when their money actually went in.
//
// Bisection, not Newton's method: our cash-flow shape is always N negative
// flows (deposits) followed by one final positive flow (current value), which
// brackets a single sign change cleanly and reliably — no risk of Newton
// diverging or oscillating on a bad starting guess.

const MS_PER_YEAR = 365 * 86400000;

// cashflows: [{date: Date, amount: number}] — needs at least one negative and
// one positive amount. Returns the annualized rate, or null if no root is
// found (degenerate input, e.g. all-zero or same-sign cash flows).
export function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const t0 = cashflows.reduce((min, cf) => (cf.date < min ? cf.date : min), cashflows[0].date);
  const years = cf => (cf.date - t0) / MS_PER_YEAR;
  const npv = r => cashflows.reduce((s, cf) => s + cf.amount / Math.pow(1 + r, years(cf)), 0);

  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  let tries = 0;
  while (flo * fhi > 0 && hi < 1e6 && tries < 60) {
    hi *= 2;
    fhi = npv(hi);
    tries++;
  }
  if (flo * fhi > 0 || !isFinite(flo) || !isFinite(fhi)) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if ((flo < 0) === (fm < 0)) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; }
  }
  return (lo + hi) / 2;
}
