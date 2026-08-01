# Red Road Securities — Claude Session Context

## Project
Single-file SPA investor portal deployed on Vercel.
- **File:** `index.html` (everything is in this one file)
- **Live URL:** https://red-road-securities.vercel.app
- **Deploy command:** `vercel --prod` from this directory

## Stack
- Vanilla JS, HTML, CSS — no build step
- jsPDF 2.5.1 + jsPDF-AutoTable 3.8.2 (client-side PDF generation)
- Vercel Blob storage for data files:
  - `fund-data.json` — fund metadata
  - `nav-history.json` — NAV history
  - `investors.json` — investor records

## What was built
Two fully redesigned PDF financial statement generators inside `index.html`:

### `_generateBalanceSheetPDF`
Generates a **Statement of Net Assets** with:
- Per-position schedule (securities held)
- Composition of net assets reconciliation
- NAV per unit section
- Investor ownership table

### `_generateIncomeStatementPDF`
Generates a **Statement of Operations** with:
- Investment income breakdown
- All expense line items
- Realized/unrealized gains section
- Changes in net assets reconciliation
- Supplemental info

Both functions use shared helper renderers: `drawSection`, `drawSubSection`, `drawLine`, `drawRule`, `drawSubtotal`, `drawTotal`, `drawGrand`, `drawBlank`.

## Known past bugs (already fixed)
- `navHist` not defined — fixed
- `inceptionNav` not defined — fixed
- jsPDF `f2` spread operator bug — fixed

## How to continue in a new Claude session
Open PowerShell, navigate here, and run:
```
cd "C:\Claude Projects\RRS"
claude
```
Then say: "Read CLAUDE_CONTEXT.md and index.html so we can continue working on the investor portal."
