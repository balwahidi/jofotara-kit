# Regression corpus

Valid JoFotara documents written in a different style from the kit's templates: six-decimal
amounts, fractional quantities, tax-inclusive prices folded into line amounts, order discounts
spread over lines, mixed rates, exempt and zero-rated lines, walk-in and named buyers.

Every name, number and identifier in these files is invented. UUIDs follow the pattern
`00000000-0000-4000-8000-0000000000NN`, where `NN` is the file number, so each return points at
the invoice it returns:

| Return | Original |
|---|---|
| `03` | `02` |
| `05` | `04` |
| `09` | `08` |
| `14` | `11` |
| `17`, `18`, `19` | `16` (three units sold; `19` returns two more after two were already returned) |

`test/corpus.test.ts` checks that every document validates with zero findings, that the
validator catches mistakes injected into them, and that the mock accepts the returns in order
and rejects the over-return.
