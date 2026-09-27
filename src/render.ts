import type { Buyer, Doc, DocLine } from './document.ts';
import { totalsOf, typeNameOf } from './document.ts';
import type { Micro } from './money.ts';
import { format6 } from './money.ts';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const jo = (tag: string, v: Micro) => `<cbc:${tag} currencyID="JO">${format6(v)}</cbc:${tag}>`;

function category(id: string, percent: number | undefined, scheme: 'VAT' | 'OTH') {
  return `<cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${id}</cbc:ID>${percent === undefined ? '' : `
          <cbc:Percent>${percent}</cbc:Percent>`}
          <cac:TaxScheme>
            <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">${scheme}</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>`;
}

function renderLine(l: DocLine, doc: Doc, salesReturn: boolean) {
  const taxed = doc.track !== 'income';
  const special = doc.track === 'special';
  // Sales returns and special-sales lines carry TaxableAmount (manual p.52-53, p.65-66).
  const taxable = salesReturn || special ? `
        ${jo('TaxableAmount', l.extension)}` : '';
  const taxTotal = taxed ? `
    <cac:TaxTotal>
      ${jo('TaxAmount', l.tax)}
      ${jo('RoundingAmount', l.extension + l.specialTax + l.tax)}${special ? `
      <cac:TaxSubtotal>
        ${jo('TaxableAmount', l.extension)}
        ${jo('TaxAmount', l.specialTax)}
        ${category('S', undefined, 'OTH')}
      </cac:TaxSubtotal>` : ''}
      <cac:TaxSubtotal>${taxable}
        ${jo('TaxAmount', l.tax)}
        ${category(l.category ?? 'S', l.rate, 'VAT')}
      </cac:TaxSubtotal>
    </cac:TaxTotal>` : '';
  return `
  <cac:InvoiceLine>
    <cbc:ID>${l.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${format6(l.quantity)}</cbc:InvoicedQuantity>
    ${jo('LineExtensionAmount', l.extension)}${taxTotal}
    <cac:Item>
      <cbc:Name>${esc(l.name)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      ${jo('PriceAmount', l.unitPrice)}${salesReturn ? `
      <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>` : ''}
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>
        ${jo('Amount', l.discount)}
      </cac:AllowanceCharge>
    </cac:Price>
  </cac:InvoiceLine>`;
}

function renderBuyer(b: Buyer, taxed: boolean) {
  const address = [
    b.postalZone && `<cbc:PostalZone>${esc(b.postalZone)}</cbc:PostalZone>`,
    taxed && b.governorate && `<cbc:CountrySubentityCode>${esc(b.governorate)}</cbc:CountrySubentityCode>`,
  ].filter(Boolean).map((x) => `\n        ${x}`).join('');
  return `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${b.scheme}">${esc(b.id)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>${address}
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>${taxed ? `
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

/** One document-level TaxSubtotal per category and rate (general-sales returns, manual p.49-50). */
function documentSubtotals(lines: DocLine[]) {
  const groups = new Map<string, { category: string; rate: number; taxable: Micro; tax: Micro }>();
  for (const l of lines) {
    const key = `${l.category}:${l.rate}`;
    const g = groups.get(key) ?? { category: l.category ?? 'S', rate: l.rate, taxable: 0n, tax: 0n };
    g.taxable += l.extension;
    g.tax += l.tax;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => `
    <cac:TaxSubtotal>
      ${jo('TaxableAmount', g.taxable)}
      ${jo('TaxAmount', g.tax)}
      ${category(g.category, g.rate, 'VAT')}
    </cac:TaxSubtotal>`).join('');
}

/** Wrap XML in the JoFotara request body: `{"invoice": "<base64>"}`. */
export const toRequestBody = (xml: string) => JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') });

/** Render a document as JoFotara UBL 2.1 XML, amounts with six decimals. */
export function renderDocument(doc: Doc): string {
  const taxed = doc.track !== 'income';
  const credit = doc.kind === 'credit-note';
  const salesReturn = credit && doc.track === 'sales';
  const t = totalsOf(doc.lines);
  const ref = doc.billingReference;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(doc.id)}</cbc:ID>
  <cbc:UUID>${esc(doc.uuid)}</cbc:UUID>
  <cbc:IssueDate>${esc(doc.issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="${typeNameOf(doc)}">${credit ? '381' : '388'}</cbc:InvoiceTypeCode>${doc.note ? `
  <cbc:Note>${esc(doc.note)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>${ref ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(ref.id)}</cbc:ID>
      <cbc:UUID>${esc(ref.uuid)}</cbc:UUID>
      <cbc:DocumentDescription>${format6(ref.total)}</cbc:DocumentDescription>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>` : ''}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${esc(doc.icv)}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(doc.seller.taxNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(doc.seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>${renderBuyer(doc.buyer, taxed)}
  <cac:SellerSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID>${esc(doc.seller.incomeSourceSequence)}</cbc:ID>
      </cac:PartyIdentification>
    </cac:Party>
  </cac:SellerSupplierParty>${credit ? `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${esc(doc.reason ?? '')}</cbc:InstructionNote>
  </cac:PaymentMeans>` : ''}
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    ${jo('Amount', t.allowance)}
  </cac:AllowanceCharge>${taxed ? `
  <cac:TaxTotal>
    ${jo('TaxAmount', t.tax)}${salesReturn ? documentSubtotals(doc.lines) : ''}
  </cac:TaxTotal>` : ''}
  <cac:LegalMonetaryTotal>
    ${jo('TaxExclusiveAmount', t.taxExclusive)}
    ${jo('TaxInclusiveAmount', t.taxInclusive)}
    ${jo('AllowanceTotalAmount', t.allowance)}${salesReturn ? `
    ${jo('PrepaidAmount', 0n)}` : ''}
    ${jo('PayableAmount', t.payable)}
  </cac:LegalMonetaryTotal>${doc.lines.map((l) => renderLine(l, doc, salesReturn)).join('')}
</Invoice>
`;
}
