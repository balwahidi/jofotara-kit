#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { BuildError, buildDocument } from './build.ts';
import type { BuildRequest } from './build.ts';
import { serveMcpStdio } from './mcp.ts';
import { createMockServer } from './mock.ts';
import { RULES } from './rules.ts';
import { TEMPLATES, toRequestBody } from './templates.ts';
import type { TemplateName } from './templates.ts';
import { validate } from './validate.ts';
import type { Report } from './validate.ts';

const HELP = `jofotara-kit — local tooling for JoFotara (Jordan ISTD e-invoicing) integrations

Usage:
  jofotara-kit build [input.json] [--body | --json]
                                               Build a valid invoice or return from JSON (stdin if no file). Prints XML,
                                               the request body, or {xml, body, document}. Returns may name the original
                                               and previous returns as file paths, relative to the JSON file.
  jofotara-kit validate [files...] [--json]    Validate XML, a {"invoice": base64} body, or base64 (stdin if no files)
  jofotara-kit serve [--port 8080] [--host 127.0.0.1] [--client-id ID] [--secret-key KEY] [--reject-status 400]
                                               Run a local mock of POST /core/invoices/
  jofotara-kit template <name> [--body]        Print a sample in the manual's shape (or its JSON request body)
                                               ${Object.keys(TEMPLATES).join(', ')}
  jofotara-kit rules [--json]                  List every rule with severity and source (manual page)
  jofotara-kit mcp                             MCP server over stdio (validate_invoice, get_template, list_rules, explain_rule)

Exit codes: 0 ok, 1 validation or build errors, 2 usage error.
Not affiliated with the Income and Sales Tax Department (ISTD).`;

const color = (fmt: Parameters<typeof styleText>[0], s: string) => styleText(fmt, s);

function printReport(name: string, r: Report) {
  const kind = r.invoice ? `${r.invoice.kind} ${r.invoice.typeCode}/${r.invoice.typeName}` : 'unparsed';
  const head = r.ok ? color('green', 'PASS') : color('red', 'FAIL');
  console.log(`${head}  ${name}  (${kind}, ${r.errors} errors, ${r.warnings} warnings)`);
  for (const f of r.findings) {
    const sev = f.severity === 'error' ? color('red', 'error  ') : color('yellow', 'warning');
    console.log(`  ${sev} ${color('bold', f.rule)} ${f.message} ${color('dim', `[${f.source ? `manual ${f.source}` : f.confidence}]`)}`);
    if (f.path) console.log(color('dim', `          at ${f.path}`));
    console.log(color('dim', `          fix: ${f.fix}`));
  }
}

/** A return's `original` and `previousReturns` may be inline documents or paths relative to the JSON file. */
function withDocumentFiles(request: BuildRequest, baseDir: string): BuildRequest {
  if (request?.type !== 'credit-note') return request;
  const load = (value: unknown) => {
    if (typeof value !== 'string') return value as string;
    const s = value.trim();
    return s.startsWith('<') || s.startsWith('{') ? value : readFileSync(resolve(baseDir, s), 'utf8');
  };
  return {
    ...request,
    original: load(request.original),
    ...(Array.isArray(request.previousReturns) ? { previousReturns: request.previousReturns.map(load) } : {}),
  };
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'validate': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
      if (!positionals.length && process.stdin.isTTY) {
        console.error('validate: pass one or more files, or pipe input on stdin.');
        return 2;
      }
      const inputs = positionals.length
        ? positionals.map((file) => ({ file, content: readFileSync(file, 'utf8') }))
        : [{ file: '<stdin>', content: await readStdin() }];
      const results = inputs.map(({ file, content }) => ({ file, ...validate(content) }));
      if (values.json) console.log(JSON.stringify(results, null, 2));
      else results.forEach((r) => printReport(r.file, r));
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case 'build': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { body: { type: 'boolean' }, json: { type: 'boolean' } } });
      const file = positionals[0];
      if (!file && process.stdin.isTTY) {
        console.error('build: pass an input JSON file, or pipe JSON on stdin.');
        return 2;
      }
      const fromFile = file !== undefined && file !== '-';
      let request: BuildRequest;
      try {
        request = JSON.parse(fromFile ? readFileSync(file, 'utf8') : await readStdin());
      } catch (e) {
        console.error(`build: input is not valid JSON (${(e as Error).message}).`);
        return 2;
      }
      try {
        const result = buildDocument(withDocumentFiles(request, fromFile ? dirname(resolve(file)) : process.cwd()));
        for (const w of result.warnings) console.error(`${color('yellow', 'warning')}  ${w}`);
        console.log(values.json ? JSON.stringify(result, null, 2) : values.body ? result.body : result.xml);
        return 0;
      } catch (e) {
        if (!(e instanceof BuildError)) throw e;
        console.error(`${color('red', 'BUILD ERROR')}  ${e.message}`);
        return 1;
      }
    }
    case 'serve': {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: 'string', default: '8080' },
          host: { type: 'string', default: '127.0.0.1' },
          'client-id': { type: 'string' },
          'secret-key': { type: 'string' },
          'reject-status': { type: 'string', default: '400' },
        },
      });
      const server = createMockServer({
        clientId: values['client-id'],
        secretKey: values['secret-key'],
        rejectStatus: Number(values['reject-status']),
        log: (line) => console.log(line),
      });
      server.listen(Number(values.port), values.host, () => {
        console.log(`jofotara-kit mock listening on http://${values.host}:${values.port}/core/invoices/`);
        console.log(color('dim', 'NOT a tax authority. Passing here means "passes known rules", not "accepted by ISTD".'));
      });
      return new Promise(() => {});
    }
    case 'template': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { body: { type: 'boolean' } } });
      const name = positionals[0] ?? '';
      if (!Object.hasOwn(TEMPLATES, name)) {
        console.error(`template: expected one of ${Object.keys(TEMPLATES).join(', ')}.`);
        return 2;
      }
      const xml = TEMPLATES[name as TemplateName]();
      console.log(values.body ? toRequestBody(xml) : xml);
      return 0;
    }
    case 'mcp': {
      // stdout is the MCP protocol channel: nothing else may be printed in this mode.
      const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      await serveMcpStdio(version);
      return new Promise(() => {});
    }
    case 'rules': {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
      if (values.json) console.log(JSON.stringify(RULES, null, 2));
      else for (const r of RULES) console.log(`${r.id}  ${r.severity.padEnd(7)}  ${(r.source ? `manual ${r.source}` : r.confidence).padEnd(22)}  ${r.title}`);
      return 0;
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: Error) => {
    console.error(e.message);
    process.exitCode = 2;
  },
);
