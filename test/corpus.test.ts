import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createMockServer } from '../src/mock.ts';
import { toRequestBody } from '../src/templates.ts';
import { validate } from '../src/validate.ts';

const dir = new URL('./fixtures/corpus/', import.meta.url);
const corpus: Record<string, string> = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.xml'))
    .map((f) => [f.slice(0, 2), readFileSync(new URL(f, dir), 'utf8')]),
);
const errors = (xml: string) => validate(xml).findings.filter((f) => f.severity === 'error').map((f) => f.rule);

describe('regression corpus', () => {
  it('has every document the README lists', () => {
    assert.equal(Object.keys(corpus).length, 19);
  });

  it('validates every document with zero findings', () => {
    for (const [n, xml] of Object.entries(corpus)) assert.deepEqual(validate(xml).findings, [], `corpus ${n}`);
  });
});

describe('mistakes injected into valid documents', () => {
  const cases: [string, string, (xml: string) => string, string][] = [
    ['wrong PayableAmount', '01', (x) => x.replace(/(<cbc:PayableAmount currencyID="JO">)[\d.]+/, '$19.990000'), 'JOF-MTH-008'],
    ['VAT rate 6%', '01', (x) => x.replaceAll('<cbc:Percent>8.00</cbc:Percent>', '<cbc:Percent>6.00</cbc:Percent>'), 'JOF-LIN-009'],
    ['negative amount', '01', (x) => x.replace(/(<cbc:PayableAmount currencyID="JO">)([\d.]+)/, '$1-$2'), 'JOF-AMT-003'],
    ['walk-in buyer ID "-"', '15', (x) => x.replace('schemeID="TN">0<', 'schemeID="TN">-<'), 'JOF-PTY-005'],
    ['buyer scheme NAT', '15', (x) => x.replace('schemeID="TN">0<', 'schemeID="NAT">0<'), 'JOF-PTY-005'],
    ['category E for an exempt line', '06', (x) => x.replace(/(UN\/ECE 5305">)Z</, '$1E<'), 'JOF-LIN-007'],
    ['currency USD', '01', (x) => x.replace('<cbc:DocumentCurrencyCode>JOD<', '<cbc:DocumentCurrencyCode>USD<'), 'JOF-HDR-007'],
    ['wrong ProfileID', '01', (x) => x.replace('reporting:1.0', 'reporting:2.0'), 'JOF-HDR-001'],
    ['unitCode EA', '01', (x) => x.replaceAll('unitCode="PCE"', 'unitCode="EA"'), 'JOF-LIN-004'],
    ['no income source sequence', '01', (x) => x.replace(/<cac:SellerSupplierParty>[\s\S]*?<\/cac:SellerSupplierParty>/, ''), 'JOF-XML-003'],
    ['receivable invoice without a buyer name', '02', (x) => x.replace('<cbc:RegistrationName>Example Customer LLC</cbc:RegistrationName>', ''), 'JOF-PTY-007'],
    ['sales return without BaseQuantity', '03', (x) => x.replace(/<cbc:BaseQuantity[^>]*>[^<]*<\/cbc:BaseQuantity>/g, ''), 'JOF-RET-009'],
    ['sales return without PrepaidAmount', '03', (x) => x.replace(/<cbc:PrepaidAmount[^>]*>[^<]*<\/cbc:PrepaidAmount>/, ''), 'JOF-RET-011'],
    ['return without a reason', '03', (x) => x.replace(/<cbc:InstructionNote>[^<]*<\/cbc:InstructionNote>/, ''), 'JOF-RET-004'],
    ['return without BillingReference', '03', (x) => x.replace(/<cac:BillingReference>[\s\S]*?<\/cac:BillingReference>/, ''), 'JOF-RET-001'],
    ['income document named as sales', '11', (x) => x.replace('name="011"', 'name="012"'), 'JOF-INC-002'],
    ['line discount removed but totals kept', '10', (x) => x.replace(/<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/, ''), 'JOF-XML-003'],
  ];

  for (const [name, n, mutate, rule] of cases) {
    it(`${name} → ${rule}`, () => {
      const mutated = mutate(corpus[n]);
      assert.notEqual(mutated, corpus[n], 'the mutation must change the document');
      assert.ok(errors(mutated).includes(rule), `expected ${rule}, got ${errors(mutated).join(', ') || 'no errors'}`);
    });
  }
});

describe('corpus through the mock', () => {
  const server = createMockServer({ clientId: 'id', secretKey: 'key' });
  let base = '';

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(async () => {
    await fetch(`${base}/_kit/invoices`, { method: 'DELETE' });
  });

  async function submit(xml: string) {
    const res = await fetch(`${base}/core/invoices/`, {
      method: 'POST',
      headers: { 'Client-Id': 'id', 'Secret-Key': 'key', 'Content-Type': 'application/json' },
      body: toRequestBody(xml),
    });
    const body = await res.json();
    return { status: res.status, codes: (body.EINV_RESULTS?.ERRORS ?? []).map((e: { EINV_CODE: string }) => e.EINV_CODE) as string[] };
  }

  it('accepts each return after its original', async () => {
    for (const [original, ret] of [['02', '03'], ['04', '05'], ['08', '09'], ['11', '14']]) {
      assert.equal((await submit(corpus[original])).status, 200, `corpus ${original}`);
      assert.equal((await submit(corpus[ret])).status, 200, `corpus ${ret}`);
    }
  });

  it('tracks several partial returns and rejects the over-return', async () => {
    for (const n of ['16', '17', '18']) assert.equal((await submit(corpus[n])).status, 200, `corpus ${n}`);
    assert.deepEqual(await submit(corpus['19']), { status: 400, codes: ['JOF-STA-005'] });
  });

  it('rejects a return whose type name differs from the original', async () => {
    assert.equal((await submit(corpus['04'])).status, 200);
    assert.deepEqual(await submit(corpus['05'].replace('name="022"', 'name="012"')), { status: 400, codes: ['JOF-STA-007'] });
  });

  it('rejects a duplicate submission', async () => {
    assert.equal((await submit(corpus['02'])).status, 200);
    assert.deepEqual(await submit(corpus['02']), { status: 400, codes: ['JOF-STA-001'] });
  });
});
