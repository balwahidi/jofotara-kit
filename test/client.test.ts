import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildCreditNote, buildInvoice } from '../src/build.ts';
import { classifyResponse, createClient } from '../src/client.ts';
import type { SubmitOutcome } from '../src/client.ts';
import { createMockServer } from '../src/mock.ts';

const seller = { taxNumber: '11223344', name: 'Example Trading LLC', incomeSourceSequence: '7654321' };
const invoice = (id = 'INV-1') => buildInvoice({ id, icv: 1, issueDate: '2026-09-27', seller, lines: [{ name: 'Widget', quantity: 3, unitPrice: 10, taxRate: 16 }] });
const SECRET = 'secret-key-never-printed';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const servers: Server[] = [];
async function fake(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  return listen(server);
}
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

describe('classifyResponse', () => {
  const accepted = { EINV_RESULTS: { status: 'PASS', INFO: [], WARNINGS: [], ERRORS: [] }, EINV_STATUS: 'SUBMITTED', EINV_QR: 'QR-TEXT', EINV_INV_UUID: '0f8fad5b-d9cb-469f-a165-70867728950e' };
  const rejected = { EINV_RESULTS: { status: 'ERROR', ERRORS: [{ EINV_CODE: 'X-1', EINV_CATEGORY: 'X', EINV_MESSAGE: 'Bad total' }] }, EINV_STATUS: 'NOT_SUBMITTED' };
  const classify = (status: number, body: unknown) => classifyResponse(status, typeof body === 'string' ? body : JSON.stringify(body));

  it('accepts only HTTP success + an explicit success status + a QR', () => {
    const r = classify(200, accepted);
    assert.equal(r.status, 'accepted');
    assert.equal(r.status === 'accepted' && r.qr, 'QR-TEXT');
    assert.equal(r.status === 'accepted' && r.governmentUuid, '0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('reads keys in any case and finds a nested QR', () => {
    const r = classify(200, { einv_results: { Status: 'pass' }, einv_status: 'Submitted', data: { einv_qr: 'Q' } });
    assert.equal(r.status, 'accepted');
  });

  it('treats explicit rejection as rejected, even with HTTP 200', () => {
    for (const status of [400, 200]) {
      const r = classify(status, rejected);
      assert.equal(r.status, 'rejected', `HTTP ${status}`);
      assert.deepEqual(r.status === 'rejected' && r.errors, [{ code: 'X-1', message: 'Bad total', category: 'X' }]);
    }
  });

  it('treats anything inconclusive as unknown', () => {
    const cases: [number, unknown, string][] = [
      [200, { ...accepted, EINV_QR: '' }, 'unconfirmed'],
      [200, { ...accepted, EINV_RESULTS: { ...accepted.EINV_RESULTS, ERRORS: [{ EINV_CODE: 'X' }] } }, 'unconfirmed'],
      [500, { EINV_STATUS: 'SUBMITTED', EINV_QR: 'Q' }, 'unconfirmed'],
      [503, {}, 'unconfirmed'],
      [200, {}, 'unconfirmed'],
      [502, '<html>Bad Gateway</html>', 'unreadable'],
      [200, '"just a string"', 'unreadable'],
    ];
    for (const [status, body, reason] of cases) {
      const r = classify(status, body);
      assert.equal(r.status, 'unknown', JSON.stringify(body));
      assert.equal(r.status === 'unknown' && r.reason, reason, JSON.stringify(body));
    }
  });
});

describe('createClient().submit', () => {
  let mock = '';
  let strictMock = '';
  let http200Mock = '';
  before(async () => {
    for (const s of [createMockServer(), createMockServer({ clientId: 'id', secretKey: SECRET }), createMockServer({ rejectStatus: 200 })]) servers.push(s);
    [mock, strictMock, http200Mock] = await Promise.all(servers.slice(0, 3).map(listen));
  });
  const client = (baseUrl: string, o: Partial<Parameters<typeof createClient>[0]> = {}) =>
    createClient({ baseUrl, clientId: 'id', secretKey: SECRET, ...o });
  const noSecret = (o: SubmitOutcome) => assert.ok(!JSON.stringify(o).includes(SECRET), 'the secret key must never appear in an outcome');

  it('accepts a valid invoice, then its return', async () => {
    const inv = invoice();
    const r = await client(mock).submit(inv);
    assert.equal(r.status, 'accepted');
    assert.ok(r.status === 'accepted' && r.qr);
    assert.deepEqual(r.document, { id: 'INV-1', uuid: inv.document.uuid });
    const ret = buildCreditNote({ original: inv.xml, lines: 'all', reason: 'Return', id: 'RET-1', icv: 2, issueDate: '2026-09-27' });
    assert.equal((await client(mock).submit(ret.body)).status, 'accepted');
    noSecret(r);
  });

  it('reports rejections with their codes, including HTTP 200 rejections', async () => {
    const wrongKey = await client(strictMock, { secretKey: 'wrong' }).submit(invoice('INV-2'));
    assert.equal(wrongKey.status, 'rejected');
    assert.deepEqual(wrongKey.status === 'rejected' && wrongKey.errors.map((e) => e.code), ['JOF-AUTH-002']);
    const broken = invoice('INV-3').xml.replace('name="012"', 'name="099"');
    const r = await client(http200Mock, { validateBeforeSending: false }).submit(broken);
    assert.equal(r.status, 'rejected');
    assert.equal(r.status === 'rejected' && r.httpStatus, 200);
    noSecret(wrongKey);
  });

  it('does not send a document that fails validation', async () => {
    await fetch(`${mock}/_kit/invoices`, { method: 'DELETE' });
    const r = await client(mock).submit(invoice('INV-4').xml.replace('name="012"', 'name="099"'));
    assert.equal(r.status, 'not-sent');
    assert.equal(r.status === 'not-sent' && r.reason, 'invalid');
    assert.ok(r.status === 'not-sent' && r.findings?.some((f) => f.rule === 'JOF-HDR-005'));
    assert.deepEqual(await (await fetch(`${mock}/_kit/invoices`)).json(), []);
    assert.equal((await client(mock).submit('not a document')).status, 'not-sent');
  });

  it('calls a timeout, a dropped connection and an HTML page unknown', async () => {
    const hang = await fake(() => {});
    const drop = await fake((req) => req.on('data', () => {}).on('end', () => req.socket.destroy()));
    const html = await fake((_, res) => res.writeHead(502, { 'content-type': 'text/html' }).end('<html>Bad Gateway</html>'));
    const cases: [string, string][] = [[hang, 'timeout'], [drop, 'network'], [html, 'unreadable']];
    for (const [url, reason] of cases) {
      const r = await client(url, { timeoutMs: 300 }).submit(invoice());
      assert.equal(r.status, 'unknown', reason);
      assert.equal(r.status === 'unknown' && r.reason, reason);
      noSecret(r);
    }
  });

  it('calls an unreachable server not-sent, because nothing was delivered', async () => {
    const s = createServer();
    const url = await listen(s);
    await new Promise<void>((resolve) => s.close(() => resolve()));
    const r = await client(url).submit(invoice());
    assert.equal(r.status, 'not-sent');
    assert.equal(r.status === 'not-sent' && r.reason, 'unreachable');
  });

  it('requires a base URL and credentials', () => {
    assert.throws(() => createClient({ baseUrl: '', clientId: 'a', secretKey: 'b' }), /baseUrl is required/);
    assert.throws(() => createClient({ baseUrl: mock, clientId: '', secretKey: 'b' }), /clientId and secretKey/);
  });
});

describe('cli send', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'jofotara-send-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // No real credentials can leak into the child process.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JOFOTARA_')));
  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, 'send', ...args], { env: { ...env, ...extraEnv } });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code: number; stdout: string; stderr: string };
      return { code: err.code, stdout: err.stdout, stderr: err.stderr };
    }
  };
  let mock = '';
  before(async () => {
    const s = createMockServer();
    servers.push(s);
    mock = await listen(s);
  });

  it('sends documents in order and prints each outcome', async () => {
    const inv = invoice('INV-10');
    const ret = buildCreditNote({ original: inv.xml, lines: 'all', reason: 'Return', id: 'RET-10', icv: 2, issueDate: '2026-09-27' });
    writeFileSync(join(dir, 'inv.xml'), inv.xml);
    writeFileSync(join(dir, 'ret.json'), ret.body);
    const r = await run([join(dir, 'inv.xml'), join(dir, 'ret.json'), '--base-url', mock]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.match(/ACCEPTED/g)?.length, 2);
    assert.match(r.stdout, /QR: /);
  });

  it('stops at the first document that is not accepted', async () => {
    writeFileSync(join(dir, 'dup.xml'), invoice('INV-11').xml);
    const first = await run([join(dir, 'dup.xml'), '--base-url', mock]);
    assert.equal(first.code, 0, first.stderr);
    const r = await run([join(dir, 'dup.xml'), join(dir, 'inv.xml'), '--base-url', mock, '--json']);
    assert.equal(r.code, 1);
    const outcomes = JSON.parse(r.stdout);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome.status, 'rejected');
  });

  it('exits 3 when the outcome is unknown', async () => {
    const hang = await fake(() => {});
    const r = await run([join(dir, 'inv.xml'), '--base-url', hang, '--timeout', '300']);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /UNKNOWN/);
  });

  it('refuses production without credentials in the environment, before sending anything', async () => {
    const r = await run([join(dir, 'inv.xml'), '--production']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /JOFOTARA_CLIENT_ID and JOFOTARA_SECRET_KEY/);
    assert.equal((await run([join(dir, 'inv.xml'), '--production', '--base-url', mock])).code, 2);
  });
});
