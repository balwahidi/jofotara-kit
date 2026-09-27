import { randomUUID } from 'node:crypto';

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

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const d3 = (n: number) => r3(n).toFixed(3);
const jo = (tag: string, n: number) => `<cbc:${tag} currencyID="JO">${d3(n)}</cbc:${tag}>`;
const pct = (n: number) => String(r3(n));

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

type Line = ReturnType<typeof computeLines>[number];

function renderLine(l: Line, sales: boolean, salesReturn: boolean) {
  const taxTotal = sales ? `
    <cac:TaxTotal>
      ${jo('TaxAmount', l.tax)}
      ${jo('RoundingAmount', l.net)}
      <cac:TaxSubtotal>${salesReturn ? `
        ${jo('TaxableAmount', l.ext)}` : ''}
        ${jo('TaxAmount', l.tax)}
        <cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${l.category}</cbc:ID>
          <cbc:Percent>${pct(l.rate)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>` : '';
  return `
  <cac:InvoiceLine>
    <cbc:ID>${l.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${d3(l.qty)}</cbc:InvoicedQuantity>
    ${jo('LineExtensionAmount', l.ext)}${taxTotal}
    <cac:Item>
      <cbc:Name>${esc(l.name)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      ${jo('PriceAmount', l.price)}${salesReturn ? `
      <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>` : ''}
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>
        ${jo('Amount', l.discount)}
      </cac:AllowanceCharge>
    </cac:Price>
  </cac:InvoiceLine>`;
}

function renderBuyer(b: SampleBuyer, sales: boolean) {
  const address = [
    b.postalZone && `<cbc:PostalZone>${esc(b.postalZone)}</cbc:PostalZone>`,
    sales && b.city && `<cbc:CountrySubentityCode>${esc(b.city)}</cbc:CountrySubentityCode>`,
  ].filter(Boolean).map((x) => `\n        ${x}`).join('');
  return `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${b.scheme ?? 'TN'}">${esc(b.id)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>${address}
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>${sales ? `
        <cbc:CompanyID>${esc(b.id)}</cbc:CompanyID>` : ''}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>${b.name ? `
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(b.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>` : ''}
    </cac:Party>${b.phone ? `
    <cac:AccountingContact>
      <cbc:Telephone>${esc(b.phone)}</cbc:Telephone>
    </cac:AccountingContact>` : ''}
  </cac:AccountingCustomerParty>`;
}

function build(o: SampleOptions, credit?: { original: OriginalInvoice; reason: string }): string {
  const track = o.track ?? 'sales';
  const sales = track === 'sales';
  const salesReturn = sales && !!credit;
  const seller = o.seller ?? DEFAULT_SELLER;
  const lines = computeLines(o.lines ?? DEFAULT_LINES, track);
  const total = (k: 'gross' | 'discount' | 'tax' | 'net') => r3(lines.reduce((s, l) => s + l[k], 0));
  const gross = total('gross'), discount = total('discount'), tax = total('tax'), payable = total('net');
  const typeName = `0${o.paymentTerms === 'receivable' ? 2 : 1}${sales ? 2 : 1}`;

  const groups = new Map<string, { category: string; rate: number; taxable: number; tax: number }>();
  for (const l of lines) {
    const g = groups.get(`${l.category}:${l.rate}`) ?? { category: l.category, rate: l.rate, taxable: 0, tax: 0 };
    g.taxable = r3(g.taxable + l.ext);
    g.tax = r3(g.tax + l.tax);
    groups.set(`${l.category}:${l.rate}`, g);
  }
  const docSubtotals = salesReturn ? [...groups.values()].map((g) => `
    <cac:TaxSubtotal>
      ${jo('TaxableAmount', g.taxable)}
      ${jo('TaxAmount', g.tax)}
      <cac:TaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${g.category}</cbc:ID>
        <cbc:Percent>${pct(g.rate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join('') : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(o.id ?? (credit ? `R1-${credit.original.id}` : 'INV-001'))}</cbc:ID>
  <cbc:UUID>${esc(o.uuid ?? randomUUID())}</cbc:UUID>
  <cbc:IssueDate>${esc(o.issueDate ?? new Date().toISOString().slice(0, 10))}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="${typeName}">${credit ? '381' : '388'}</cbc:InvoiceTypeCode>
  <cbc:Note>${esc(o.note ?? '')}</cbc:Note>
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>${credit ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(credit.original.id)}</cbc:ID>
      <cbc:UUID>${esc(credit.original.uuid)}</cbc:UUID>
      <cbc:DocumentDescription>${d3(credit.original.payable)}</cbc:DocumentDescription>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>` : ''}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${o.icv ?? (credit ? 2 : 1)}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(seller.taxNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>${renderBuyer(o.customer ?? WALK_IN, sales)}
  <cac:SellerSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID>${esc(seller.tsp)}</cbc:ID>
      </cac:PartyIdentification>
    </cac:Party>
  </cac:SellerSupplierParty>${credit ? `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${esc(credit.reason)}</cbc:InstructionNote>
  </cac:PaymentMeans>` : ''}
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    ${jo('Amount', discount)}
  </cac:AllowanceCharge>${sales ? `
  <cac:TaxTotal>
    ${jo('TaxAmount', tax)}${docSubtotals}
  </cac:TaxTotal>` : ''}
  <cac:LegalMonetaryTotal>
    ${jo('TaxExclusiveAmount', gross)}
    ${jo('TaxInclusiveAmount', payable)}
    ${jo('AllowanceTotalAmount', discount)}${salesReturn ? `
    <cbc:PrepaidAmount currencyID="JO">0</cbc:PrepaidAmount>` : ''}
    ${jo('PayableAmount', payable)}
  </cac:LegalMonetaryTotal>${lines.map((l) => renderLine(l, sales, salesReturn)).join('')}
</Invoice>
`;
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

/** Wrap XML in the JoFotara request body: `{"invoice": "<base64>"}`. */
export const toRequestBody = (xml: string) => JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') });
