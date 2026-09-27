import type { BuildResult } from './build.ts';
import { DocumentReadError, toXml } from './document.ts';
import { toRequestBody } from './render.ts';
import { validate } from './validate.ts';
import type { Finding } from './validate.ts';

export const JOFOTARA_PRODUCTION_URL = 'https://backend.jofotara.gov.jo';
export const JOFOTARA_PATH = '/core/invoices/';

export interface ClientOptions {
  /** Required on purpose: the local mock (e.g. http://127.0.0.1:8080) or JOFOTARA_PRODUCTION_URL. */
  baseUrl: string;
  /** From the portal's device-linking screen (manual p.7, p.9). */
  clientId: string;
  secretKey: string;
  /** Give up waiting after this long; the outcome is then `unknown`, not `rejected`. Default 30 s. */
  timeoutMs?: number;
  /** Validate before sending and refuse documents with errors (default true). */
  validateBeforeSending?: boolean;
  fetch?: typeof fetch;
}

/** An error or notice from the JoFotara response (EINV_RESULTS). */
export interface ResponseMessage {
  code: string;
  message: string;
  category?: string;
}

/** Which document was sent, read from its XML. */
export interface SentDocument {
  id: string;
  uuid: string;
}

export type SubmitOutcome =
  /** HTTP success, an explicit success status and a QR code: print the QR on the invoice. */
  | { status: 'accepted'; document?: SentDocument; qr: string; governmentUuid?: string; warnings: ResponseMessage[]; httpStatus: number; raw: string }
  /** Explicit rejection and no sign of acceptance. The document was not recorded. */
  | { status: 'rejected'; document?: SentDocument; errors: ResponseMessage[]; warnings: ResponseMessage[]; httpStatus: number; raw: string }
  /**
   * The document may or may not have been recorded. Do not send a new document for the same sale:
   * check the JoFotara portal, and if you retry, send this exact XML again (same UUID).
   */
  | { status: 'unknown'; document?: SentDocument; reason: 'timeout' | 'network' | 'unreadable' | 'unconfirmed'; message: string; httpStatus?: number; raw?: string }
  /** Nothing reached JoFotara: the document failed validation, or the server could not be reached. */
  | { status: 'not-sent'; document?: SentDocument; reason: 'invalid' | 'unreachable'; message: string; findings?: Finding[] };

export type ResponseOutcome = Extract<SubmitOutcome, { status: 'accepted' | 'rejected' | 'unknown' }>;

export interface JofotaraClient {
  /** Send one document: XML, a {"invoice": base64} body, base64, or a build result. */
  submit(document: string | BuildResult): Promise<SubmitOutcome>;
}

// Network failures that happen before any byte of the request can reach the server.
const NOT_DELIVERED = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const SUCCESS = new Set(['SUBMITTED', 'PASS']);
const REJECTION = new Set(['NOT_SUBMITTED', 'ERROR', 'REJECT', 'REJECTED']);
const GOVERNMENT_UUID_KEYS = new Set(['EINV_INV_UUID', 'EINV_UUID', 'INV_UUID', 'INVOICE_UUID']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createClient(options: ClientOptions): JofotaraClient {
  const { baseUrl, clientId, secretKey } = options;
  if (!baseUrl) throw new TypeError('createClient: baseUrl is required (the local mock or JOFOTARA_PRODUCTION_URL).');
  if (!clientId || !secretKey) throw new TypeError('createClient: clientId and secretKey are required.');
  const url = new URL(JOFOTARA_PATH, baseUrl);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async submit(input) {
      let xml: string;
      try {
        xml = typeof input === 'string' ? toXml(input) : input.xml;
      } catch (e) {
        if (e instanceof DocumentReadError) return { status: 'not-sent', reason: 'invalid', message: e.message };
        throw e;
      }
      const report = validate(xml);
      const document = report.invoice ? { id: report.invoice.id, uuid: report.invoice.uuid } : undefined;
      const withDoc = <T extends object>(o: T) => (document ? { ...o, document } : o);
      if (options.validateBeforeSending !== false && !report.ok) {
        return withDoc({ status: 'not-sent', reason: 'invalid', message: `The document has ${report.errors} validation error(s); nothing was sent.`, findings: report.findings } as const);
      }

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'Client-Id': clientId, 'Secret-Key': secretKey, 'Content-Type': 'application/json' },
          body: toRequestBody(xml),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        return withDoc(networkOutcome(e, timeoutMs));
      }
      let raw: string;
      try {
        raw = await res.text();
      } catch (e) {
        return withDoc({ ...networkOutcome(e, timeoutMs, true), httpStatus: res.status } as SubmitOutcome);
      }
      return withDoc(classifyResponse(res.status, raw));
    },
  };
}

function networkOutcome(e: unknown, timeoutMs: number, afterResponse = false): SubmitOutcome {
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') {
    return { status: 'unknown', reason: 'timeout', message: `No complete answer within ${timeoutMs} ms. The document may have been recorded.` };
  }
  const code = err?.cause?.code ?? err?.code;
  if (!afterResponse && code && NOT_DELIVERED.has(code)) {
    return { status: 'not-sent', reason: 'unreachable', message: `Could not reach the server (${code}); the request was not delivered.` };
  }
  return { status: 'unknown', reason: 'network', message: `The connection failed${code ? ` (${code})` : ''} after the request may have been delivered.` };
}

/**
 * Classify a JoFotara response. Accepted needs all three: HTTP success, an explicit success
 * status and a QR code. Rejected needs explicit rejection evidence and no sign of acceptance.
 * Anything else is unknown. For callers with their own HTTP stack.
 */
export function classifyResponse(httpStatus: number, raw: string): ResponseOutcome {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 'unknown', reason: 'unreadable', message: `HTTP ${httpStatus} with a body that is not JSON.`, httpStatus, raw };
  }
  if (!body || typeof body !== 'object') {
    return { status: 'unknown', reason: 'unreadable', message: `HTTP ${httpStatus} with a JSON body that is not an object.`, httpStatus, raw };
  }
  const results = field(body, 'EINV_RESULTS');
  const statuses = [field(body, 'EINV_STATUS'), field(results, 'status')].map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''));
  const errors = messages(field(results, 'ERRORS'));
  const warnings = [...messages(field(results, 'WARNINGS')), ...messages(field(results, 'INFO'))];
  let qr = '';
  let governmentUuid: string | undefined;
  walk(body, (key, value) => {
    const k = key.toUpperCase();
    if (!qr && k === 'EINV_QR' && typeof value === 'string' && value.trim()) qr = value.trim();
    if (!governmentUuid && GOVERNMENT_UUID_KEYS.has(k) && typeof value === 'string' && UUID_RE.test(value.trim())) governmentUuid = value.trim();
  });

  const ok = httpStatus >= 200 && httpStatus < 300;
  const success = statuses.some((s) => SUCCESS.has(s));
  const rejection = statuses.some((s) => REJECTION.has(s)) || errors.length > 0;
  if (ok && success && qr && !rejection) {
    return { status: 'accepted', qr, ...(governmentUuid ? { governmentUuid } : {}), warnings, httpStatus, raw };
  }
  if (rejection && !success && !qr) return { status: 'rejected', errors, warnings, httpStatus, raw };
  const why = success && rejection ? 'success and rejection at the same time'
    : ok && success ? 'success without a QR code'
    : ok ? 'no success or rejection status'
    : `HTTP ${httpStatus} without a clear rejection`;
  return { status: 'unknown', reason: 'unconfirmed', message: `The response is not conclusive: ${why}.`, httpStatus, raw };
}

/** A property by name, ignoring case (environments differ in key casing). */
function field(o: unknown, name: string): unknown {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const upper = name.toUpperCase();
  const key = Object.keys(o).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : (o as Record<string, unknown>)[key];
}

function messages(list: unknown): ResponseMessage[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const code = String(field(m, 'EINV_CODE') ?? field(m, 'code') ?? '').trim().slice(0, 120);
      const message = String(field(m, 'EINV_MESSAGE') ?? field(m, 'message') ?? '').trim().slice(0, 500);
      const category = field(m, 'EINV_CATEGORY');
      return { code, message, ...(typeof category === 'string' && category ? { category } : {}) };
    });
}

function walk(value: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 12 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    visit(k, v);
    walk(v, visit, depth + 1);
  }
}
