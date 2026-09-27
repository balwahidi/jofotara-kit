import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { BuildError, buildCreditNote, buildInvoice } from '../src/build.ts';
import type { CreditNoteInput, InvoiceInput, InvoiceLineInput } from '../src/build.ts';
import { readDocument } from '../src/document.ts';
import type { Track } from '../src/document.ts';
import { createMockServer } from '../src/mock.ts';
import { VAT_RATES } from '../src/rules.ts';
import { validate } from '../src/validate.ts';

const seller = { taxNumber: '11223344', name: 'Example Trading LLC', incomeSourceSequence: '7654321' };
const buyer = { scheme: 'NIN' as const, id: '9981234567', name: 'Example Customer' };
const date = '2026-09-27';
const invoice = (o: Partial<InvoiceInput> = {}) =>
  buildInvoice({ id: 'INV-1', icv: 1, issueDate: date, seller, lines: [{ name: 'Widget', quantity: 2, unitPrice: 10, taxRate: 16 }], ...o });
const creditNote = (o: Partial<CreditNoteInput> & Pick<CreditNoteInput, 'original' | 'lines'>) =>
  buildCreditNote({ id: 'RET-1', icv: 2, issueDate: date, reason: 'Customer return', ...o });
const clean = (xml: string, label = '') => assert.deepEqual(validate(xml).findings, [], label);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof BuildError, `expected a BuildError, got ${e}`);
    return e.code;
  }
  assert.fail('expected a BuildError');
};

describe('buildInvoice', () => {
  it('builds every track and payment term as a valid document', () => {
    for (const track of ['income', 'sales', 'special'] as Track[]) {
      for (const paymentTerms of ['cash', 'receivable'] as const) {
        const r = invoice({
          track,
          paymentTerms,
          buyer,
          lines: [{ name: 'Widget', quantity: 2, unitPrice: 10, taxRate: 16, ...(track === 'special' ? { specialTax: 1.5 } : {}) }],
        });
        clean(r.xml, `${track} ${paymentTerms}`);
        assert.equal(r.warnings.length, track === 'special' ? 1 : 0, 'special sales are labelled unverified');
        const name = `0${paymentTerms === 'cash' ? 1 : 2}${{ income: 1, sales: 2, special: 3 }[track]}`;
        assert.equal(r.document.typeName, name);
        assert.ok(r.xml.includes(`<cbc:InvoiceTypeCode name="${name}">388</cbc:InvoiceTypeCode>`));
      }
    }
  });

  it('writes amounts with six decimals and the request body', () => {
    const r = invoice();
    assert.ok(r.xml.includes('<cbc:PayableAmount currencyID="JO">23.200000</cbc:PayableAmount>'));
    assert.ok(r.xml.includes('<cbc:InvoicedQuantity unitCode="PCE">2.000000</cbc:InvoicedQuantity>'));
    assert.equal(Buffer.from(JSON.parse(r.body).invoice, 'base64').toString('utf8'), r.xml);
  });

  it('computes prices before tax: amount, VAT and totals', () => {
    const r = invoice({
      lines: [
        { name: 'A', quantity: 2, unitPrice: 10, taxRate: 16, discount: { amount: 1 } },
        { name: 'B', quantity: 1, unitPrice: 5, taxRate: 0, taxCategory: 'Z' },
        { name: 'C', quantity: 1, unitPrice: 3, taxRate: 0, taxCategory: 'O' },
      ],
    });
    assert.deepEqual(r.document.lines.map((l) => [l.category, l.extension, l.tax]), [['S', 19, 3.04], ['Z', 5, 0], ['O', 3, 0]]);
    assert.deepEqual(r.document.totals, { taxExclusive: 28, allowance: 1, tax: 3.04, specialTax: 0, taxInclusive: 30.04, payable: 30.04 });
  });

  it('takes VAT out of tax-inclusive prices so the payable equals the till total exactly', () => {
    const r = invoice({
      pricesIncludeTax: true,
      lines: [
        { name: 'Coffee', quantity: 3, unitPrice: 2.5, taxRate: 16, discount: { percent: 10 } },
        { name: 'Cheese', quantity: 0.35, unitPrice: 9.99, taxRate: 4 },
        { name: 'Bread', quantity: 2, unitPrice: 0.75, taxRate: 0, taxCategory: 'Z' },
      ],
      orderDiscount: { amount: 1.25 },
    });
    clean(r.xml);
    assert.equal(r.document.totals.payable, 10.4965);
    // VAT inside a tax-inclusive total is total × rate / (100 + rate).
    for (const l of r.document.lines) assert.ok(Math.abs(l.tax - (l.total * l.rate) / (100 + l.rate)) <= 0.000002, `line ${l.id}`);
    assert.equal(r.document.lines[0].tax, 0.83196);
  });

  it('spreads an order discount over the lines in proportion, to the micro-JOD', () => {
    const r = invoice({
      lines: [
        { name: 'A', quantity: 1, unitPrice: 10, taxRate: 16 },
        { name: 'B', quantity: 1, unitPrice: 20, taxRate: 16 },
        { name: 'C', quantity: 1, unitPrice: 30, taxRate: 16 },
      ],
      orderDiscount: { amount: 1 },
    });
    clean(r.xml);
    assert.deepEqual(r.document.lines.map((l) => l.discount), [0.166667, 0.333333, 0.5]);
    assert.equal(r.document.totals.allowance, 1);
    assert.equal(invoice({ orderDiscount: { percent: 10 } }).document.totals.allowance, 2);
  });

  it('uses a walk-in buyer by default and requires a named buyer where the manual does', () => {
    assert.ok(invoice().xml.includes('<cbc:ID schemeID="TN">0</cbc:ID>'));
    assert.equal(code(() => invoice({ paymentTerms: 'receivable' })), 'JOF-PTY-007');
    assert.equal(code(() => invoice({ paymentTerms: 'receivable', buyer: { id: '1' } })), 'JOF-PTY-007');
    assert.equal(code(() => invoice({ lines: [{ name: 'Car', quantity: 1, unitPrice: 20_000, taxRate: 16 }] })), 'JOF-PTY-007');
    clean(invoice({ buyer, lines: [{ name: 'Car', quantity: 1, unitPrice: 20_000, taxRate: 16 }] }).xml);
  });

  it('rejects input that would break a rule, with that rule as the code', () => {
    const line = (l: Partial<InvoiceLineInput>) => ({ lines: [{ name: 'A', quantity: 1, unitPrice: 1, taxRate: 16, ...l }] });
    const cases: [string, Partial<InvoiceInput>][] = [
      ['JOF-LIN-009', line({ taxRate: 6 })],
      ['JOF-LIN-006', line({ taxRate: 0 })],
      ['JOF-LIN-006', line({ taxRate: 16, taxCategory: 'Z' })],
      ['JOF-LIN-007', line({ taxRate: 0, taxCategory: 'E' as 'Z' })],
      ['JOF-LIN-002', line({ quantity: 0 })],
      ['JOF-LIN-005', line({ name: ' ' })],
      ['JOF-MTH-001', line({ discount: { amount: 2 } })],
      ['JOF-MTH-005', { orderDiscount: { amount: 100 } }],
      ['JOF-PTY-005', { buyer: { id: '-', name: 'x' } }],
      ['JOF-PTY-005', { buyer: { scheme: 'NAT' as 'TN', id: '1', name: 'x' } }],
      ['JOF-PTY-009', { buyer: { id: '1', name: 'x', governorate: 'Amman' } }],
      ['JOF-PTY-001', { seller: { ...seller, taxNumber: '' } }],
      ['JOF-PTY-003', { seller: { ...seller, incomeSourceSequence: '' } }],
      ['JOF-HDR-002', { uuid: 'INV-1' }],
      ['JOF-HDR-003', { issueDate: '27/09/2026' }],
      ['JOF-HDR-008', { icv: 0 }],
      ['JOF-XML-003', { lines: [] }],
      ['JOF-BLD-INPUT', { track: 'sales', ...line({ specialTax: 1 }) }],
    ];
    for (const [expected, input] of cases) assert.equal(code(() => invoice(input)), expected, JSON.stringify(input));
  });

  it('reads the issue date in Asia/Amman', () => {
    assert.equal(invoice({ issueDate: new Date('2026-09-26T22:30:00Z') }).document.issueDate, '2026-09-27');
  });

  it('reads its own documents back exactly', () => {
    const r = invoice({ track: 'special', lines: [{ name: 'S', quantity: 1.5, unitPrice: 7.25, taxRate: 16, specialTax: 2, discount: { percent: 5 } }] });
    assert.deepEqual(readDocument(r.xml), r.document);
    assert.deepEqual(readDocument(r.body), r.document);
  });
});

describe('buildCreditNote', () => {
  const original = invoice({
    paymentTerms: 'receivable',
    buyer,
    lines: [
      { name: 'Widget', quantity: 3, unitPrice: 10, taxRate: 16, discount: { amount: 1 } },
      { name: 'Book', quantity: 1, unitPrice: 3, taxRate: 0, taxCategory: 'O' },
    ],
  });

  it('mirrors the original: type name, buyer, line numbers, prices, categories and reference', () => {
    const r = creditNote({ original: original.xml, lines: [{ lineId: 2, quantity: 1 }] });
    clean(r.xml);
    assert.equal(r.document.typeName, '022');
    assert.deepEqual(r.document.buyer, original.document.buyer);
    assert.deepEqual(r.document.lines.map((l) => [l.id, l.name, l.unitPrice, l.category]), [[2, 'Book', 3, 'O']]);
    assert.deepEqual(r.document.billingReference, { id: 'INV-1', uuid: original.document.uuid, total: original.document.totals.payable });
    for (const part of ['<cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>', '<cbc:PrepaidAmount currencyID="JO">0.000000</cbc:PrepaidAmount>', 'Customer return']) {
      assert.ok(r.xml.includes(part), part);
    }
  });

  it('returns in parts, and the parts add up to the invoice exactly', () => {
    const first = creditNote({ original: original.xml, lines: [{ lineId: 1, quantity: 1 }] });
    const second = creditNote({ original: original.xml, previousReturns: [first.xml], lines: [{ lineId: 1, quantity: 1 }], id: 'RET-2', icv: 3 });
    const rest = creditNote({ original: original.xml, previousReturns: [first.xml, second.xml], lines: 'all', id: 'RET-3', icv: 4 });
    for (const r of [first, second, rest]) clean(r.xml);
    assert.deepEqual(rest.document.lines.map((l) => [l.id, l.quantity]), [[1, 1], [2, 1]]);
    for (const k of ['allowance', 'tax', 'payable'] as const) {
      const sum = [first, second, rest].reduce((s, r) => s + Math.round(r.document.totals[k] * 1e6), 0);
      assert.equal(sum, Math.round(original.document.totals[k] * 1e6), k);
    }
  });

  it('refuses over-returns, unknown lines and returns of other invoices', () => {
    const first = creditNote({ original: original.xml, lines: [{ lineId: 1, quantity: 2 }] });
    assert.equal(code(() => creditNote({ original: original.xml, previousReturns: [first.xml], lines: [{ lineId: 1, quantity: 2 }] })), 'JOF-STA-005');
    assert.equal(code(() => creditNote({ original: original.xml, lines: [{ lineId: 1, quantity: 2 }, { lineId: 1, quantity: 2 }] })), 'JOF-STA-005');
    assert.equal(code(() => creditNote({ original: original.xml, lines: [{ lineId: 9, quantity: 1 }] })), 'JOF-STA-009');
    const other = invoice({ uuid: '00000000-0000-4000-8000-000000000099' });
    const otherReturn = creditNote({ original: other.xml, lines: 'all' });
    assert.equal(code(() => creditNote({ original: original.xml, previousReturns: [otherReturn.xml], lines: 'all' })), 'JOF-STA-004');
    const all = creditNote({ original: original.xml, lines: 'all' });
    assert.equal(code(() => creditNote({ original: original.xml, previousReturns: [all.xml], lines: 'all' })), 'JOF-STA-005');
  });

  it('checks the return itself', () => {
    assert.equal(code(() => creditNote({ original: original.xml, lines: 'all', reason: ' ' })), 'JOF-RET-004');
    assert.equal(code(() => creditNote({ original: original.xml, lines: 'all', uuid: original.document.uuid })), 'JOF-RET-007');
    assert.equal(code(() => creditNote({ original: original.xml, lines: 'all', issueDate: '2026-09-26' })), 'JOF-STA-008');
    assert.equal(code(() => creditNote({ original: creditNote({ original: original.xml, lines: 'all' }).xml, lines: 'all' })), 'JOF-BLD-INPUT');
    assert.equal(code(() => creditNote({ original: 'not xml', lines: 'all' })), 'JOF-BLD-INPUT');
  });

  it('returns income and special-sales documents without the general-sales return fields', () => {
    for (const track of ['income', 'special'] as Track[]) {
      const inv = invoice({ track, lines: [{ name: 'A', quantity: 2, unitPrice: 10, taxRate: 16, ...(track === 'special' ? { specialTax: 1 } : {}) }] });
      const r = creditNote({ original: inv.xml, lines: [{ lineId: 1, quantity: 0.5 }] });
      clean(r.xml, track);
      assert.ok(!r.xml.includes('PrepaidAmount') && !r.xml.includes('BaseQuantity'), track);
    }
  });

  it('returns documents written by other generators', () => {
    const dir = new URL('./fixtures/corpus/', import.meta.url);
    const corpus = (n: string) => readFileSync(new URL(readdirSync(dir).find((f) => f.startsWith(n))!, dir), 'utf8');
    const previousReturns = [corpus('17'), corpus('18')];
    assert.equal(code(() => creditNote({ original: corpus('16'), previousReturns, lines: [{ lineId: 1, quantity: 2 }] })), 'JOF-STA-005');
    const rest = creditNote({ original: corpus('16'), previousReturns, lines: 'all', issueDate: '2026-01-16' });
    clean(rest.xml);
    assert.deepEqual(rest.document.lines.map((l) => [l.id, l.quantity]), [[1, 1], [2, 1]]);
    const returned = [...previousReturns.map((x) => readDocument(x).totals.payable), rest.document.totals.payable];
    assert.equal(Math.round(returned.reduce((a, b) => a + b, 0) * 1e6), Math.round(readDocument(corpus('16')).totals.payable * 1e6));
  });
});

describe('random invoices and return sequences', () => {
  // mulberry32: small seeded PRNG so failures reproduce.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('validates 400 random invoices and every return built from them', () => {
    const r = rng(20260927);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    for (let i = 0; i < 400; i++) {
      const track = pick(['income', 'sales', 'special'] as const);
      const inclusive = track !== 'income' && r() < 0.5;
      const lines: InvoiceLineInput[] = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, n) => {
        const quantity = r() < 0.5 ? 1 + Math.floor(r() * 5) : round3(0.001 + r() * 5);
        const unitPrice = round3(r() * 300);
        const taxRate = pick(VAT_RATES);
        const discount = r() < 0.3 ? { percent: Math.floor(r() * 50) } : r() < 0.3 ? { amount: round3(quantity * unitPrice * r() * 0.3) } : undefined;
        const specialTax = track === 'special' && !(inclusive && taxRate === 0) && r() < 0.7 ? round3(r() * unitPrice * 0.2) : undefined;
        return { name: `Item ${n + 1}`, quantity, unitPrice, taxRate, ...(taxRate === 0 ? { taxCategory: pick(['Z', 'O'] as const) } : {}), ...(discount ? { discount } : {}), ...(specialTax ? { specialTax } : {}) };
      });
      const paymentTerms = pick(['cash', 'receivable'] as const);
      const orderDiscount = r() < 0.3 ? { percent: Math.floor(r() * 20) } : undefined;
      const input: InvoiceInput = { id: `INV-${i}`, icv: i + 1, issueDate: date, track, paymentTerms, seller, buyer, pricesIncludeTax: inclusive, lines, ...(orderDiscount ? { orderDiscount } : {}) };
      let inv;
      try {
        inv = buildInvoice(input);
      } catch (e) {
        // A special tax larger than the tax-inclusive line amount is refused by design.
        if (e instanceof BuildError && e.code === 'JOF-BLD-INPUT') continue;
        throw e;
      }
      clean(inv.xml, `invoice ${i}: ${JSON.stringify(input)}`);

      const previous: string[] = [];
      for (let step = 0; step < 4; step++) {
        const left = invLeft(inv.xml, previous);
        if (!left.length) break;
        const [lineId, remaining] = pick(left);
        const quantity = r() < 0.3 ? remaining : Math.max(0.000001, Math.floor(remaining * r() * 1e6) / 1e6);
        const ret = creditNote({ original: inv.xml, previousReturns: previous, lines: [{ lineId, quantity }], id: `R-${i}-${step}`, icv: 1000 + step });
        clean(ret.xml, `return ${i}.${step}`);
        previous.push(ret.xml);
      }
      if (invLeft(inv.xml, previous).length) previous.push(creditNote({ original: inv.xml, previousReturns: previous, lines: 'all', id: `R-${i}-all`, icv: 2000 }).xml);
      const sum = previous.reduce((s, x) => s + Math.round(readDocument(x).totals.payable * 1e6), 0);
      assert.equal(sum, Math.round(inv.document.totals.payable * 1e6), `returns of invoice ${i} add up`);
    }
  });

  function invLeft(original: string, previous: string[]): [number, number][] {
    const returned = new Map<number, number>();
    for (const x of previous) for (const l of readDocument(x).lines) returned.set(l.id, (returned.get(l.id) ?? 0) + Math.round(l.quantity * 1e6));
    return readDocument(original).lines
      .map((l) => [l.id, (Math.round(l.quantity * 1e6) - (returned.get(l.id) ?? 0)) / 1e6] as [number, number])
      .filter(([, q]) => q > 0);
  }
});

describe('built documents through the mock', () => {
  const server = createMockServer();
  let base = '';
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('accepts an invoice and its returns in order', async () => {
    const submit = async (body: string) =>
      (await fetch(`${base}/core/invoices/`, { method: 'POST', headers: { 'Client-Id': 'id', 'Secret-Key': 'key', 'Content-Type': 'application/json' }, body })).status;
    const inv = invoice({ lines: [{ name: 'Widget', quantity: 3, unitPrice: 10, taxRate: 16 }] });
    const first = creditNote({ original: inv.xml, lines: [{ lineId: 1, quantity: 1 }] });
    const rest = creditNote({ original: inv.xml, previousReturns: [first.xml], lines: 'all', id: 'RET-2', icv: 3 });
    assert.deepEqual([await submit(inv.body), await submit(first.body), await submit(rest.body)], [200, 200, 200]);
  });
});
