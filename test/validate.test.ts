import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_LINES, TEMPLATES, sampleCreditNote, sampleInvoice, samplePayable, toRequestBody } from '../src/templates.ts';
import { validate } from '../src/validate.ts';

const ORIGINAL = { id: 'INV-001', uuid: '3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f', payable: samplePayable() };
const invoice = sampleInvoice({ uuid: ORIGINAL.uuid });
const PARTIAL = [
  { id: 1, name: 'Widget', qty: 1, price: 10, discount: 0.5, taxRate: 16 },
  { id: 3, name: 'Book', qty: 1, price: 3, taxRate: 0 },
];
const credit = sampleCreditNote(ORIGINAL, { lines: PARTIAL });
const rules = (input: string) => validate(input).findings.map((f) => f.rule);

describe('validate', () => {
  it('accepts every template with zero findings', () => {
    for (const [name, build] of Object.entries(TEMPLATES)) assert.deepEqual(validate(build()).findings, [], name);
  });

  it('summarises tracks, payment terms and lines', () => {
    const r = validate(invoice);
    assert.equal(r.invoice?.track, 'sales');
    assert.equal(r.invoice?.paymentTerms, 'cash');
    assert.equal(r.invoice?.payable, 30.04);
    assert.deepEqual(r.invoice?.lines.map((l) => [l.id, l.category, l.rate]), [['1', 'S', 16], ['2', 'Z', 0], ['3', 'O', 0]]);
    assert.equal(validate(sampleInvoice({ paymentTerms: 'receivable', customer: { id: '99887766', name: 'Buyer' } })).invoice?.typeName, '022');
  });

  it('decodes the JSON request body and bare base64', () => {
    const body = toRequestBody(invoice);
    assert.equal(validate(body).ok, true);
    assert.equal(validate(JSON.parse(body).invoice).ok, true);
  });

  it('rejects broken envelopes and XML', () => {
    assert.deepEqual(rules('{"xml": "abc"}'), ['JOF-ENV-001']);
    assert.deepEqual(rules('{"invoice": "!!!"}'), ['JOF-ENV-002']);
    assert.deepEqual(rules('<Invoice><cbc:ID>'), ['JOF-XML-001']);
    assert.deepEqual(rules('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/>'), ['JOF-XML-002']);
  });

  it('accepts any number of decimals but only plain decimals and currencyID JO', () => {
    const twoDp = invoice.replace(/currencyID="JO">(\d+)\.(\d{2})\d{4}</g, 'currencyID="JO">$1.$2<');
    assert.notEqual(twoDp, invoice);
    assert.deepEqual(rules(twoDp), []);
    assert.deepEqual(rules(invoice.replace('>30.040000</cbc:PayableAmount>', '>3.004e1</cbc:PayableAmount>')), ['JOF-AMT-001']);
    assert.ok(rules(invoice.replaceAll('currencyID="JO"', 'currencyID="JOD"')).includes('JOF-AMT-002'));
  });

  it('knows Z is exempt, O is zero-rated and S needs a supported rate', () => {
    assert.deepEqual(rules(invoice.replace('UN/ECE 5305">Z<', 'UN/ECE 5305">E<')), ['JOF-LIN-007']);
    assert.deepEqual(rules(invoice.replace('UN/ECE 5305">O<', 'UN/ECE 5305">S<')), ['JOF-LIN-006']);
    const rate6 = sampleInvoice({ lines: [{ name: 'X', qty: 1, price: 100, taxRate: 6 }] });
    assert.deepEqual(rules(rate6), ['JOF-LIN-009']);
    const wrongTax = invoice.replace(/(<cbc:TaxAmount currencyID="JO">)3\.040000(<\/cbc:TaxAmount>\s*<cbc:RoundingAmount)/, '$13.000$2');
    assert.ok(rules(wrongTax).includes('JOF-LIN-008'));
  });

  it('requires digit buyer IDs with schemeID NIN, PN or TN', () => {
    assert.deepEqual(rules(sampleInvoice({ customer: { id: '-', name: 'x' } })), ['JOF-PTY-005']);
    assert.deepEqual(rules(sampleInvoice({ customer: { scheme: 'NIN', id: '9981012345', name: 'x' } })), []);
    assert.deepEqual(rules(invoice.replace('schemeID="TN"', 'schemeID="NAT"')), ['JOF-PTY-005']);
  });

  it('requires a buyer name on receivable invoices and cash invoices above 10,000 JOD', () => {
    assert.deepEqual(rules(sampleInvoice({ paymentTerms: 'receivable', customer: { id: '99887766' } })), ['JOF-PTY-007']);
    assert.deepEqual(rules(sampleInvoice({ customer: { id: '0' } })), []);
    assert.deepEqual(rules(sampleInvoice({ customer: { id: '0' }, lines: [{ name: 'Car', qty: 1, price: 20000, taxRate: 16 }] })), ['JOF-PTY-007']);
  });

  it('checks governorate codes', () => {
    assert.deepEqual(rules(sampleInvoice({ customer: { id: '1', name: 'x', city: 'JO-AM' } })), []);
    assert.deepEqual(rules(sampleInvoice({ customer: { id: '1', name: 'x', city: 'Amman' } })), ['JOF-PTY-009']);
  });

  it('flags wrong totals and element order', () => {
    assert.deepEqual(rules(invoice.replace('>30.040000</cbc:PayableAmount>', '>31.000</cbc:PayableAmount>')), ['JOF-MTH-008']);
    const swapped = invoice.replace(/(<cbc:DocumentCurrencyCode>JOD<\/cbc:DocumentCurrencyCode>)(\s*)(<cbc:TaxCurrencyCode>JOD<\/cbc:TaxCurrencyCode>)/, '$3$2$1');
    assert.deepEqual(rules(swapped), ['JOF-XML-004']);
  });

  it('keeps income documents free of TaxTotal and sales documents with it', () => {
    assert.ok(rules(invoice.replace('name="012"', 'name="011"')).includes('JOF-INC-001'));
    assert.ok(rules(TEMPLATES['income-invoice']().replace('name="011"', 'name="012"')).includes('JOF-INC-002'));
    assert.deepEqual(rules(sampleInvoice({ track: 'income', paymentTerms: 'receivable', customer: { id: '0' } })), ['JOF-PTY-007']);
  });

  it('accepts every official type name and rejects unknown ones', () => {
    for (const name of ['011', '021']) assert.equal(validate(TEMPLATES['income-invoice']().replace('name="011"', `name="${name}"`)).invoice?.track, 'income');
    assert.deepEqual(rules(invoice.replace('name="012"', 'name="099"')), ['JOF-HDR-005']);
  });

  it('requires the manual return fields on sales returns', () => {
    assert.deepEqual(rules(credit.replace(/<cbc:InstructionNote>.*<\/cbc:InstructionNote>/, '')), ['JOF-RET-004']);
    assert.ok(rules(credit.replace(/<cac:BillingReference>[\s\S]*<\/cac:BillingReference>/, '')).includes('JOF-RET-001'));
    assert.deepEqual(rules(credit.replace(/\s*<cbc:PrepaidAmount[^/]*\/cbc:PrepaidAmount>/, '')), ['JOF-RET-011']);
    assert.deepEqual(rules(credit.replace(/\s*<cbc:BaseQuantity[^/]*\/cbc:BaseQuantity>/, '')), ['JOF-RET-009']);
    assert.deepEqual(rules(credit.replace(/(11\.020000<\/cbc:RoundingAmount>\s*<cac:TaxSubtotal>)\s*<cbc:TaxableAmount[^/]*\/cbc:TaxableAmount>/, '$1')), ['JOF-RET-006']);
    const noDocSubtotals = credit.replace(/(<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="JO">1\.520000<\/cbc:TaxAmount>)[\s\S]*?(\s*<\/cac:TaxTotal>\s*<cac:LegalMonetaryTotal>)/, '$1$2');
    assert.deepEqual(rules(noDocSubtotals), ['JOF-RET-010']);
  });

  it('checks document tax subtotals per rate against the lines', () => {
    const wrong = credit.replace(/(<cac:TaxSubtotal>\s*<cbc:TaxableAmount currencyID="JO">)9\.500000(<\/cbc:TaxableAmount>\s*<cbc:TaxAmount currencyID="JO">1\.520000<\/cbc:TaxAmount>\s*<cac:TaxCategory>\s*<cbc:ID schemeAgencyID="6" schemeID="UN\/ECE 5305">S<\/cbc:ID>\s*<cbc:Percent>16<\/cbc:Percent>\s*<cac:TaxScheme>\s*<cbc:ID[^>]*>VAT<\/cbc:ID>\s*<\/cac:TaxScheme>\s*<\/cac:TaxCategory>\s*<\/cac:TaxSubtotal>\s*<cac:TaxSubtotal>)/, '$19.000$2');
    assert.deepEqual(rules(wrong), ['JOF-MTH-010']);
  });

  it('allows return lines to keep their original line numbers, but not duplicates', () => {
    assert.deepEqual(validate(credit).invoice?.lines.map((l) => l.id), ['1', '3']);
    assert.deepEqual(rules(credit.replace('<cbc:ID>3</cbc:ID>', '<cbc:ID>1</cbc:ID>')), ['JOF-LIN-001']);
  });

  it('rejects a return larger than the original total and the invoice number as reference UUID', () => {
    assert.deepEqual(rules(sampleCreditNote({ ...ORIGINAL, payable: 10 }, { lines: DEFAULT_LINES })), ['JOF-RET-008']);
    assert.deepEqual(rules(credit.replace(`<cbc:UUID>${ORIGINAL.uuid}</cbc:UUID>`, '<cbc:UUID>INV-001</cbc:UUID>')), ['JOF-RET-002']);
  });

  it('validates special-sales lines with OTH and VAT subtotals', () => {
    const special = invoice
      .replace('name="012"', 'name="013"')
      .replace(/<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/, `<cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">10.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="JO">495.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="JO">50.500</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="JO">555.500</cbc:RoundingAmount>
      <cac:TaxSubtotal><cbc:TaxableAmount currencyID="JO">495.000</cbc:TaxableAmount><cbc:TaxAmount currencyID="JO">10.00</cbc:TaxAmount>
        <cac:TaxCategory><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID><cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">OTH</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
      <cac:TaxSubtotal><cbc:TaxableAmount currencyID="JO">495.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="JO">50.500</cbc:TaxAmount>
        <cac:TaxCategory><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID><cbc:Percent>10.00</cbc:Percent><cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>Malboro</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="JO">50.00</cbc:PriceAmount>
      <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason><cbc:Amount currencyID="JO">5.00</cbc:Amount></cac:AllowanceCharge></cac:Price>
  </cac:InvoiceLine>`)
      .replace(/<cac:AllowanceCharge>\s*<cbc:ChargeIndicator>false<\/cbc:ChargeIndicator>\s*<cbc:AllowanceChargeReason>discount[\s\S]*?<\/cac:LegalMonetaryTotal>/, `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason><cbc:Amount currencyID="JO">5.00</cbc:Amount></cac:AllowanceCharge>
  <cac:TaxTotal><cbc:TaxAmount currencyID="JO">50.500</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="JO">500.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="JO">555.500</cbc:TaxInclusiveAmount><cbc:AllowanceTotalAmount currencyID="JO">5.00</cbc:AllowanceTotalAmount><cbc:PayableAmount currencyID="JO">555.500</cbc:PayableAmount></cac:LegalMonetaryTotal>`);
    const r = validate(special);
    assert.deepEqual(r.findings, []);
    assert.equal(r.invoice?.track, 'special');
    assert.ok(rules(special.replace('>OTH<', '>VAT<')).includes('JOF-INC-003'));
  });

  it('escapes Arabic and special characters correctly', () => {
    assert.deepEqual(validate(sampleInvoice({ lines: [{ name: 'كتاب & قلم <A4>', qty: 1, price: 5, taxRate: 16 }] })).findings, []);
  });
});
