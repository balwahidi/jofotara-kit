# JoFotara — reference

Source: ISTD technical guide for linking to the national e-invoicing system through the API,
**v1.4, approved 2023-12-01** (82 pages). Page numbers below refer to that guide.

For complete XML, generate it rather than copying from docs:

```bash
npx jofotara-kit template invoice | credit-note | income-invoice | income-credit-note
npx jofotara-kit template receivable-invoice | receivable-credit-note | income-receivable-invoice | income-receivable-credit-note
```

---

## 1. Transport (p.9, p.81)

```
POST https://backend.jofotara.gov.jo/core/invoices/
Client-Id:     <from the device-linking screen>
Secret-Key:    <from the device-linking screen>
Content-Type:  application/json

{"invoice": "<base64 of the UTF-8 UBL XML>"}
```

Credentials come from the portal: *device linking → new link → user name + income source
sequence → Add* (p.6–7). Each linked device gets its own Client-Id / Secret-Key.

```js
const res = await fetch(`${baseUrl}/core/invoices/`, {
  method: 'POST',
  headers: { 'Client-Id': clientId, 'Secret-Key': secretKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
  signal: AbortSignal.timeout(30_000),
});
const raw = await res.text();
let body; try { body = JSON.parse(raw); } catch { body = null; }
```

Make `baseUrl` configurable so the same code talks to `jofotara-kit serve` locally.

## 2. Document types (p.9, 11, 23, 32, 44, 57, 70)

`<cbc:InvoiceTypeCode name="0PT">388|381</cbc:InvoiceTypeCode>` — P = payment (1 cash, 2 receivable), T = track.

| Track | Who | New cash / receivable | Return cash / receivable | Tax blocks |
|---|---|---|---|---|
| Income (دخل) | taxpayers not registered for sales tax | 011 / 021 | 011 / 021 | none |
| General sales (مبيعات عامة) | registered for sales tax | 012 / 022 | 012 / 022 | VAT per line + document total |
| Special sales (مبيعات خاصة) | registered for special sales tax | 013 / 023 | 013 / 023 | special tax (OTH) + VAT per line |

A return uses the same name as its original.

## 3. Header (p.11–12)

| Element | Meaning |
|---|---|
| `cbc:ProfileID` | `reporting:1.0` |
| `cbc:ID` | invoice number |
| `cbc:UUID` | UUID minted by your system; **ID + UUID are the document key** |
| `cbc:IssueDate` | `yyyy-mm-dd` |
| `cbc:Note` | optional note |
| `DocumentCurrencyCode`, `TaxCurrencyCode` | `JOD` |
| `AdditionalDocumentReference[ID=ICV]/UUID` | invoice counter, from 1 upwards; you choose the sequence |

## 4. Parties

**Seller** (p.13): `PostalAddress/Country = JO`, `PartyTaxScheme/CompanyID` = seller tax number,
`PartyLegalEntity/RegistrationName` = name as registered with ISTD.

**Buyer** (p.14–15, 35–36):

| Element | Rule |
|---|---|
| `PartyIdentification/ID@schemeID` | digits only; `NIN` national number, `PN` personal number (non-Jordanian), `TN` tax number |
| `PostalAddress/PostalZone` | optional postal code |
| `PostalAddress/CountrySubentityCode` | sales only, optional: JO-AM, JO-AZ, JO-IR, JO-BA, JO-MN, JO-MD, JO-MA, JO-KA, JO-JA, JO-AT, JO-AQ, JO-AJ |
| `PartyTaxScheme/CompanyID` | sales documents carry the buyer number here too |
| `PartyLegalEntity/RegistrationName` | **required** for receivable invoices and cash invoices above 10,000 JOD |
| `AccountingContact/Telephone` | optional |

The manual defines no value for an anonymous buyer. `TN` with `0` is a common convention for
walk-in customers; confirm with one low-value live document.

On returns the buyer data comes from the original invoice, unchanged (p.25, p.47).

**Income source sequence** (p.16): `SellerSupplierParty/Party/PartyIdentification/ID`.

## 5. Lines

| Element | Formula |
|---|---|
| `cbc:ID` | line number, unique in the document; on returns = the original line number (p.29) |
| `InvoicedQuantity@unitCode="PCE"` | quantity |
| `LineExtensionAmount` | price × quantity − line discount |
| `Price/PriceAmount` | unit price **before tax** |
| `Price/AllowanceCharge/Amount` | line discount amount (`AllowanceChargeReason` `DISCOUNT`) |
| `TaxTotal/TaxAmount` (sales) | line amount × rate |
| `TaxTotal/RoundingAmount` (sales) | line amount + tax |
| `TaxSubtotal/TaxCategory/ID` + `Percent` | `S` + rate, `Z` exempt 0, `O` zero-rated 0 (p.41) |

Supported VAT rates: 0, 1, 2, 3, 4, 5, 7, 8, 10, 16 (p.41). `Percent` may be written `16`, `16.00` or `16.000`.

If prices are tax-inclusive, convert them: amount = inclusive / (1 + rate), tax = inclusive − amount.

## 6. Totals

| Element | Income (p.17) | General sales (p.38) | Special sales (p.63) |
|---|---|---|---|
| `AllowanceCharge/Amount` | Σ line discounts | Σ line discounts | Σ line discounts |
| `TaxTotal/TaxAmount` | — (no TaxTotal) | Σ line VAT | Σ line VAT |
| `TaxExclusiveAmount` | Σ price × qty | Σ price × qty | Σ price × qty |
| `TaxInclusiveAmount` | excl − disc | excl − disc + VAT | excl − disc + special + VAT |
| `AllowanceTotalAmount` | Σ line discounts | Σ line discounts | Σ line discounts |
| `PayableAmount` | = inclusive | = inclusive | = inclusive |

JoFotara does not accept an invoice-level discount: spread it over the lines first (p.17, p.38).

## 7. Returns (p.21–30, 43–55, 69–80)

Allowed (p.22): returns on quantities only; never more than the original quantity; several
returns per invoice until all quantities are returned.

Every return:

- `InvoiceTypeCode` 381, same name as the original.
- `BillingReference/InvoiceDocumentReference`: original `ID`, original `UUID`, `DocumentDescription` = original total.
- Own `ID`, own `UUID`, own ICV.
- `PaymentMeans`: `PaymentMeansCode listID="UN/ECE 4461"` 10 + `InstructionNote` = reason.
- Only the returned lines, each with the original line number, name, unit price, category and rate.
- Totals computed over the returned part only, same formulas as §6.

General-sales returns (012/022) additionally (p.49–54):

```xml
<!-- each line -->
<cac:TaxSubtotal>
  <cbc:TaxableAmount currencyID="JO">line amount</cbc:TaxableAmount>
  <cbc:TaxAmount currencyID="JO">line tax</cbc:TaxAmount>
  <cac:TaxCategory>…</cac:TaxCategory>
</cac:TaxSubtotal>
<cac:Price>
  <cbc:PriceAmount currencyID="JO">unit price</cbc:PriceAmount>
  <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>
  <cac:AllowanceCharge>…</cac:AllowanceCharge>
</cac:Price>

<!-- document: one TaxSubtotal per category + rate -->
<cac:TaxTotal>
  <cbc:TaxAmount currencyID="JO">Σ tax</cbc:TaxAmount>
  <cac:TaxSubtotal>
    <cbc:TaxableAmount currencyID="JO">Σ line amounts at this rate</cbc:TaxableAmount>
    <cbc:TaxAmount currencyID="JO">Σ tax at this rate</cbc:TaxAmount>
    <cac:TaxCategory>…S / 16…</cac:TaxCategory>
  </cac:TaxSubtotal>
</cac:TaxTotal>

<cac:LegalMonetaryTotal>
  … <cbc:PrepaidAmount currencyID="JO">0</cbc:PrepaidAmount> <cbc:PayableAmount …/>
</cac:LegalMonetaryTotal>
```

## 8. Special sales (p.56–80)

Each line carries two `TaxSubtotal`s in its `TaxTotal`:

1. special tax — `TaxableAmount` = line amount, `TaxAmount` = special tax, category `S`,
   `TaxScheme/ID` = `OTH`, no `Percent`;
2. general tax — `TaxableAmount` = line amount, `TaxAmount` = (line amount + special tax) × rate,
   category `S` + `Percent`, `TaxScheme/ID` = `VAT`.

Line `TaxAmount` = general tax; `RoundingAmount` = amount + special + general.

## 9. Responses (p.81) and persistence

The manual only says the server answers with JSON reporting success or failure, and that a
successful response contains the QR code to print. Robust handling:

- **accepted** only when HTTP is successful, the status says success (e.g. `EINV_STATUS`
  `SUBMITTED`, `EINV_RESULTS.status` `PASS`) **and** a QR (`EINV_QR`) is present;
- **rejected** only with explicit rejection evidence (`NOT_SUBMITTED`, `ERROR`, a non-empty
  `EINV_RESULTS.ERRORS`) and no success/QR evidence;
- anything else, timeouts included, is **unknown**: keep the XML, UUID and ICV, and verify
  before any retry. A retry reuses the same XML/UUID/ICV.

Persist per document: kind, number, UUID, ICV, the exact XML, raw response, status, QR, and for
returns the original document and the returned quantity per original line.

## 10. Not covered by the manual

- Error payload format and codes.
- An anonymous-buyer identifier (see §4).
- Field length limits.
- A test environment — there is none.

A real, redacted JoFotara response you can share is the most valuable input for this project.
