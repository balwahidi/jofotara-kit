# jofotara-kit

**The JoFotara sandbox that doesn't exist — plus a document builder, a validator and an AI agent skill.**

JoFotara (فوترة, Jordan's ISTD e-invoicing system) has no test environment. The only way to
see if your XML is right is to send a real invoice with real credentials and create a real
tax record. `jofotara-kit` lets you get the shape right locally first:

- **`build`** — turns plain sale data into a valid invoice or return: tax-inclusive prices,
  line and order discounts, exempt and zero-rated lines, buyer rules, and partial returns that
  add up to the invoice exactly. From TypeScript/JavaScript, or from any language through JSON.
- **`validate`** — lints JoFotara UBL 2.1 XML against the rules of the official ISTD technical
  guide (v1.4): type names, tax categories `S`/`Z`/`O` and allowed VAT rates, buyer IDs,
  totals formulas, return references and the extra fields sales returns need. Every finding
  cites the manual page and says how to fix it.
- **`serve`** — a local mock of `POST /core/invoices/`: same path, same `Client-Id` /
  `Secret-Key` headers, same `{"invoice": base64}` body, `EINV_STATUS` / `EINV_RESULTS` /
  `EINV_QR`-shaped responses. It remembers what it accepted, so duplicates, returns against
  unknown invoices and **over-returns across several partial returns** are rejected, line by line.
- **`template`** — prints sales and income invoices and (partial) returns, cash and receivable,
  in the manual's shape.
- **Agent skill** — teaches Claude Code, Cursor, Devin, Codex & co. how JoFotara works and
  makes them validate their own output instead of guessing.

> Not affiliated with the Income and Sales Tax Department. Passing `jofotara-kit` means
> "passes known rules", not "accepted by ISTD".

## Quick start

```bash
npx jofotara-kit template invoice > invoice.xml
npx jofotara-kit validate invoice.xml
npx jofotara-kit serve --port 8080
```

Then point your integration's base URL at `http://127.0.0.1:8080` instead of
`https://backend.jofotara.gov.jo`. Nothing else changes.

```bash
curl -s http://127.0.0.1:8080/core/invoices/ \
  -H "Client-Id: test" -H "Secret-Key: test" -H "Content-Type: application/json" \
  -d "$(npx jofotara-kit template invoice --body)"
```

To use it from your code, tests or CI, install it (Node.js 22.18 or later):

```bash
npm install jofotara-kit
```

## Build documents

Describe the sale; the builder does the JoFotara math and writes XML that passes every rule.

```ts
import { buildInvoice, buildCreditNote } from 'jofotara-kit';

const invoice = buildInvoice({
  id: 'INV-1001', icv: 57,                       // your number and your invoice counter
  seller: { taxNumber: '…', name: '…', incomeSourceSequence: '…' },
  pricesIncludeTax: true,                        // shelf prices; VAT is taken out exactly
  lines: [
    { name: 'Coffee', quantity: 3, unitPrice: 2.5, taxRate: 16, discount: { percent: 10 } },
    { name: 'Bread', quantity: 2, unitPrice: 0.75, taxRate: 0, taxCategory: 'Z' },
  ],
  orderDiscount: { amount: 1 },                  // spread over the lines for you
});
// invoice.xml, invoice.body (the request body to POST), invoice.document (every computed amount)

const ret = buildCreditNote({
  original: storedInvoiceXml,                    // the XML you sent and stored
  previousReturns: [storedReturnXml],            // earlier returns against it
  lines: [{ lineId: 1, quantity: 1 }],           // or 'all' for everything not yet returned
  reason: 'Customer return', id: 'RET-1001', icv: 58,
});
```

What it takes care of:

- **Money** — exact arithmetic in micro-JOD, amounts written with six decimals. With
  `pricesIncludeTax`, each line's amount plus VAT equals what the customer paid, exactly.
- **Tax categories** — `S` at an allowed rate; a 0% line must say `Z` (exempt) or `O`
  (zero-rated). Rates outside the manual's list are refused before any XML exists.
- **Buyers** — a walk-in buyer (`TN` `0`, "Cash customer") by default; a named buyer is
  required for receivables and cash sales above 10,000 JOD.
- **Returns** — built from the original XML alone: original line numbers, names, prices,
  categories, buyer and type name are mirrored, sales returns get their extra fields, returned
  quantities are tracked across returns (over-returns are refused), and the last return of a line
  takes exactly what is left, so the returns always add up to the invoice.
- **Errors** — a `BuildError` whose `code` is the rule the input would break, e.g. `JOF-STA-005`
  for an over-return.

Keep the `uuid` of every document you send: a retry after a timeout must reuse the same XML.
`readDocument(xml)` reads any stored JoFotara document back into plain amounts.

**Special sales (013/023)** follow the manual's formulas (p.56-80) but have not been verified
against the live API yet; builds report this in `warnings`.

### From any language

`jofotara-kit build` takes the same fields as JSON, so PHP, .NET, Python or Java code can shell out
to it:

```bash
npx jofotara-kit build invoice.json > INV-1001.xml
npx jofotara-kit build invoice.json --body     # the request body instead of XML
npx jofotara-kit build invoice.json --json     # {xml, body, document, warnings}
```

A return names its original (and earlier returns) by path, relative to the JSON file:

```json
{
  "type": "credit-note",
  "original": "INV-1001.xml",
  "previousReturns": ["RET-1000.xml"],
  "lines": [{ "lineId": 1, "quantity": 1 }],
  "reason": "Customer return",
  "id": "RET-1001",
  "icv": 58
}
```

A build error exits with status 1 and prints the rule id and the reason.

## MCP server

Give any MCP client (Claude Code, Cursor, Devin, Windsurf, …) direct access to the validator:

```json
{
  "mcpServers": {
    "jofotara": { "command": "npx", "args": ["-y", "jofotara-kit", "mcp"] }
  }
}
```

Tools: `build_invoice`, `build_credit_note`, `validate_invoice`, `get_template`, `list_rules`, `explain_rule`.

## Install the agent skill

```bash
npx skills add balwahidi/jofotara-kit
```

Or copy [`skills/jofotara`](skills/jofotara) into your agent's skills folder
(`.claude/skills/`, `.devin/skills/`, `.cursor/skills/`, …).

## Commands

| Command | What it does |
|---|---|
| `build [input.json] [--body \| --json]` | Build an invoice or return from JSON (see [Build documents](#build-documents)). Reads stdin if no file. Exit 1 on build errors. |
| `validate [files...] [--json]` | Validate XML, a `{"invoice": base64}` request body, or bare base64. Reads stdin if no files. Exit 1 on errors. |
| `serve [--port] [--host] [--client-id] [--secret-key] [--reject-status]` | Run the mock. With `--client-id/--secret-key` only those credentials pass. `--reject-status 200` tests "HTTP 200 but rejected" handling. |
| `template <name> [--body]` | Print a sample XML, or its JSON request body. Names below. |
| `rules [--json]` | List every rule. |
| `mcp` | MCP server over stdio. |

Templates:

| Name | Type | Document |
|---|---|---|
| `invoice` | 388 / 012 | Sales invoice, cash (`S`, `Z` and `O` lines) |
| `credit-note` | 381 / 012 | Partial sales return |
| `receivable-invoice` | 388 / 022 | Sales invoice, receivable (named buyer) |
| `receivable-credit-note` | 381 / 022 | Partial return of a receivable sales invoice |
| `income-invoice` | 388 / 011 | Income invoice, cash (no VAT) |
| `income-credit-note` | 381 / 011 | Partial income return |
| `income-receivable-invoice` | 388 / 021 | Income invoice, receivable (named buyer) |
| `income-receivable-credit-note` | 381 / 021 | Partial return of a receivable income invoice |

Mock extras: `GET /_kit/invoices` lists accepted documents, `DELETE /_kit/invoices` resets.
Mock responses add a `JOFOTARA_KIT` key with full findings and fixes; everything else mirrors
the real response shape. The mock QR decodes to `JOFOTARA-KIT MOCK|NOT A TAX DOCUMENT|…`.

## Use in CI

```bash
# have your test suite write the XML your integration generates to out/, then:
npx jofotara-kit validate out/*.xml
```

Or as a library:

```ts
import { validate } from 'jofotara-kit';

const report = validate(xml);
if (!report.ok) throw new Error(report.findings.map((f) => `${f.rule}: ${f.message}`).join('\n'));
```

## Where the rules come from

Every rule states its source:

| Source | Meaning |
|---|---|
| `manual p.N` | Stated in the ISTD technical guide for the e-invoicing API, v1.4 (2023-12-01), page N. |
| `verified` | Observed on the live API and contributed back with a redacted response. |
| `inferred` | Follows from UBL 2.1 or accounting common sense; not in the manual. |

Run `npx jofotara-kit rules` for the full list.

## Scope

The builder, the validator and the mock cover all six document families in the manual, in JOD:
income (`011`/`021`), general sales (`012`/`022`) and special sales (`013`/`023`), each as new
invoice (388) and return (381) — full, partial and multiple returns. Special sales are not yet
verified against the live API. Templates cover income and general sales.

## Contributing

The most valuable contribution is **a real JoFotara response** — especially a rejection the
kit didn't predict — with the XML (redacted: tax numbers, names, income source sequence) and
the response body. That is how `inferred` rules become `verified`. Never share your Client-Id
or Secret-Key.

```bash
npm install
npm test
npm run build
```

## License

MIT
