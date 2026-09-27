import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BuildError, buildCreditNote, buildInvoice } from './build.ts';
import { RULE_MAP, RULES } from './rules.ts';
import type { RuleId } from './rules.ts';
import { TEMPLATES, toRequestBody } from './templates.ts';
import type { TemplateName } from './templates.ts';
import { validate } from './validate.ts';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const discount = z.union([z.object({ amount: z.number().min(0) }), z.object({ percent: z.number().min(0).max(100) })]);
const header = {
  id: z.string().describe('Your invoice or return number'),
  uuid: z.string().optional().describe('Defaults to a new random UUID; reuse it on retries'),
  icv: z.union([z.number().int().positive(), z.string()]).describe('Your invoice counter (1, 2, 3, …)'),
  issueDate: z.string().optional().describe('yyyy-mm-dd; defaults to today in Asia/Amman'),
  note: z.string().optional(),
};
const invoiceInput = {
  ...header,
  track: z.enum(['income', 'sales', 'special']).optional().describe('income 011/021, sales 012/022 (default), special 013/023 (not verified live)'),
  paymentTerms: z.enum(['cash', 'receivable']).optional(),
  seller: z.object({ taxNumber: z.string(), name: z.string(), incomeSourceSequence: z.string() }),
  buyer: z.object({
    scheme: z.enum(['NIN', 'PN', 'TN']).optional(),
    id: z.string().optional().describe('Digits only'),
    name: z.string().optional(),
    phone: z.string().optional(),
    postalZone: z.string().optional(),
    governorate: z.string().optional().describe('e.g. JO-AM; sales documents only'),
  }).optional().describe('Defaults to a walk-in buyer; required for receivables and cash sales above 10,000 JOD'),
  pricesIncludeTax: z.boolean().optional(),
  lines: z.array(z.object({
    name: z.string(),
    quantity: z.number().positive(),
    unitPrice: z.number().min(0),
    discount: discount.optional(),
    taxRate: z.number().optional().describe('VAT percent: 1, 2, 3, 4, 5, 7, 8, 10, 16, or 0 with taxCategory'),
    taxCategory: z.enum(['S', 'Z', 'O']).optional().describe('Z exempt, O zero-rated; required with taxRate 0'),
    specialTax: z.number().min(0).optional().describe('Special sales only'),
  })).min(1),
  orderDiscount: discount.optional().describe('Spread over the lines in proportion'),
};
const creditNoteInput = {
  ...header,
  original: z.string().describe('The original invoice: XML, {"invoice": base64} body, or base64'),
  previousReturns: z.array(z.string()).optional().describe('Earlier returns against the same invoice'),
  lines: z.union([z.literal('all'), z.array(z.object({ lineId: z.union([z.number(), z.string()]), quantity: z.number().positive() }))])
    .describe('Lines to return by original line number, or "all" for everything not yet returned'),
  reason: z.string(),
};
const built = (f: () => { xml: string; document: unknown; warnings: string[] }) => {
  try {
    const { xml, document, warnings } = f();
    return text({ xml, document, warnings });
  } catch (e) {
    if (e instanceof BuildError) return { ...text(e.message), isError: true };
    throw e;
  }
};

/** MCP server exposing the validator, templates and rule catalog to AI agents. */
export function createMcpServer(version: string): McpServer {
  const server = new McpServer({ name: 'jofotara-kit', version });

  server.registerTool('validate_invoice', {
    title: 'Validate JoFotara invoice',
    description:
      'Validate a JoFotara (Jordan ISTD e-invoicing) document before sending it. Accepts raw UBL 2.1 XML, the ' +
      '{"invoice": "<base64>"} request body, or bare base64. Returns ok/errors/warnings and every finding with rule id, ' +
      'path, source (ISTD manual page) and the exact fix. Run it on every XML you generate.',
    inputSchema: { input: z.string().describe('XML, JSON request body, or base64') },
  }, async ({ input }) => text(validate(input)));

  server.registerTool('get_template', {
    title: 'Get JoFotara sample document',
    description:
      'Return a sample document in the shape documented by the ISTD manual. Copy its element order, ' +
      'attributes and formatting; only values change. sales = 388/012 with VAT, income = 388/011 without TaxTotal; credit notes are partial returns.',
    inputSchema: {
      name: z.enum(Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]]),
      format: z.enum(['xml', 'request-body']).default('xml'),
    },
  }, async ({ name, format }) => {
    const xml = TEMPLATES[name]();
    return text(format === 'xml' ? xml : toRequestBody(xml));
  });

  server.registerTool('build_invoice', {
    title: 'Build a JoFotara invoice',
    description:
      'Build a valid JoFotara invoice (388) from plain sale data instead of writing XML by hand. Handles tax-inclusive ' +
      'prices, line and order discounts, exempt (Z) and zero-rated (O) lines, and buyer rules. Returns the XML and the ' +
      'document with computed amounts. Errors carry the rule id they would break.',
    inputSchema: invoiceInput,
  }, async (input) => built(() => buildInvoice(input)));

  server.registerTool('build_credit_note', {
    title: 'Build a JoFotara return',
    description:
      'Build a valid return (381) from the stored original invoice XML. Mirrors the original line numbers, prices, ' +
      'categories, buyer and type name, respects quantities already returned (pass previousReturns), and makes the ' +
      'last return of a line add up to the invoice exactly.',
    inputSchema: creditNoteInput,
  }, async (input) => built(() => buildCreditNote(input)));

  server.registerTool('list_rules', {
    title: 'List JoFotara validation rules',
    description: 'List every rule the validator checks: id, severity, confidence, title and fix.',
    inputSchema: {},
  }, async () => text(RULES));

  server.registerTool('explain_rule', {
    title: 'Explain a JoFotara rule',
    description: 'Explain one rule id (e.g. JOF-AMT-001) from a validation finding: what it checks, how sure we are, how to fix it.',
    inputSchema: { id: z.string().describe('Rule id such as JOF-RET-002') },
  }, async ({ id }) => {
    const rule = RULE_MAP[id.trim().toUpperCase() as RuleId];
    return rule ? text(rule) : { ...text(`Unknown rule "${id}". Call list_rules for valid ids.`), isError: true };
  });

  return server;
}

export async function serveMcpStdio(version: string) {
  await createMcpServer(version).connect(new StdioServerTransport());
}
