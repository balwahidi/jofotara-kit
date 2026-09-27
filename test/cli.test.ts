import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/validate.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (args: string[], input?: string) => {
  const r = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const dir = mkdtempSync(join(tmpdir(), 'jofotara-kit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const seller = { taxNumber: '11223344', name: 'Example Trading LLC', incomeSourceSequence: '7654321' };
const invoice = { id: 'INV-1', icv: 1, issueDate: '2026-09-27', seller, lines: [{ name: 'Widget', quantity: 3, unitPrice: 10, taxRate: 16 }] };

describe('cli build', () => {
  it('builds an invoice from a JSON file, and a return that names the original by path', () => {
    writeFileSync(join(dir, 'invoice.json'), JSON.stringify(invoice));
    const inv = run(['build', join(dir, 'invoice.json')]);
    assert.equal(inv.status, 0, inv.stderr);
    assert.equal(validate(inv.stdout).ok, true);
    writeFileSync(join(dir, 'INV-1.xml'), inv.stdout);

    writeFileSync(join(dir, 'return.json'), JSON.stringify({ type: 'credit-note', original: 'INV-1.xml', lines: [{ lineId: 1, quantity: 1 }], reason: 'Return', id: 'RET-1', icv: 2, issueDate: '2026-09-27' }));
    const ret = run(['build', join(dir, 'return.json'), '--json']);
    assert.equal(ret.status, 0, ret.stderr);
    const { xml, body, document } = JSON.parse(ret.stdout);
    assert.equal(validate(xml).ok, true);
    assert.ok(JSON.parse(body).invoice);
    assert.equal(document.billingReference.id, 'INV-1');
  });

  it('reads JSON from stdin and prints the request body', () => {
    const r = run(['build', '--body'], JSON.stringify(invoice));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(validate(r.stdout.trim()).ok, true);
  });

  it('exits 1 with the rule id on input that cannot build, and 2 on unreadable JSON', () => {
    const bad = run(['build'], JSON.stringify({ ...invoice, lines: [{ name: 'Widget', quantity: 1, unitPrice: 1, taxRate: 6 }] }));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /JOF-LIN-009/);
    assert.equal(run(['build'], '{not json').status, 2);
  });
});
