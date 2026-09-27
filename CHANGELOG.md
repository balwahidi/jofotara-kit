# Changelog

## 0.3.0

- **Submission client.** `createClient({ baseUrl, clientId, secretKey }).submit(document)` sends a
  document and sorts the answer into four outcomes:
  - `accepted`: HTTP success, an explicit success status and a QR code;
  - `rejected`: explicit rejection and no sign of acceptance, also with HTTP 200;
  - `unknown`: timeouts, dropped connections, unreadable answers, 5xx, success without a QR;
  - `not-sent`: failed validation, or the server could not be reached at all.

  `baseUrl` is required, documents are validated before sending, nothing is retried
  automatically, and the secret key never appears in an outcome. `classifyResponse(status, body)`
  classifies responses received by other HTTP code.
- `jofotara-kit send <files...>` sends documents in order to the local mock, or with `--production`
  to the live API using credentials from `JOFOTARA_CLIENT_ID` / `JOFOTARA_SECRET_KEY`. It stops at the
  first document that is not accepted and exits 3 on an unknown outcome.
- Arabic guide: `README.ar.md`.

## 0.2.0

- **Document builder.** `buildInvoice` and `buildCreditNote` turn plain sale data into valid
  JoFotara XML for every track (income, general sales, special sales) and payment term:
  - exact arithmetic in micro-JOD, amounts written with six decimals;
  - tax-inclusive prices, where each line's amount plus VAT equals what the customer paid;
  - line discounts (amount or percent) and order discounts spread over the lines;
  - `S`/`Z`/`O` categories and the manual's VAT rates, checked before any XML is written;
  - buyer rules: walk-in default, named buyer for receivables and cash sales above 10,000 JOD;
  - returns built from the stored original XML, tracking earlier returns, refusing over-returns,
    and making the last return of a line add up to the invoice exactly.

  Build errors are `BuildError`s whose `code` is the rule the input would break.
- `jofotara-kit build input.json` builds documents from JSON, for stacks other than JavaScript.
- MCP tools `build_invoice` and `build_credit_note`.
- `readDocument` reads any JoFotara document (XML, request body or base64) into plain amounts.
- Special sales (013/023) follow the manual but are not yet verified against the live API; builds
  say so in `warnings`.
- Templates now render through the same writer and use six decimals.

## 0.1.0

- Validator with rules from the ISTD technical guide v1.4, each citing its page.
- Local mock of `POST /core/invoices/` that tracks accepted documents and returned quantities.
- Templates for cash and receivable income and general-sales invoices and returns.
- MCP server and agent skill.
