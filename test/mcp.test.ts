import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';
import { sampleInvoice } from '../src/templates.ts';

const client = new Client({ name: 'test', version: '0.0.0' });
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: res.isError };
};

describe('mcp server', () => {
  before(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer('0.0.0').connect(serverSide);
    await client.connect(clientSide);
  });
  after(() => client.close());

  it('lists the six tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['build_credit_note', 'build_invoice', 'explain_rule', 'get_template', 'list_rules', 'validate_invoice']);
  });

  it('build_invoice and build_credit_note build valid documents, and report rule ids on bad input', async () => {
    const seller = { taxNumber: '11223344', name: 'Example Trading LLC', incomeSourceSequence: '7654321' };
    const lines = [{ name: 'Widget', quantity: 2, unitPrice: 10, taxRate: 16 }];
    const invoice = JSON.parse((await call('build_invoice', { id: 'INV-1', icv: 1, issueDate: '2026-09-27', seller, lines })).text);
    assert.equal(invoice.document.totals.payable, 23.2);
    const ret = JSON.parse((await call('build_credit_note', { original: invoice.xml, lines: 'all', reason: 'Return', id: 'RET-1', icv: 2, issueDate: '2026-09-27' })).text);
    assert.equal(ret.document.typeCode, '381');
    for (const xml of [invoice.xml, ret.xml]) assert.equal(JSON.parse((await call('validate_invoice', { input: xml })).text).ok, true);
    const bad = await call('build_invoice', { id: 'INV-2', icv: 3, seller, lines: [{ ...lines[0], taxRate: 6 }] });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /^JOF-LIN-009:/);
  });

  it('validate_invoice returns the report', async () => {
    const ok = JSON.parse((await call('validate_invoice', { input: sampleInvoice() })).text);
    assert.equal(ok.ok, true);
    const bad = JSON.parse((await call('validate_invoice', { input: sampleInvoice().replaceAll('currencyID="JO"', 'currencyID="JOD"') })).text);
    assert.deepEqual(bad.findings.map((f: { rule: string }) => f.rule), ['JOF-AMT-002']);
  });

  it('get_template returns XML or a request body', async () => {
    assert.match((await call('get_template', { name: 'income-invoice' })).text, /name="011">388</);
    assert.ok(JSON.parse((await call('get_template', { name: 'invoice', format: 'request-body' })).text).invoice);
  });

  it('explain_rule explains known ids and errors on unknown ones', async () => {
    assert.equal(JSON.parse((await call('explain_rule', { id: 'jof-amt-001' })).text).id, 'JOF-AMT-001');
    assert.equal((await call('explain_rule', { id: 'NOPE' })).isError, true);
  });
});
