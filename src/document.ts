import type { Micro } from './money.ts';
import { parseMicro, toNumber } from './money.ts';
import { at, kids, parseXml, text } from './xml.ts';
import type { El } from './xml.ts';

export type Track = 'income' | 'sales' | 'special';
export type PaymentTerms = 'cash' | 'receivable';
export type TaxCategory = 'S' | 'Z' | 'O';

export interface Seller {
  /** Seller tax number (manual p.13). */
  taxNumber: string;
  /** Name as registered with ISTD. */
  name: string;
  /** Income source sequence from the portal (manual p.16). */
  incomeSourceSequence: string;
}

export interface Buyer {
  /** NIN national number, PN personal number (non-Jordanian), TN tax number. */
  scheme: 'NIN' | 'PN' | 'TN';
  /** Digits only. */
  id: string;
  name?: string;
  phone?: string;
  postalZone?: string;
  /** Governorate code such as JO-AM; written on sales documents only. */
  governorate?: string;
}

/** A line with exact amounts in micro-JOD. `quantity` is in millionths of a unit. */
export interface DocLine {
  id: number;
  name: string;
  quantity: Micro;
  /** Unit price before tax. */
  unitPrice: Micro;
  discount: Micro;
  /** quantity × unitPrice − discount. */
  extension: Micro;
  /** VAT category; absent on income documents. */
  category?: TaxCategory;
  rate: number;
  /** VAT amount. */
  tax: Micro;
  /** Special tax amount (special sales only). */
  specialTax: Micro;
}

/** Everything the renderer needs, with exact amounts. */
export interface Doc {
  kind: 'invoice' | 'credit-note';
  track: Track;
  paymentTerms: PaymentTerms;
  id: string;
  uuid: string;
  issueDate: string;
  icv: string;
  note?: string;
  seller: Seller;
  buyer: Buyer;
  lines: DocLine[];
  billingReference?: { id: string; uuid: string; total: Micro };
  reason?: string;
}

export interface Totals<T> {
  /** Σ quantity × unit price. */
  taxExclusive: T;
  /** Σ line discounts. */
  allowance: T;
  /** Σ VAT. */
  tax: T;
  /** Σ special tax. */
  specialTax: T;
  taxInclusive: T;
  payable: T;
}

export function totalsOf(lines: DocLine[]): Totals<Micro> {
  const sum = (f: (l: DocLine) => Micro) => lines.reduce((s, l) => s + f(l), 0n);
  const allowance = sum((l) => l.discount);
  const extension = sum((l) => l.extension);
  const tax = sum((l) => l.tax);
  const specialTax = sum((l) => l.specialTax);
  const taxInclusive = extension + specialTax + tax;
  return { taxExclusive: extension + allowance, allowance, tax, specialTax, taxInclusive, payable: taxInclusive };
}

export const typeNameOf = (d: Pick<Doc, 'track' | 'paymentTerms'>) =>
  `0${d.paymentTerms === 'receivable' ? 2 : 1}${{ income: 1, sales: 2, special: 3 }[d.track]}`;

/** A document line with amounts in JOD, as returned to library users. */
export interface DocumentLine {
  id: number;
  name: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  extension: number;
  category?: TaxCategory;
  rate: number;
  tax: number;
  specialTax: number;
  /** extension + special tax + VAT. */
  total: number;
}

/** A JoFotara document with amounts in JOD. */
export interface JofotaraDocument {
  kind: 'invoice' | 'credit-note';
  track: Track;
  paymentTerms: PaymentTerms;
  typeCode: '388' | '381';
  typeName: string;
  id: string;
  uuid: string;
  issueDate: string;
  icv: string;
  note?: string;
  seller: Seller;
  buyer: Buyer;
  lines: DocumentLine[];
  totals: Totals<number>;
  billingReference?: { id: string; uuid: string; total: number };
  reason?: string;
}

export function toPublic(d: Doc): JofotaraDocument {
  const t = totalsOf(d.lines);
  return {
    kind: d.kind,
    track: d.track,
    paymentTerms: d.paymentTerms,
    typeCode: d.kind === 'invoice' ? '388' : '381',
    typeName: typeNameOf(d),
    id: d.id,
    uuid: d.uuid,
    issueDate: d.issueDate,
    icv: d.icv,
    ...(d.note ? { note: d.note } : {}),
    seller: d.seller,
    buyer: d.buyer,
    lines: d.lines.map((l) => ({
      id: l.id,
      name: l.name,
      quantity: toNumber(l.quantity),
      unitPrice: toNumber(l.unitPrice),
      discount: toNumber(l.discount),
      extension: toNumber(l.extension),
      ...(l.category ? { category: l.category } : {}),
      rate: l.rate,
      tax: toNumber(l.tax),
      specialTax: toNumber(l.specialTax),
      total: toNumber(l.extension + l.specialTax + l.tax),
    })),
    totals: {
      taxExclusive: toNumber(t.taxExclusive),
      allowance: toNumber(t.allowance),
      tax: toNumber(t.tax),
      specialTax: toNumber(t.specialTax),
      taxInclusive: toNumber(t.taxInclusive),
      payable: toNumber(t.payable),
    },
    ...(d.billingReference ? { billingReference: { ...d.billingReference, total: toNumber(d.billingReference.total) } } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
  };
}

/** Thrown when a document cannot be read. */
export class DocumentReadError extends Error {
  override name = 'DocumentReadError';
}

const TRACK_DIGIT: Record<string, Track> = { 1: 'income', 2: 'sales', 3: 'special' };

/** Decode XML, a `{"invoice": base64}` request body, or bare base64 into XML text. */
export function toXml(input: string): string {
  const s = input.replace(/^\uFEFF/, '').trim();
  if (s.startsWith('<')) return s;
  let b64 = s;
  if (s.startsWith('{')) {
    try {
      b64 = String((JSON.parse(s) as { invoice?: unknown }).invoice ?? '');
    } catch {
      throw new DocumentReadError('Input starts with "{" but is not valid JSON.');
    }
  }
  const xml = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!xml.startsWith('<')) throw new DocumentReadError('Input is neither XML, a {"invoice": base64} body, nor base64 of XML.');
  return xml;
}

/**
 * Read a JoFotara document (XML, request body or base64) into exact amounts. Reads what the
 * builder needs to return lines of it; it does not validate — use `validate()` for that.
 */
export function parseDocument(input: string): Doc {
  const { root, error } = parseXml(toXml(input));
  if (!root) throw new DocumentReadError(`XML is not well-formed: ${error}`);
  const typeEl = at(root, 'cbc:InvoiceTypeCode');
  const code = text(typeEl);
  const name = /^0([12])([123])$/.exec(typeEl?.getAttribute('name') ?? '');
  if (!name || (code !== '388' && code !== '381')) {
    throw new DocumentReadError(`Unsupported document type ${code || '(none)'} name="${typeEl?.getAttribute('name') ?? ''}".`);
  }
  const track = TRACK_DIGIT[name[2]];
  const amount = (el: El | undefined, what: string): Micro => {
    if (!el) return 0n;
    const v = parseMicro(text(el));
    if (v === undefined) throw new DocumentReadError(`${what} "${text(el)}" is not a number.`);
    return v;
  };
  const required = (path: string, from: El = root) => {
    const v = text(at(from, path));
    if (!v) throw new DocumentReadError(`Missing ${path}.`);
    return v;
  };

  const customer = at(root, 'cac:AccountingCustomerParty');
  const party = at(customer, 'cac:Party');
  const buyerId = at(party, 'cac:PartyIdentification/cbc:ID');
  const optional = (el: El | undefined) => text(el) || undefined;
  const buyer: Buyer = {
    scheme: (buyerId?.getAttribute('schemeID') ?? 'TN') as Buyer['scheme'],
    id: text(buyerId),
    ...strip({
      name: optional(at(party, 'cac:PartyLegalEntity/cbc:RegistrationName')),
      phone: optional(at(customer, 'cac:AccountingContact/cbc:Telephone')),
      postalZone: optional(at(party, 'cac:PostalAddress/cbc:PostalZone')),
      governorate: optional(at(party, 'cac:PostalAddress/cbc:CountrySubentityCode')),
    }),
  };

  const lines: DocLine[] = kids(root, 'cac:InvoiceLine').map((line, i) => {
    const where = `InvoiceLine ${i + 1}`;
    const subtotals = kids(at(line, 'cac:TaxTotal'), 'cac:TaxSubtotal');
    const scheme = (st: El) => text(at(st, 'cac:TaxCategory/cac:TaxScheme/cbc:ID'));
    const vat = subtotals.find((st) => scheme(st) === 'VAT') ?? (track === 'sales' ? subtotals[0] : undefined);
    const oth = subtotals.find((st) => scheme(st) === 'OTH');
    const quantity = amount(at(line, 'cbc:InvoicedQuantity'), `${where} quantity`);
    const category = text(at(vat, 'cac:TaxCategory/cbc:ID'));
    return {
      id: Number(required('cbc:ID', line)),
      name: text(at(line, 'cac:Item/cbc:Name')),
      quantity,
      unitPrice: amount(at(line, 'cac:Price/cbc:PriceAmount'), `${where} price`),
      discount: amount(at(line, 'cac:Price/cac:AllowanceCharge/cbc:Amount'), `${where} discount`),
      extension: amount(at(line, 'cbc:LineExtensionAmount'), `${where} amount`),
      ...(track !== 'income' && category ? { category: category as TaxCategory } : {}),
      rate: track === 'income' ? 0 : Number(text(at(vat, 'cac:TaxCategory/cbc:Percent')) || 0),
      tax: track === 'income' ? 0n : amount(at(line, 'cac:TaxTotal/cbc:TaxAmount'), `${where} tax`),
      specialTax: oth ? amount(at(oth, 'cbc:TaxAmount'), `${where} special tax`) : 0n,
    };
  });

  const ref = at(root, 'cac:BillingReference/cac:InvoiceDocumentReference');
  const icv = kids(root, 'cac:AdditionalDocumentReference').find((a) => text(at(a, 'cbc:ID')) === 'ICV');
  return {
    kind: code === '388' ? 'invoice' : 'credit-note',
    track,
    paymentTerms: name[1] === '1' ? 'cash' : 'receivable',
    id: required('cbc:ID'),
    uuid: required('cbc:UUID'),
    issueDate: required('cbc:IssueDate'),
    icv: text(at(icv, 'cbc:UUID')),
    ...strip({ note: optional(at(root, 'cbc:Note')), reason: optional(at(root, 'cac:PaymentMeans/cbc:InstructionNote')) }),
    seller: {
      taxNumber: text(at(root, 'cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID')),
      name: text(at(root, 'cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName')),
      incomeSourceSequence: text(at(root, 'cac:SellerSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID')),
    },
    buyer,
    lines,
    ...(ref
      ? { billingReference: { id: text(at(ref, 'cbc:ID')), uuid: text(at(ref, 'cbc:UUID')), total: amount(at(ref, 'cbc:DocumentDescription'), 'Original total') } }
      : {}),
  };
}

/** Read a JoFotara document (XML, request body or base64) with amounts in JOD. */
export const readDocument = (input: string): JofotaraDocument => toPublic(parseDocument(input));

function strip<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
