import { randomUUID } from 'node:crypto';
import type { Doc, DocLine } from './document.ts';
import { toMicro } from './money.ts';
import { renderDocument } from './render.ts';

export { toRequestBody } from './render.ts';

export interface SampleLine {
  /** Line number. On returns, use the line number of the original invoice (manual p.29). */
  id?: number;
  name: string;
  qty: number;
  price: number;
  discount?: number;
  /** VAT percent (sales only): 1, 2, 3, 4, 5, 7, 8, 10 or 16 → S; 0 → O (zero-rated). */
  taxRate?: number;
  /** Exempt line (sales only) → category Z at 0%. */
  exempt?: boolean;
}

export interface SampleBuyer {
  scheme?: 'NIN' | 'PN' | 'TN';
  id: string;
  name?: string;
  phone?: string;
  postalZone?: string;
  /** Governorate code, e.g. JO-AM (sales documents only). */
  city?: string;
}

export interface SampleOptions {
  /** sales (default): VAT document 012/022. income: 011/021, no TaxTotal anywhere. */
  track?: 'sales' | 'income';
  paymentTerms?: 'cash' | 'receivable';
  id?: string;
  uuid?: string;
  issueDate?: string;
  icv?: number;
  note?: string;
  seller?: { taxNumber: string; name: string; tsp: string };
  customer?: SampleBuyer;
  lines?: SampleLine[];
}

export interface CreditNoteOptions extends SampleOptions {
  reason?: string;
}

export interface OriginalInvoice {
  id: string;
  uuid: string;
  payable: number;
}

const DEFAULT_SELLER = { taxNumber: '12345678', name: 'Example Trading LLC', tsp: '1234567' };
// The manual documents no anonymous-buyer value; TN/0 is a common convention for walk-in customers.
const WALK_IN: SampleBuyer = { scheme: 'TN', id: '0', name: 'Cash customer' };
export const DEFAULT_LINES: SampleLine[] = [
  { id: 1, name: 'Widget', qty: 2, price: 10, discount: 1, taxRate: 16 },
  { id: 2, name: 'Bread', qty: 1, price: 5, exempt: true },
  { id: 3, name: 'Book', qty: 1, price: 3, taxRate: 0 },
];

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Line math from the manual: amount = qty × price − discount; VAT = amount × rate (fils-rounded). */
export function computeLines(lines: SampleLine[], track: 'sales' | 'income' = 'sales') {
  return lines.map((l, i) => {
    const gross = r3(l.qty * l.price);
    const discount = r3(l.discount ?? 0);
    const ext = r3(gross - discount);
    const rate = track === 'income' || l.exempt ? 0 : l.taxRate ?? 0;
    const tax = r3((ext * rate) / 100);
    const category = track === 'income' ? '' : l.exempt ? 'Z' : rate > 0 ? 'S' : 'O';
    return { ...l, id: l.id ?? i + 1, gross, discount, ext, rate, tax, category, net: r3(ext + tax) };
  });
}

function build(o: SampleOptions, credit?: { original: OriginalInvoice; reason: string }): string {
  const track = o.track ?? 'sales';
  const seller = o.seller ?? DEFAULT_SELLER;
  const buyer = o.customer ?? WALK_IN;
  const lines: DocLine[] = computeLines(o.lines ?? DEFAULT_LINES, track).map((l) => ({
    id: l.id,
    name: l.name,
    quantity: toMicro(l.qty),
    unitPrice: toMicro(l.price),
    discount: toMicro(l.discount),
    extension: toMicro(l.ext),
    ...(l.category ? { category: l.category as DocLine['category'] } : {}),
    rate: l.rate,
    tax: toMicro(l.tax),
    specialTax: 0n,
  }));
  const doc: Doc = {
    kind: credit ? 'credit-note' : 'invoice',
    track,
    paymentTerms: o.paymentTerms ?? 'cash',
    id: o.id ?? (credit ? `R1-${credit.original.id}` : 'INV-001'),
    uuid: o.uuid ?? randomUUID(),
    issueDate: o.issueDate ?? new Date().toISOString().slice(0, 10),
    icv: String(o.icv ?? (credit ? 2 : 1)),
    ...(o.note ? { note: o.note } : {}),
    seller: { taxNumber: seller.taxNumber, name: seller.name, incomeSourceSequence: seller.tsp },
    buyer: {
      scheme: buyer.scheme ?? 'TN',
      id: buyer.id,
      ...(buyer.name ? { name: buyer.name } : {}),
      ...(buyer.phone ? { phone: buyer.phone } : {}),
      ...(buyer.postalZone ? { postalZone: buyer.postalZone } : {}),
      ...(buyer.city ? { governorate: buyer.city } : {}),
    },
    lines,
    ...(credit
      ? { billingReference: { id: credit.original.id, uuid: credit.original.uuid, total: toMicro(credit.original.payable) }, reason: credit.reason }
      : {}),
  };
  return renderDocument(doc);
}

/** A new invoice (388) in the shape documented by the ISTD manual. */
export const sampleInvoice = (o: SampleOptions = {}) => build(o);

/** A return (381) against `original`. Pass only the returned lines, with their original line numbers. */
export const sampleCreditNote = (original: OriginalInvoice, o: CreditNoteOptions = {}) =>
  build(o, { original, reason: o.reason ?? 'ارجاع فاتورة' });

/** Payable total of a sample built from these lines. */
export const samplePayable = (lines: SampleLine[] = DEFAULT_LINES, track: 'sales' | 'income' = 'sales') =>
  r3(computeLines(lines, track).reduce((s, l) => s + l.net, 0));

const SAMPLE_ORIGINAL = { id: 'INV-001', uuid: '00000000-0000-4000-8000-000000000000' };
// Receivable documents need a named buyer (manual p.14); a return repeats the original buyer (p.25).
const RECEIVABLE_BUYER: SampleBuyer = { scheme: 'TN', id: '87654321', name: 'Example Customer LLC' };
const receivable = { paymentTerms: 'receivable', customer: RECEIVABLE_BUYER } as const;
// A partial return: one of the two widgets, and the book — original line numbers 1 and 3.
const PARTIAL_RETURN: SampleLine[] = [
  { id: 1, name: 'Widget', qty: 1, price: 10, discount: 0.5, taxRate: 16 },
  { id: 3, name: 'Book', qty: 1, price: 3, taxRate: 0 },
];

/** Named samples exposed by the CLI and the MCP server. */
export const TEMPLATES = {
  invoice: () => sampleInvoice(),
  'credit-note': () => sampleCreditNote({ ...SAMPLE_ORIGINAL, payable: samplePayable() }, { lines: PARTIAL_RETURN }),
  'income-invoice': () => sampleInvoice({ track: 'income' }),
  'income-credit-note': () =>
    sampleCreditNote({ ...SAMPLE_ORIGINAL, payable: samplePayable(DEFAULT_LINES, 'income') }, { track: 'income', lines: PARTIAL_RETURN, reason: 'ارجاع فاتورة دخل' }),
  'receivable-invoice': () => sampleInvoice(receivable),
  'receivable-credit-note': () =>
    sampleCreditNote({ ...SAMPLE_ORIGINAL, payable: samplePayable() }, { ...receivable, lines: PARTIAL_RETURN }),
  'income-receivable-invoice': () => sampleInvoice({ ...receivable, track: 'income' }),
  'income-receivable-credit-note': () =>
    sampleCreditNote({ ...SAMPLE_ORIGINAL, payable: samplePayable(DEFAULT_LINES, 'income') }, { ...receivable, track: 'income', lines: PARTIAL_RETURN, reason: 'ارجاع فاتورة دخل' }),
} satisfies Record<string, () => string>;

export type TemplateName = keyof typeof TEMPLATES;
