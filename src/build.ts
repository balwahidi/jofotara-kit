import { randomUUID } from 'node:crypto';
import type { Buyer, Doc, DocLine, JofotaraDocument, PaymentTerms, Seller, TaxCategory, Track } from './document.ts';
import { parseDocument, toPublic, totalsOf } from './document.ts';
import type { Micro } from './money.ts';
import { SCALE, allocate, divRound, format6, mulDiv, times, toMicro } from './money.ts';
import { renderDocument, toRequestBody } from './render.ts';
import { GOVERNORATES, VAT_RATES } from './rules.ts';
import type { RuleId } from './rules.ts';

/** Thrown when the input cannot become a valid JoFotara document. `code` is the rule it would break. */
export class BuildError extends Error {
  override name = 'BuildError';
  readonly code: RuleId | 'JOF-BLD-INPUT';
  constructor(code: RuleId | 'JOF-BLD-INPUT', message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export type Discount = { amount: number } | { percent: number };

export interface InvoiceLineInput {
  name: string;
  /** Fractional quantities are allowed (e.g. 0.5 kg). */
  quantity: number;
  /** Unit price before tax, or including tax when `pricesIncludeTax` is set. */
  unitPrice: number;
  /** Line discount: an amount for the whole line, or a percent of it. Same tax basis as the price. */
  discount?: Discount;
  /** VAT percent for sales and special sales: 1, 2, 3, 4, 5, 7, 8, 10 or 16, or 0 with a category. */
  taxRate?: number;
  /** Required when `taxRate` is 0: `Z` exempt or `O` zero-rated (manual p.41). Defaults to `S` above 0. */
  taxCategory?: TaxCategory;
  /** Special tax amount for the line (special sales only), before VAT. */
  specialTax?: number;
}

export interface BuyerInput {
  scheme?: Buyer['scheme'];
  id?: string;
  name?: string;
  phone?: string;
  postalZone?: string;
  governorate?: string;
}

interface Header {
  /** Your invoice number. */
  id: string;
  /** Defaults to a fresh random UUID. Keep it: a retry must reuse the same UUID. */
  uuid?: string;
  /** Your invoice counter (1, 2, 3, …), which you persist per income source. */
  icv: number | string;
  /** yyyy-mm-dd, or a Date read in Asia/Amman. Defaults to today in Amman. */
  issueDate?: string | Date;
  note?: string;
}

export interface InvoiceInput extends Header {
  /** income (011/021), sales (012/022, default) or special sales (013/023, not verified against the live API). */
  track?: Track;
  paymentTerms?: PaymentTerms;
  seller: Seller;
  /** Defaults to a walk-in buyer (TN 0, "Cash customer"). Required for receivables and cash sales above 10,000 JOD. */
  buyer?: BuyerInput;
  /** Prices, discounts and special tax already include VAT; the builder extracts it so line totals match the till exactly. */
  pricesIncludeTax?: boolean;
  lines: InvoiceLineInput[];
  /** Order-level discount, spread over the lines in proportion (JoFotara only accepts line discounts). */
  orderDiscount?: Discount;
}

export interface ReturnLineInput {
  /** Line number on the original invoice. */
  lineId: number | string;
  quantity: number;
}

export interface CreditNoteInput extends Header {
  /** The original invoice as you stored it: XML, a {"invoice": base64} body, or base64. */
  original: string;
  /** Earlier returns against the same invoice, so quantities already returned are respected. */
  previousReturns?: string[];
  /** The lines to return, or "all" for everything not yet returned. */
  lines: ReturnLineInput[] | 'all';
  /** Written to PaymentMeans/InstructionNote (manual p.26). */
  reason: string;
}

export interface BuildResult {
  xml: string;
  /** The JSON request body for POST /core/invoices/. */
  body: string;
  document: JofotaraDocument;
  /** Things to know before sending, e.g. that special sales are not verified against the live API. */
  warnings: string[];
}

export const SPECIAL_SALES_WARNING =
  'Special sales (013/023) follow the ISTD manual (p.56-80) but have not been verified against the live JoFotara API. ' +
  'Check one low-value document before relying on it.';

export const WALK_IN_BUYER: Buyer = { scheme: 'TN', id: '0', name: 'Cash customer' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_REQUIRED_ABOVE = 10_000n * SCALE;

/** Build a new invoice (388). Throws a BuildError when the input cannot produce a valid document. */
export function buildInvoice(input: InvoiceInput): BuildResult {
  const track = input.track ?? 'sales';
  const paymentTerms = input.paymentTerms ?? 'cash';
  if (!['income', 'sales', 'special'].includes(track)) fail('JOF-HDR-005', `track "${track}" is not income, sales or special.`);
  if (!['cash', 'receivable'].includes(paymentTerms)) fail('JOF-HDR-005', `paymentTerms "${paymentTerms}" is not cash or receivable.`);
  if (!Array.isArray(input.lines) || input.lines.length === 0) fail('JOF-XML-003', 'An invoice needs at least one line.');

  const lines = computeLines(input, track);
  const payable = totalsOf(lines).payable;
  const doc: Doc = {
    kind: 'invoice',
    track,
    paymentTerms,
    ...header(input),
    seller: checkSeller(input.seller),
    buyer: checkBuyer(input.buyer, paymentTerms, payable),
    lines,
  };
  return result(doc);
}

/** Build a return (381) against an original invoice. Throws a BuildError on over-returns and bad input. */
export function buildCreditNote(input: CreditNoteInput): BuildResult {
  const original = read(input.original, 'original');
  if (original.kind !== 'invoice') fail('JOF-BLD-INPUT', `The original is a return (381), not an invoice (388).`);
  if (!input.reason?.trim()) fail('JOF-RET-004', 'A return needs a reason.');

  const returned = new Map<number, Pick<DocLine, 'quantity' | 'discount' | 'extension' | 'tax' | 'specialTax'>>();
  for (const [i, xml] of (input.previousReturns ?? []).entries()) {
    const prev = read(xml, `previousReturns[${i}]`);
    if (prev.kind !== 'credit-note' || prev.billingReference?.uuid !== original.uuid) {
      fail('JOF-STA-004', `previousReturns[${i}] (${prev.id}) is not a return of ${original.id} (${original.uuid}).`);
    }
    for (const l of prev.lines) {
      const r = returned.get(l.id) ?? { quantity: 0n, discount: 0n, extension: 0n, tax: 0n, specialTax: 0n };
      returned.set(l.id, {
        quantity: r.quantity + l.quantity,
        discount: r.discount + l.discount,
        extension: r.extension + l.extension,
        tax: r.tax + l.tax,
        specialTax: r.specialTax + l.specialTax,
      });
    }
  }

  const byId = new Map(original.lines.map((l) => [l.id, l]));
  const remaining = (l: DocLine) => l.quantity - (returned.get(l.id)?.quantity ?? 0n);
  const requested = input.lines === 'all'
    ? original.lines.filter((l) => remaining(l) > 0n).map((l) => ({ line: l, quantity: remaining(l) }))
    : mergeRequests(input.lines).map(({ lineId, quantity }) => {
      const line = byId.get(lineId);
      if (!line) fail('JOF-STA-009', `Line ${lineId} is not on the original invoice ${original.id}.`);
      return { line, quantity };
    });
  if (requested.length === 0) fail('JOF-STA-005', `Everything on ${original.id} has already been returned.`);

  const lines = requested
    .sort((a, b) => a.line.id - b.line.id)
    .map(({ line, quantity }) => returnLine(line, quantity, remaining(line), returned.get(line.id), original.track));

  const h = header(input);
  if (h.uuid === original.uuid) fail('JOF-RET-007', 'A return needs its own UUID, not the original one.');
  if (h.issueDate < original.issueDate) fail('JOF-STA-008', `Return date ${h.issueDate} is before the invoice date ${original.issueDate}.`);

  return result({
    kind: 'credit-note',
    track: original.track,
    paymentTerms: original.paymentTerms,
    ...h,
    seller: original.seller,
    buyer: original.buyer,
    lines,
    billingReference: { id: original.id, uuid: original.uuid, total: totalsOf(original.lines).payable },
    reason: input.reason.trim(),
  });
}

/** An invoice or a return, told apart by `type` (default "invoice"), as the CLI and MCP tools take it. */
export type BuildRequest = ({ type?: 'invoice' } & InvoiceInput) | ({ type: 'credit-note' } & CreditNoteInput);

export function buildDocument(request: BuildRequest): BuildResult {
  if (!request || typeof request !== 'object') fail('JOF-BLD-INPUT', 'Pass an invoice or credit-note object.');
  const { type, ...input } = request;
  if (type === 'credit-note') return buildCreditNote(input as CreditNoteInput);
  if (type === undefined || type === 'invoice') return buildInvoice(input as InvoiceInput);
  return fail('JOF-BLD-INPUT', `type "${type}" is not "invoice" or "credit-note".`);
}

function result(doc: Doc): BuildResult {
  const xml = renderDocument(doc);
  return { xml, body: toRequestBody(xml), document: toPublic(doc), warnings: doc.track === 'special' ? [SPECIAL_SALES_WARNING] : [] };
}

// ── Invoice lines ─────────────────────────────────────────────────────

interface Prepared {
  input: InvoiceLineInput;
  quantity: Micro;
  price: Micro;
  gross: Micro;
  lineDiscount: Micro;
  category?: TaxCategory;
  rate: number;
  special: Micro;
}

function computeLines(input: InvoiceInput, track: Track): DocLine[] {
  const inclusive = !!input.pricesIncludeTax && track !== 'income';
  const prepared = input.lines.map((l, i) => prepare(l, i + 1, track));

  const net = prepared.map((p) => p.gross - p.lineDiscount);
  const orderTotal = net.reduce((a, b) => a + b, 0n);
  const orderDiscount = discountAmount(input.orderDiscount, orderTotal, 'orderDiscount');
  if (orderDiscount > orderTotal) fail('JOF-MTH-005', `orderDiscount ${format6(orderDiscount)} exceeds the lines' total ${format6(orderTotal)}.`);
  const shares = allocate(orderDiscount, net);

  return prepared.map((p, i) => {
    const discount = p.lineDiscount + shares[i];
    const id = i + 1;
    const base = { id, name: p.input.name.trim(), quantity: p.quantity, category: p.category, rate: p.rate, specialTax: p.special };
    if (!inclusive || p.rate === 0) {
      // Prices before tax, or a 0% line where there is no tax to take out.
      const extension = p.gross - discount;
      const special = inclusive ? 0n : p.special;
      const tax = mulDiv(extension + special, BigInt(p.rate), 100n);
      if (inclusive && p.special > 0n) fail('JOF-BLD-INPUT', `Line ${id}: special tax with a 0% VAT rate cannot be taken out of a tax-inclusive price.`);
      return clean({ ...base, unitPrice: p.price, discount, extension, tax });
    }
    // The line total the customer paid: extension + special tax + VAT = total, exactly.
    const total = p.gross - discount;
    const factor = BigInt(100 + p.rate);
    const beforeVat = mulDiv(total, 100n, factor);
    if (beforeVat < p.special) fail('JOF-BLD-INPUT', `Line ${id}: special tax ${format6(p.special)} exceeds the line amount before VAT.`);
    let discountExcl = mulDiv(discount, 100n, factor);
    const unitPrice = divRound((beforeVat - p.special + discountExcl) * SCALE, p.quantity);
    let extension = times(p.quantity, unitPrice) - discountExcl;
    let tax = total - extension - p.special;
    // Price rounding can leave a few micro-JOD on the wrong side of zero on an (almost) fully
    // discounted line. Absorb them in the discount; extension + special + VAT still equals total.
    const shift = extension < 0n ? extension : tax < 0n ? -tax : 0n;
    discountExcl += shift;
    extension -= shift;
    tax += shift;
    return clean({ ...base, unitPrice, discount: discountExcl, extension, tax });
  });
}

function prepare(l: InvoiceLineInput, n: number, track: Track): Prepared {
  if (!l || typeof l.name !== 'string' || !l.name.trim()) fail('JOF-LIN-005', `Line ${n} has no name.`);
  if (!(Number(l.quantity) > 0)) fail('JOF-LIN-002', `Line ${n} quantity must be greater than zero.`);
  if (!(Number(l.unitPrice) >= 0)) fail('JOF-AMT-003', `Line ${n} unitPrice must be zero or more.`);
  const quantity = toMicro(Number(l.quantity));
  if (quantity === 0n) fail('JOF-LIN-002', `Line ${n} quantity rounds to zero at six decimals.`);
  const price = toMicro(Number(l.unitPrice));
  const gross = times(quantity, price);
  const lineDiscount = discountAmount(l.discount, gross, `Line ${n} discount`);
  if (lineDiscount > gross) fail('JOF-MTH-001', `Line ${n} discount ${format6(lineDiscount)} exceeds the line amount ${format6(gross)}.`);

  if (track === 'income') {
    if (l.specialTax) fail('JOF-BLD-INPUT', `Line ${n}: special tax is only for special sales.`);
    return { input: l, quantity, price, gross, lineDiscount, rate: 0, special: 0n };
  }
  const rate = l.taxRate;
  if (rate === undefined || !VAT_RATES.includes(rate)) {
    fail('JOF-LIN-009', `Line ${n} taxRate ${rate ?? '(missing)'} is not one of ${VAT_RATES.join(', ')}.`);
  }
  const category = l.taxCategory ?? (rate > 0 ? 'S' : undefined);
  if (!category) fail('JOF-LIN-006', `Line ${n} has a 0% rate: set taxCategory to "Z" (exempt) or "O" (zero-rated).`);
  if (!['S', 'Z', 'O'].includes(category)) fail('JOF-LIN-007', `Line ${n} taxCategory "${category}" is not S, Z or O.`);
  if ((category === 'S') !== rate > 0) fail('JOF-LIN-006', `Line ${n}: category ${category} does not match ${rate}%.`);
  if (l.specialTax && track !== 'special') fail('JOF-BLD-INPUT', `Line ${n}: special tax is only for special sales.`);
  if (!(Number(l.specialTax ?? 0) >= 0)) fail('JOF-AMT-003', `Line ${n} specialTax must be zero or more.`);
  return { input: l, quantity, price, gross, lineDiscount, category, rate, special: toMicro(Number(l.specialTax ?? 0)) };
}

function discountAmount(d: Discount | undefined, of: Micro, what: string): Micro {
  if (!d) return 0n;
  if ('percent' in d) {
    if (!(d.percent >= 0 && d.percent <= 100)) fail('JOF-BLD-INPUT', `${what} percent must be between 0 and 100.`);
    return mulDiv(of, toMicro(d.percent), 100n * SCALE);
  }
  if (!(d.amount >= 0)) fail('JOF-AMT-003', `${what} amount must be zero or more.`);
  return toMicro(d.amount);
}

// ── Return lines ──────────────────────────────────────────────────────

type Returned = Pick<DocLine, 'quantity' | 'discount' | 'extension' | 'tax' | 'specialTax'>;

function returnLine(line: DocLine, quantity: Micro, remaining: Micro, before: Returned | undefined, track: Track): DocLine {
  if (quantity > remaining) {
    fail('JOF-STA-005', `Line ${line.id} ("${line.name}"): returning ${format6(quantity)}, but only ${format6(remaining)} of ${format6(line.quantity)} are left.`);
  }
  const base = { id: line.id, name: line.name, quantity, unitPrice: line.unitPrice, category: line.category, rate: line.rate };
  if (quantity === remaining) {
    // The last of this line: return exactly what is left, so all returns add up to the invoice.
    const b = before ?? { quantity: 0n, discount: 0n, extension: 0n, tax: 0n, specialTax: 0n };
    return clean({
      ...base,
      discount: line.discount - b.discount,
      extension: line.extension - b.extension,
      tax: line.tax - b.tax,
      specialTax: line.specialTax - b.specialTax,
    });
  }
  const share = (v: Micro) => mulDiv(v, quantity, line.quantity);
  const discount = share(line.discount);
  const extension = times(quantity, line.unitPrice) - discount;
  const specialTax = share(line.specialTax);
  const tax = track === 'income' ? 0n : mulDiv(extension + specialTax, BigInt(line.rate), 100n);
  return clean({ ...base, discount, extension, tax, specialTax });
}

function mergeRequests(lines: ReturnLineInput[]) {
  if (!Array.isArray(lines) || lines.length === 0) fail('JOF-BLD-INPUT', 'Pass the lines to return, or "all".');
  const merged = new Map<number, Micro>();
  for (const [i, l] of lines.entries()) {
    const id = Number(l?.lineId);
    if (!Number.isInteger(id) || id < 1) fail('JOF-STA-009', `lines[${i}].lineId "${l?.lineId}" is not a line number.`);
    if (!(Number(l.quantity) > 0)) fail('JOF-LIN-002', `lines[${i}] quantity must be greater than zero.`);
    merged.set(id, (merged.get(id) ?? 0n) + toMicro(Number(l.quantity)));
  }
  return [...merged].map(([lineId, quantity]) => ({ lineId, quantity }));
}

// ── Header and parties ────────────────────────────────────────────────

function header(h: Header) {
  if (typeof h.id !== 'string' || !h.id.trim()) fail('JOF-XML-003', 'The document needs an id (your invoice number).');
  const uuid = h.uuid ?? randomUUID();
  if (!UUID_RE.test(uuid)) fail('JOF-HDR-002', `uuid "${uuid}" is not a valid UUID.`);
  const icv = String(h.icv ?? '');
  if (!/^[1-9]\d*$/.test(icv)) fail('JOF-HDR-008', `icv "${icv}" must be your counter: 1, 2, 3, …`);
  return { id: h.id.trim(), uuid, icv, issueDate: issueDate(h.issueDate), ...(h.note?.trim() ? { note: h.note.trim() } : {}) };
}

const AMMAN_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' });

function issueDate(d: string | Date | undefined): string {
  if (d === undefined || d instanceof Date) {
    const date = d ?? new Date();
    if (isNaN(date.getTime())) fail('JOF-HDR-003', 'issueDate is an invalid Date.');
    return AMMAN_DATE.format(date);
  }
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok) fail('JOF-HDR-003', `issueDate "${d}" is not yyyy-mm-dd.`);
  return d;
}

function checkSeller(s: Seller): Seller {
  if (!s?.taxNumber?.trim()) fail('JOF-PTY-001', 'seller.taxNumber is required.');
  if (!s.name?.trim()) fail('JOF-PTY-002', 'seller.name (as registered with ISTD) is required.');
  if (!s.incomeSourceSequence?.trim()) fail('JOF-PTY-003', 'seller.incomeSourceSequence is required.');
  return { taxNumber: s.taxNumber.trim(), name: s.name.trim(), incomeSourceSequence: s.incomeSourceSequence.trim() };
}

function checkBuyer(b: BuyerInput | undefined, terms: PaymentTerms, payable: Micro): Buyer {
  const needsName = terms === 'receivable' || payable > NAME_REQUIRED_ABOVE;
  if (!b) {
    if (needsName) fail('JOF-PTY-007', terms === 'receivable' ? 'A receivable invoice needs a named buyer.' : 'A cash invoice above 10,000 JOD needs a named buyer.');
    return WALK_IN_BUYER;
  }
  const buyer: Buyer = { scheme: b.scheme ?? 'TN', id: (b.id ?? '0').trim() };
  if (!['NIN', 'PN', 'TN'].includes(buyer.scheme) || !/^\d+$/.test(buyer.id)) {
    fail('JOF-PTY-005', `buyer ${buyer.scheme} "${buyer.id}": the ID must be digits with scheme NIN, PN or TN.`);
  }
  for (const k of ['name', 'phone', 'postalZone', 'governorate'] as const) {
    const v = b[k]?.trim();
    if (v) buyer[k] = v;
  }
  if (needsName && !buyer.name) fail('JOF-PTY-007', terms === 'receivable' ? 'A receivable invoice needs the buyer name.' : 'A cash invoice above 10,000 JOD needs the buyer name.');
  if (buyer.governorate && !GOVERNORATES.includes(buyer.governorate)) {
    fail('JOF-PTY-009', `buyer.governorate "${buyer.governorate}" is not one of ${GOVERNORATES.join(', ')}.`);
  }
  return buyer;
}

function read(input: string, what: string): Doc {
  if (typeof input !== 'string' || !input.trim()) fail('JOF-BLD-INPUT', `${what} is empty.`);
  try {
    return parseDocument(input);
  } catch (e) {
    return fail('JOF-BLD-INPUT', `${what}: ${(e as Error).message}`);
  }
}

function clean(l: Omit<DocLine, 'category'> & { category?: TaxCategory }): DocLine {
  for (const k of ['discount', 'extension', 'tax', 'specialTax'] as const) {
    if (l[k] < 0n) fail('JOF-AMT-003', `Line ${l.id}: ${k} would be ${format6(l[k])}.`);
  }
  const { category, ...rest } = l;
  return category ? { ...rest, category } : rest;
}

function fail(code: BuildError['code'], message: string): never {
  throw new BuildError(code, message);
}
