---
name: jofotara
description: Use when building, reviewing or debugging an integration with JoFotara (فوترة / نظام الفوترة الوطني, Jordan ISTD e-invoicing) — generating UBL 2.1 invoice XML, POSTing to backend.jofotara.gov.jo/core/invoices/, Client-Id/Secret-Key auth, InvoiceTypeCode 388/381 with names 011/021/012/022/013/023, tax categories S/Z/O, ICV, income source sequence, EINV_STATUS/EINV_QR responses, full/partial/multiple returns, or diagnosing a JoFotara rejection. Covers income, general sales and special sales documents.
---

# JoFotara integration

JoFotara is Jordan's national e-invoicing system (Income and Sales Tax Department, ISTD).
Every document is a UBL 2.1 `<Invoice>` XML, base64-encoded in one JSON POST. A successful
response carries the official QR code that must be printed on the seller's invoice.

The source of truth is the ISTD **technical guide for the national e-invoicing API, v1.4
(approved 2023-12-01)**. Every rule in the tooling below cites its page.

**There is no government sandbox.** Every request with real credentials creates a real
tax record. Never send test documents to production — use the local tooling.

## Tooling — use it, don't guess

```bash
npx jofotara-kit template invoice              # 388/012 sales invoice (S, Z and O lines)
npx jofotara-kit template credit-note          # 381/012 partial sales return
npx jofotara-kit template income-invoice       # 388/011 income invoice (no VAT)
npx jofotara-kit template income-credit-note   # 381/011 partial income return
npx jofotara-kit template receivable-invoice   # 388/022 (receivable-credit-note: 381/022)
npx jofotara-kit template income-receivable-invoice   # 388/021 (income-receivable-credit-note: 381/021)
npx jofotara-kit validate out/*.xml            # lint XML (also accepts {"invoice": base64} bodies)
npx jofotara-kit rules                         # every rule with its manual page
npx jofotara-kit serve --port 8080             # local mock of POST /core/invoices/
```

If the `jofotara` MCP server is connected, prefer its tools (`validate_invoice`, `get_template`,
`list_rules`, `explain_rule`) — same engine.

Workflow:

1. Generate the matching template and treat its structure as the contract; only values change.
2. Build the generator in the user's stack, mapping their data model to the fields in [reference.md](reference.md).
3. **Validate every XML your code produces** (`jofotara-kit validate`) and add it to tests/CI. Fix every error.
4. Point the base URL at `http://127.0.0.1:8080` (`jofotara-kit serve`) and run the full flow:
   invoice → partial return → second return → over-return (must fail).
5. Only then switch to `https://backend.jofotara.gov.jo` — config only.

Findings show `manual p.N` when the manual states the rule, `inferred` otherwise. The mock
models the manual; it is not the government system. Say so to the user.

## Quick reference

| Thing | Value (manual page) |
|---|---|
| Endpoint | `POST https://backend.jofotara.gov.jo/core/invoices/` (p.81) |
| Auth | headers `Client-Id`, `Secret-Key` from the portal's device-linking screen (p.7, p.9) |
| Body | `{"invoice": "<base64 of UTF-8 XML>"}` (p.81) |
| Type code | `388` new, `381` return (p.11, p.23) |
| Type name | `0` + payment (`1` cash, `2` receivable) + track (`1` income, `2` general sales, `3` special sales): 011, 021, 012, 022, 013, 023 |
| Document key | `cbc:ID` + `cbc:UUID` together; never reuse (p.11) |
| ICV | your own counter, 1, 2, 3 … (p.11) |
| Currency | `JOD` in the two currency codes, `currencyID="JO"` on every amount |
| Numbers | plain decimals; the manual fixes no decimal count (its samples use 0–3) |
| Discount | per line only; spread order discounts over lines first (p.17, p.38) |
| Tax categories | `S` at 1/2/3/4/5/7/8/10/16%, **`Z` = exempt**, **`O` = zero-rated**, both 0% (p.41) |
| Buyer ID | digits with `schemeID` `NIN`, `PN` or `TN` (p.14) |
| Buyer name | required for receivable invoices and cash invoices above 10,000 JOD (p.14) |
| Income docs | no `TaxTotal` at all; payable = exclusive − discounts (p.17) |
| QR | returned on success; print it on the invoice (p.81) |

## Returns (381) — what the manual allows (p.22)

- Returns are on **quantities** only, and may never exceed what was sold on the original.
- **Several returns** against one invoice are allowed until every quantity is returned —
  partial returns are the normal case, not an edge case.
- Each return line uses the **original line number**, item name, unit price and tax category/rate (p.29).
- `BillingReference` = original number, original UUID, original **total** (p.23).
- Reason in `PaymentMeans/InstructionNote` (p.26).
- Same type name as the original: 012 → 012, 022 → 022, 011 → 011, 021 → 021 (p.23, p.44).
- **General-sales returns** additionally need (p.49–54): line `TaxableAmount`,
  `<cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>`, one document `TaxSubtotal`
  per category and rate, and `<cbc:PrepaidAmount currencyID="JO">0</cbc:PrepaidAmount>`.
- Amounts stay positive; `381` carries the credit meaning.

## Non-negotiables

- **Never log or commit `Secret-Key`.**
- **Store the submitted XML, UUID and raw response per document.** Returns need the original UUID and total.
- **Idempotency:** never resubmit an accepted document. A timeout or an unreadable response is
  *unknown*, not rejected — verify before retrying.
- **Acceptance = HTTP success + explicit success status + a QR.** HTTP 200 alone is not acceptance.
- Keep a dry-run (build + save XML, no POST).

## Common mistakes (each maps to a rule)

- Using `Z` for zero-rated or `E` for exempt → `JOF-LIN-007` / `JOF-LIN-006`. Z is exempt, O is zero-rated.
- A VAT rate outside the list (e.g. 6%) → `JOF-LIN-009`.
- Walk-in buyer ID like `-` or a scheme like `NAT` → `JOF-PTY-005`.
- Invoice-level discount not spread over lines → `JOF-MTH-005`.
- Sales return built like an invoice (no TaxableAmount/BaseQuantity/subtotals/PrepaidAmount) → `JOF-RET-006/009/010/011`.
- Returning a receivable (022) invoice as 012 → `JOF-STA-007`.
- Renumbering return lines 1..n instead of the original line numbers → `JOF-STA-009`.
- Returning more than was sold across several returns → `JOF-STA-005`.

Field map, formulas and special-sales details: [reference.md](reference.md).
