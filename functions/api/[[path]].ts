import {
  buildSampleTestEmail,
  extractOtpCodes,
  generateFakerUsername,
  parseEmailInput,
  sanitizeEmailHtml,
  stripHtmlToText,
} from '../../src/utils/tempMailLogic';
import type {
  CreateMailboxPayload,
  DomainInfo,
  EmailDetail,
  EmailSummary,
  GeneratedEmailPreview,
  Mailbox,
  MailProvider,
} from '../../src/types/mail';

interface CloudflarePagesEnv {
  MAILBOX_SESSION_SECRET?: string;
}

interface CloudflarePagesContext {
  request: Request;
  env: CloudflarePagesEnv;
  params: Record<string, string | string[]>;
}

interface SampleMeta {
  id: string;
  v: number;
  t: string;
}

interface PersistedMailboxRecord {
  i: string; // id
  a: string; // address
  u: string; // username
  d: string; // domain
  p: MailProvider; // provider
  c: string; // createdAt
  l: boolean; // isLive
  ma?: string; // mailtmAccountId
  mt?: string; // mailtmToken
  lt?: string; // tempmailLolToken
  gs?: string; // guerrillaSid
  del?: string[]; // deletedMessageIds
  rd?: string[]; // readMessageIds
  sm?: SampleMeta[]; // sample test emails
  sc?: number; // sampleCounter
}

interface PendingPreviewRecord {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  token: string;
  createdAt: number;
}

const REQUEST_TIMEOUT_MS = 7000;
const MAILTM_API = 'https://api.mail.tm';
const TEMPMAIL_LOL_API = 'https://api.tempmail.lol/v2';
const GUERRILLA_API = 'https://api.guerrillamail.com/ajax.php';
const GUERRILLA_DOMAINS = [
  'sharklasers.com',
  'guerrillamailblock.com',
  'grr.la',
  'spam4.me',
];

const SAFE_ID_RE = /^[a-zA-Z0-9._-]{2,128}$/;
const MAILBOX_COOKIE_PREFIX = 'tm_m_';
const PENDING_COOKIE_NAME = 'tm_pending';
const MAX_STORED_IDS = 40;
const MAX_STORED_SAMPLES = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(input));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptCookiePayload(payload: unknown, secret: string): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return toBase64Url(combined);
}

async function decryptCookiePayload<T>(token: string, secret: string): Promise<T | null> {
  try {
    const combined = fromBase64Url(token);
    if (combined.length < 13) return null;
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await deriveAesKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(decoder.decode(decrypted)) as T;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) map.set(name, val);
  }
  return map;
}

function buildCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  isHttps: boolean
): string {
  const segments = [
    `${name}=${value}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) segments.push('Secure');
  return segments.join('; ');
}

function jsonResponse(
  body: unknown,
  status = 200,
  setCookies: string[] = []
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  for (const cookie of setCookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/ld+json, application/json, */*',
      'User-Agent': 'TempMailApp/1.0',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`) as Error & {
      status?: number;
    };
    err.status = response.status;
    throw err;
  }
  return (await response.json()) as T;
}

async function fetchLiveDomains(): Promise<DomainInfo[]> {
  const domains: DomainInfo[] = [];
  try {
    const data = await fetchJson<{
      'hydra:member'?: Array<{ domain?: string; isActive?: boolean }>;
    }>(`${MAILTM_API}/domains`);
    for (const item of data['hydra:member'] ?? []) {
      if (item.domain && item.isActive !== false) {
        domains.push({
          domain: item.domain.toLowerCase(),
          provider: 'mailtm',
          active: true,
        });
      }
    }
  } catch {
    // Mail.tm temporarily unavailable; GuerrillaMail domains remain active
  }

  for (const d of GUERRILLA_DOMAINS) {
    if (!domains.some((item) => item.domain === d)) {
      domains.push({ domain: d, provider: 'guerrilla', active: true });
    }
  }
  return domains;
}

function parseFromHeader(raw: string): { name: string; address: string } {
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const cleanName = match[1].replace(/^["'\s]+|["'\s]+$/g, '');
    return { name: cleanName || match[2].split('@')[0], address: match[2].trim() };
  }
  const trimmed = raw.trim();
  return { name: trimmed.split('@')[0] || 'Người gửi', address: trimmed };
}

function buildSampleDetail(mb: PersistedMailboxRecord, meta: SampleMeta): EmailDetail {
  const sample = buildSampleTestEmail(mb.a, meta.v, meta.t);
  const readSet = new Set(mb.rd ?? []);
  return {
    id: meta.id,
    mailboxId: mb.i,
    fromName: sample.fromName,
    fromAddress: sample.fromAddress,
    toAddress: mb.a,
    subject: sample.subject,
    snippet: sample.textBody.replace(/\s+/g, ' ').slice(0, 140),
    receivedAt: sample.receivedAt,
    isRead: readSet.has(meta.id),
    otpCodes: extractOtpCodes(sample.textBody, sample.subject),
    isSample: true,
    textBody: sample.textBody,
    htmlBody: sanitizeEmailHtml(sample.htmlBody),
    rawSource: sample.rawSource,
  };
}

function getActiveSampleDetails(mb: PersistedMailboxRecord): EmailDetail[] {
  const deleted = new Set(mb.del ?? []);
  return (mb.sm ?? [])
    .filter((s) => !deleted.has(s.id))
    .map((s) => buildSampleDetail(mb, s));
}

function toPublicMailbox(
  mb: PersistedMailboxRecord,
  remoteCount = 0,
  remoteUnread = 0
): Mailbox {
  const samples = getActiveSampleDetails(mb);
  const sampleUnread = samples.filter((m) => !m.isRead).length;
  return {
    id: mb.i,
    address: mb.a,
    username: mb.u,
    domain: mb.d,
    provider: mb.p,
    createdAt: mb.c,
    messageCount: samples.length + remoteCount,
    unreadCount: sampleUnread + remoteUnread,
    isLive: mb.l,
  };
}

function toSummary(msg: EmailDetail): EmailSummary {
  return {
    id: msg.id,
    mailboxId: msg.mailboxId,
    fromName: msg.fromName,
    fromAddress: msg.fromAddress,
    toAddress: msg.toAddress,
    subject: msg.subject,
    snippet: msg.snippet,
    receivedAt: msg.receivedAt,
    isRead: msg.isRead,
    otpCodes: msg.otpCodes,
    isSample: msg.isSample,
  };
}

async function createMailTmAccount(
  username: string,
  domain: string
): Promise<{ accountId: string; token: string; address: string }> {
  const address = `${username}@${domain}`;
  const password = randomHex(16);
  const account = await fetchJson<{ id: string; address: string }>(`${MAILTM_API}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const tokenRes = await fetchJson<{ token: string }>(`${MAILTM_API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  return { accountId: account.id, token: tokenRes.token, address: account.address };
}

async function createGuerrillaAccount(
  username: string,
  domain: string
): Promise<{ sid: string; address: string }> {
  const initData = await fetchJson<{ sid_token?: string; email_addr?: string }>(
    `${GUERRILLA_API}?f=get_email_address`
  );
  if (!initData.sid_token) throw new Error('GuerrillaMail session unavailable');
  const setRes = await fetchJson<{ email_addr?: string; sid_token?: string }>(
    `${GUERRILLA_API}?f=set_email_user&email_user=${encodeURIComponent(username)}&lang=en&sid_token=${encodeURIComponent(initData.sid_token)}`
  );
  const actualUser = (setRes.email_addr?.split('@')[0] || username).toLowerCase();
  const chosenDomain = GUERRILLA_DOMAINS.includes(domain) ? domain : 'sharklasers.com';
  return {
    sid: setRes.sid_token || initData.sid_token,
    address: `${actualUser}@${chosenDomain}`,
  };
}

async function createTempMailLolAccount(): Promise<{ address: string; token: string }> {
  const data = await fetchJson<{ address?: string; token?: string }>(
    `${TEMPMAIL_LOL_API}/inbox/create`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }
  );
  if (!data.address || !data.token) {
    throw new Error('TempMail.lol did not return an inbox');
  }
  return { address: data.address.toLowerCase(), token: data.token };
}

async function fetchRemoteMessages(mb: PersistedMailboxRecord): Promise<EmailDetail[]> {
  if (!mb.l) return [];
  const deleted = new Set(mb.del ?? []);
  const read = new Set(mb.rd ?? []);

  if (mb.p === 'mailtm' && mb.mt) {
    try {
      const list = await fetchJson<{
        'hydra:member'?: Array<{
          id: string;
          from?: { name?: string; address?: string };
          to?: Array<{ address?: string }>;
          subject?: string;
          intro?: string;
          createdAt?: string;
          seen?: boolean;
        }>;
      }>(`${MAILTM_API}/messages`, {
        headers: { Authorization: `Bearer ${mb.mt}` },
      });

      return (list['hydra:member'] ?? [])
        .filter((m) => !deleted.has(m.id))
        .map((item) => {
          const subject = item.subject || '(Không có tiêu đề)';
          const snippet = item.intro || '';
          return {
            id: item.id,
            mailboxId: mb.i,
            fromName: item.from?.name || item.from?.address?.split('@')[0] || 'Người gửi',
            fromAddress: item.from?.address || 'unknown@sender',
            toAddress: item.to?.[0]?.address || mb.a,
            subject,
            snippet,
            receivedAt: item.createdAt || new Date().toISOString(),
            isRead: Boolean(item.seen) || read.has(item.id),
            otpCodes: extractOtpCodes(snippet, subject),
            textBody: snippet,
            htmlBody: '',
            rawSource: '',
          };
        });
    } catch {
      return [];
    }
  }

  if (mb.p === 'tempmail_lol' && mb.lt) {
    try {
      const data = await fetchJson<{
        emails?: Array<{
          from?: string;
          to?: string;
          subject?: string;
          body?: string;
          html?: string;
          date?: number;
        }>;
      }>(`${TEMPMAIL_LOL_API}/inbox?token=${encodeURIComponent(mb.lt)}`);

      const mapped = await Promise.all(
        (data.emails ?? []).map(async (item, idx) => {
          const hash = (
            await sha1Hex(`${item.from ?? ''}|${item.subject ?? ''}|${item.date ?? idx}`)
          ).slice(0, 16);
          const id = `tml_${hash}`;
          const fromRaw = item.from || 'unknown@sender';
          const parsedFrom = parseFromHeader(fromRaw);
          const subject = item.subject || '(Không có tiêu đề)';
          const textBody = item.body || stripHtmlToText(item.html || '');
          const htmlBody = sanitizeEmailHtml(item.html || '');
          const receivedAt = item.date
            ? new Date(item.date > 1e12 ? item.date : item.date * 1000).toISOString()
            : new Date().toISOString();
          const rawSource = [
            `Delivered-To: ${mb.a}`,
            `From: ${fromRaw}`,
            `To: <${item.to || mb.a}>`,
            `Date: ${new Date(receivedAt).toUTCString()}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset="UTF-8"`,
            ``,
            textBody,
          ].join('\r\n');
          return {
            id,
            mailboxId: mb.i,
            fromName: parsedFrom.name,
            fromAddress: parsedFrom.address,
            toAddress: item.to || mb.a,
            subject,
            snippet: textBody.slice(0, 140),
            receivedAt,
            isRead: read.has(id),
            otpCodes: extractOtpCodes(`${textBody}\n${htmlBody}`, subject),
            textBody,
            htmlBody,
            rawSource,
          };
        })
      );
      return mapped.filter((m) => !deleted.has(m.id));
    } catch {
      return [];
    }
  }

  if (mb.p === 'guerrilla' && mb.gs) {
    try {
      const data = await fetchJson<{
        list?: Array<{
          mail_id: string;
          mail_from: string;
          mail_subject: string;
          mail_excerpt: string;
          mail_timestamp: string;
          mail_read: string;
        }>;
      }>(`${GUERRILLA_API}?f=get_email_list&offset=0&sid_token=${encodeURIComponent(mb.gs)}`);

      return (data.list ?? [])
        .filter((m) => {
          const isDefaultPromo =
            String(m.mail_id) === '1' ||
            (m.mail_from?.toLowerCase() === 'no-reply@guerrillamail.com' &&
              m.mail_subject === 'Welcome to Guerrilla Mail');
          return !isDefaultPromo && !deleted.has(`gm_${m.mail_id}`);
        })
        .map((item) => {
          const id = `gm_${item.mail_id}`;
          const parsedFrom = parseFromHeader(item.mail_from || 'unknown@sender');
          const subject = item.mail_subject || '(Không có tiêu đề)';
          const snippet = stripHtmlToText(item.mail_excerpt || '');
          const ts = Number(item.mail_timestamp);
          const receivedAt =
            Number.isFinite(ts) && ts > 1_000_000_000
              ? new Date(ts * 1000).toISOString()
              : new Date().toISOString();
          return {
            id,
            mailboxId: mb.i,
            fromName: parsedFrom.name,
            fromAddress: parsedFrom.address,
            toAddress: mb.a,
            subject,
            snippet,
            receivedAt,
            isRead: item.mail_read === '1' || read.has(id),
            otpCodes: extractOtpCodes(snippet, subject),
            textBody: snippet,
            htmlBody: '',
            rawSource: '',
          };
        });
    } catch {
      return [];
    }
  }

  return [];
}

async function loadMailboxFromCookies(
  cookies: Map<string, string>,
  id: string,
  secret: string
): Promise<PersistedMailboxRecord | null> {
  const raw = cookies.get(`${MAILBOX_COOKIE_PREFIX}${id}`);
  if (!raw) return null;
  const parsed = await decryptCookiePayload<PersistedMailboxRecord>(raw, secret);
  if (!parsed || parsed.i !== id) return null;
  return parsed;
}

async function loadAllMailboxes(
  cookies: Map<string, string>,
  secret: string
): Promise<PersistedMailboxRecord[]> {
  const records: PersistedMailboxRecord[] = [];
  for (const [name, value] of cookies.entries()) {
    if (!name.startsWith(MAILBOX_COOKIE_PREFIX)) continue;
    const parsed = await decryptCookiePayload<PersistedMailboxRecord>(value, secret);
    if (parsed && typeof parsed.i === 'string' && typeof parsed.a === 'string') {
      records.push(parsed);
    }
  }
  return records.sort((a, b) => Date.parse(b.c) - Date.parse(a.c));
}

async function persistMailboxCookie(
  mb: PersistedMailboxRecord,
  secret: string,
  isHttps: boolean
): Promise<string> {
  if (mb.del && mb.del.length > MAX_STORED_IDS) {
    mb.del = mb.del.slice(-MAX_STORED_IDS);
  }
  if (mb.rd && mb.rd.length > MAX_STORED_IDS) {
    mb.rd = mb.rd.slice(-MAX_STORED_IDS);
  }
  if (mb.sm && mb.sm.length > MAX_STORED_SAMPLES) {
    mb.sm = mb.sm.slice(0, MAX_STORED_SAMPLES);
  }
  const encrypted = await encryptCookiePayload(mb, secret);
  return buildCookieHeader(`${MAILBOX_COOKIE_PREFIX}${mb.i}`, encrypted, 86400, isHttps);
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function onRequest(context: CloudflarePagesContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const isHttps = url.protocol === 'https:';
  const secret = env?.MAILBOX_SESSION_SECRET || 'tempmail-studio-cf-edge-default-v1';
  const cookies = parseCookies(request.headers.get('cookie'));

  // Normalize API subpath under /api
  const pathname = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const segments = pathname ? pathname.split('/').map(decodeURIComponent) : [];

  try {
    // 0. GET /api/health
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      return jsonResponse({ ok: true, runtime: 'cloudflare-pages' });
    }

    // 1. GET /api/domains
    if (method === 'GET' && segments.length === 1 && segments[0] === 'domains') {
      const domains = await fetchLiveDomains();
      return jsonResponse({ domains });
    }

    // 2. GET /api/mailboxes
    if (method === 'GET' && segments.length === 1 && segments[0] === 'mailboxes') {
      const all = await loadAllMailboxes(cookies, secret);
      return jsonResponse({ mailboxes: all.map((m) => toPublicMailbox(m)) });
    }

    // 3. POST /api/mailboxes/generate
    if (
      method === 'POST' &&
      segments.length === 2 &&
      segments[0] === 'mailboxes' &&
      segments[1] === 'generate'
    ) {
      const body = await readJsonBody<{ mode?: string }>(request);
      if (body === null) {
        return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
      }
      const mode = body.mode === 'domain' ? 'domain' : 'email';

      if (mode === 'email') {
        try {
          const created = await createTempMailLolAccount();
          const [username, domain] = created.address.split('@');
          const previewId = randomHex(12);
          const pendingRecord: PendingPreviewRecord = {
            id: previewId,
            address: created.address,
            username,
            domain,
            provider: 'tempmail_lol',
            token: created.token,
            createdAt: Date.now(),
          };
          const encryptedPending = await encryptCookiePayload(pendingRecord, secret);
          const pendingCookie = buildCookieHeader(
            PENDING_COOKIE_NAME,
            encryptedPending,
            900,
            isHttps
          );
          const payload: GeneratedEmailPreview = {
            address: created.address,
            username,
            domain,
            provider: 'tempmail_lol',
            pregeneratedToken: previewId,
          };
          return jsonResponse(payload, 200, [pendingCookie]);
        } catch {
          // Fall through to Mail.tm / Guerrilla preview
        }
      }

      const domains = await fetchLiveDomains();
      const preferred = domains[0] ?? {
        domain: 'sharklasers.com',
        provider: 'guerrilla' as MailProvider,
        active: true,
      };
      const username = generateFakerUsername();
      const payload: GeneratedEmailPreview = {
        address: `${username}@${preferred.domain}`,
        username,
        domain: preferred.domain,
        provider: preferred.provider,
      };
      return jsonResponse(payload);
    }

    // 4. POST /api/mailboxes
    if (method === 'POST' && segments.length === 1 && segments[0] === 'mailboxes') {
      const body = await readJsonBody<CreateMailboxPayload>(request);
      if (body === null) {
        return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
      }

      const mode = body.mode === 'domain' ? 'domain' : 'email';
      const domains = await fetchLiveDomains();
      const setCookies: string[] = [];
      let created: PersistedMailboxRecord | null = null;

      // Case A: Activating a pregenerated TempMail.lol system email
      if (body.pregeneratedToken) {
        const rawPending = cookies.get(PENDING_COOKIE_NAME);
        if (rawPending) {
          const pending = await decryptCookiePayload<PendingPreviewRecord>(rawPending, secret);
          if (pending && pending.id === body.pregeneratedToken) {
            created = {
              i: `mb_${randomHex(8)}`,
              a: pending.address,
              u: pending.username,
              d: pending.domain,
              p: 'tempmail_lol',
              c: new Date().toISOString(),
              l: true,
              lt: pending.token,
            };
            setCookies.push(buildCookieHeader(PENDING_COOKIE_NAME, '', 0, isHttps));
          }
        }
      }

      // Case B: Instant Email mode without pre-clicking Generate email
      if (!created && mode === 'email' && !body.email?.trim()) {
        try {
          const tml = await createTempMailLolAccount();
          const [username, domain] = tml.address.split('@');
          created = {
            i: `mb_${randomHex(8)}`,
            a: tml.address,
            u: username,
            d: domain,
            p: 'tempmail_lol',
            c: new Date().toISOString(),
            l: true,
            lt: tml.token,
          };
        } catch {
          // Fall through to Mail.tm / GuerrillaMail
        }
      }

      if (!created) {
        const rawInput =
          mode === 'email'
            ? (body.email ?? '').trim() || generateFakerUsername()
            : (body.username ?? '').trim() || generateFakerUsername();

        const fallbackDomain =
          body.domain && body.domain !== 'random'
            ? body.domain
            : domains[Math.floor(Math.random() * Math.max(1, domains.length))]?.domain ||
              'sharklasers.com';

        const parsed = parseEmailInput(rawInput, fallbackDomain);
        if (!parsed.valid || !parsed.username || !parsed.domain) {
          return jsonResponse({ error: parsed.error || 'Dữ liệu email không hợp lệ.' }, 400);
        }

        const username = parsed.username;
        const requestedDomain = parsed.domain;
        const domainEntry = domains.find((d) => d.domain === requestedDomain);

        // Return existing mailbox if user already created this exact address
        const existingAll = await loadAllMailboxes(cookies, secret);
        const existing = existingAll.find(
          (m) => m.a.toLowerCase() === `${username}@${requestedDomain}`.toLowerCase()
        );
        if (existing) {
          return jsonResponse({ mailbox: toPublicMailbox(existing) });
        }

        const id = `mb_${randomHex(8)}`;
        const isExplicitMailTm =
          domainEntry?.provider === 'mailtm' &&
          Boolean(body.domain && body.domain !== 'random') &&
          Boolean(body.username?.trim() || body.email?.trim());

        if (domainEntry?.provider === 'mailtm') {
          try {
            const mt = await createMailTmAccount(username, requestedDomain);
            created = {
              i: id,
              a: mt.address,
              u: username,
              d: requestedDomain,
              p: 'mailtm',
              c: new Date().toISOString(),
              l: true,
              ma: mt.accountId,
              mt: mt.token,
            };
          } catch (err) {
            const status = (err as { status?: number })?.status;
            if (status === 422 && isExplicitMailTm) {
              return jsonResponse(
                {
                  error: `Địa chỉ ${username}@${requestedDomain} đã được sử dụng. Hãy đổi username khác hoặc chọn tên miền khác.`,
                },
                409
              );
            }
          }
        }

        if (!created) {
          try {
            const targetDomain =
              domainEntry?.provider === 'guerrilla' ? requestedDomain : 'sharklasers.com';
            const gm = await createGuerrillaAccount(username, targetDomain);
            const [gmUser, gmDom] = gm.address.split('@');
            created = {
              i: id,
              a: gm.address,
              u: gmUser,
              d: gmDom,
              p: 'guerrilla',
              c: new Date().toISOString(),
              l: true,
              gs: gm.sid,
            };
          } catch {
            // Final offline fallback
          }
        }

        if (!created) {
          created = {
            i: id,
            a: `${username}@${requestedDomain}`,
            u: username,
            d: requestedDomain,
            p: 'local',
            c: new Date().toISOString(),
            l: false,
          };
        }
      }

      setCookies.push(await persistMailboxCookie(created, secret, isHttps));
      return jsonResponse({ mailbox: toPublicMailbox(created) }, 201, setCookies);
    }

    // 5. DELETE /api/mailboxes/:id
    if (method === 'DELETE' && segments.length === 2 && segments[0] === 'mailboxes') {
      const id = segments[1];
      if (!SAFE_ID_RE.test(id)) {
        return jsonResponse({ error: 'ID hộp thư không hợp lệ.' }, 400);
      }
      const mb = await loadMailboxFromCookies(cookies, id, secret);
      if (!mb) {
        return jsonResponse({ error: 'Không tìm thấy hộp thư.' }, 404);
      }
      if (mb.p === 'mailtm' && mb.ma && mb.mt) {
        fetch(`${MAILTM_API}/accounts/${encodeURIComponent(mb.ma)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${mb.mt}` },
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      }
      const expireCookie = buildCookieHeader(`${MAILBOX_COOKIE_PREFIX}${id}`, '', 0, isHttps);
      return jsonResponse({ deleted: true, id }, 200, [expireCookie]);
    }

    // 6. GET /api/mailboxes/:id/messages
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'mailboxes' &&
      segments[2] === 'messages'
    ) {
      const id = segments[1];
      if (!SAFE_ID_RE.test(id)) {
        return jsonResponse({ error: 'ID hộp thư không hợp lệ.' }, 400);
      }
      const mb = await loadMailboxFromCookies(cookies, id, secret);
      if (!mb) {
        return jsonResponse({ error: 'Không tìm thấy hộp thư.' }, 404);
      }

      const remoteMessages = await fetchRemoteMessages(mb);
      const remoteUnread = remoteMessages.filter((m) => !m.isRead).length;
      const sampleDetails = getActiveSampleDetails(mb);
      const merged = [...sampleDetails, ...remoteMessages].sort(
        (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
      );

      return jsonResponse({
        mailbox: toPublicMailbox(mb, remoteMessages.length, remoteUnread),
        messages: merged.map(toSummary),
      });
    }

    // 7. GET /api/mailboxes/:id/messages/:messageId
    if (
      method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'mailboxes' &&
      segments[2] === 'messages'
    ) {
      const id = segments[1];
      const messageId = segments[3];
      if (!SAFE_ID_RE.test(id) || !SAFE_ID_RE.test(messageId)) {
        return jsonResponse({ error: 'Tham số không hợp lệ.' }, 400);
      }
      const mb = await loadMailboxFromCookies(cookies, id, secret);
      if (!mb) {
        return jsonResponse({ error: 'Không tìm thấy hộp thư.' }, 404);
      }

      const markReadAndPersist = async (): Promise<string[]> => {
        const readSet = new Set(mb.rd ?? []);
        if (readSet.has(messageId)) return [];
        readSet.add(messageId);
        mb.rd = Array.from(readSet);
        return [await persistMailboxCookie(mb, secret, isHttps)];
      };

      // Check sample test messages first
      const deletedSet = new Set(mb.del ?? []);
      const sampleMeta = (mb.sm ?? []).find(
        (s) => s.id === messageId && !deletedSet.has(s.id)
      );
      if (sampleMeta) {
        const setCookies = await markReadAndPersist();
        const detail = buildSampleDetail(mb, sampleMeta);
        return jsonResponse({ message: { ...detail, isRead: true } }, 200, setCookies);
      }

      // Mail.tm detail + raw source
      if (mb.p === 'mailtm' && mb.mt) {
        try {
          const detail = await fetchJson<{
            id: string;
            from?: { name?: string; address?: string };
            to?: Array<{ address?: string }>;
            subject?: string;
            text?: string;
            html?: string[];
            createdAt?: string;
          }>(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
            headers: { Authorization: `Bearer ${mb.mt}` },
          });

          let rawSource = '';
          try {
            const src = await fetchJson<{ data?: string }>(
              `${MAILTM_API}/sources/${encodeURIComponent(messageId)}`,
              { headers: { Authorization: `Bearer ${mb.mt}` } }
            );
            rawSource = src.data || '';
          } catch {
            rawSource = '';
          }

          const subject = detail.subject || '(Không có tiêu đề)';
          const rawHtml = Array.isArray(detail.html) ? detail.html.join('\n') : '';
          const htmlBody = sanitizeEmailHtml(rawHtml);
          const textBody = detail.text || stripHtmlToText(htmlBody);
          const receivedAt = detail.createdAt || new Date().toISOString();
          if (!rawSource) {
            rawSource = [
              `Delivered-To: ${mb.a}`,
              `From: "${detail.from?.name || ''}" <${detail.from?.address || ''}>`,
              `To: <${detail.to?.[0]?.address || mb.a}>`,
              `Date: ${new Date(receivedAt).toUTCString()}`,
              `Subject: ${subject}`,
              ``,
              textBody,
            ].join('\r\n');
          }

          fetch(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${mb.mt}`,
              'Content-Type': 'application/merge-patch+json',
            },
            body: JSON.stringify({ seen: true }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});

          const setCookies = await markReadAndPersist();
          const full: EmailDetail = {
            id: detail.id,
            mailboxId: mb.i,
            fromName: detail.from?.name || detail.from?.address?.split('@')[0] || 'Người gửi',
            fromAddress: detail.from?.address || 'unknown@sender',
            toAddress: detail.to?.[0]?.address || mb.a,
            subject,
            snippet: textBody.slice(0, 140),
            receivedAt,
            isRead: true,
            otpCodes: extractOtpCodes(`${textBody}\n${htmlBody}`, subject),
            textBody,
            htmlBody,
            rawSource,
          };
          return jsonResponse({ message: full }, 200, setCookies);
        } catch {
          return jsonResponse({ error: 'Không thể tải nội dung thư.' }, 404);
        }
      }

      // TempMail.lol detail
      if (mb.p === 'tempmail_lol' && mb.lt) {
        const all = await fetchRemoteMessages(mb);
        const hit = all.find((m) => m.id === messageId);
        if (hit) {
          const setCookies = await markReadAndPersist();
          return jsonResponse({ message: { ...hit, isRead: true } }, 200, setCookies);
        }
      }

      // GuerrillaMail detail
      if (mb.p === 'guerrilla' && mb.gs && messageId.startsWith('gm_')) {
        const rawId = messageId.slice(3);
        try {
          const data = await fetchJson<{
            mail_from?: string;
            mail_subject?: string;
            mail_body?: string;
            mail_timestamp?: string;
          }>(
            `${GUERRILLA_API}?f=fetch_email&email_id=${encodeURIComponent(rawId)}&sid_token=${encodeURIComponent(mb.gs)}`
          );
          const parsedFrom = parseFromHeader(data.mail_from || 'unknown@sender');
          const subject = data.mail_subject || '(Không có tiêu đề)';
          const htmlBody = sanitizeEmailHtml(data.mail_body || '');
          const textBody = stripHtmlToText(htmlBody);
          const ts = Number(data.mail_timestamp);
          const receivedAt =
            Number.isFinite(ts) && ts > 1_000_000_000
              ? new Date(ts * 1000).toISOString()
              : new Date().toISOString();
          const rawSource = [
            `Delivered-To: ${mb.a}`,
            `From: ${data.mail_from || ''}`,
            `To: <${mb.a}>`,
            `Date: ${new Date(receivedAt).toUTCString()}`,
            `Subject: ${subject}`,
            ``,
            textBody,
          ].join('\r\n');

          const setCookies = await markReadAndPersist();
          const full: EmailDetail = {
            id: messageId,
            mailboxId: mb.i,
            fromName: parsedFrom.name,
            fromAddress: parsedFrom.address,
            toAddress: mb.a,
            subject,
            snippet: textBody.slice(0, 140),
            receivedAt,
            isRead: true,
            otpCodes: extractOtpCodes(`${textBody}\n${htmlBody}`, subject),
            textBody,
            htmlBody,
            rawSource,
          };
          return jsonResponse({ message: full }, 200, setCookies);
        } catch {
          return jsonResponse({ error: 'Không thể tải nội dung thư.' }, 404);
        }
      }

      return jsonResponse({ error: 'Không tìm thấy thư.' }, 404);
    }

    // 8. DELETE /api/mailboxes/:id/messages/:messageId
    if (
      method === 'DELETE' &&
      segments.length === 4 &&
      segments[0] === 'mailboxes' &&
      segments[2] === 'messages'
    ) {
      const id = segments[1];
      const messageId = segments[3];
      if (!SAFE_ID_RE.test(id) || !SAFE_ID_RE.test(messageId)) {
        return jsonResponse({ error: 'Tham số không hợp lệ.' }, 400);
      }
      const mb = await loadMailboxFromCookies(cookies, id, secret);
      if (!mb) {
        return jsonResponse({ error: 'Không tìm thấy hộp thư.' }, 404);
      }

      const deletedSet = new Set(mb.del ?? []);
      deletedSet.add(messageId);
      mb.del = Array.from(deletedSet);
      mb.sm = (mb.sm ?? []).filter((s) => s.id !== messageId);

      if (mb.p === 'mailtm' && mb.mt && !messageId.startsWith('sample_')) {
        fetch(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${mb.mt}` },
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      } else if (mb.p === 'guerrilla' && mb.gs && messageId.startsWith('gm_')) {
        const rawId = messageId.slice(3);
        fetch(
          `${GUERRILLA_API}?f=del_email&email_ids[]=${encodeURIComponent(rawId)}&sid_token=${encodeURIComponent(mb.gs)}`,
          { signal: AbortSignal.timeout(4000) }
        ).catch(() => {});
      }

      const updatedCookie = await persistMailboxCookie(mb, secret, isHttps);
      return jsonResponse({ deleted: true, messageId }, 200, [updatedCookie]);
    }

    // 9. POST /api/mailboxes/:id/test-email
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'mailboxes' &&
      segments[2] === 'test-email'
    ) {
      const id = segments[1];
      if (!SAFE_ID_RE.test(id)) {
        return jsonResponse({ error: 'ID hộp thư không hợp lệ.' }, 400);
      }
      const mb = await loadMailboxFromCookies(cookies, id, secret);
      if (!mb) {
        return jsonResponse({ error: 'Không tìm thấy hộp thư.' }, 404);
      }

      const variant = mb.sc ?? 0;
      mb.sc = variant + 1;
      const meta: SampleMeta = {
        id: `sample_${randomHex(6)}`,
        v: variant,
        t: new Date().toISOString(),
      };
      mb.sm = [meta, ...(mb.sm ?? [])];

      const detail = buildSampleDetail(mb, meta);
      const updatedCookie = await persistMailboxCookie(mb, secret, isHttps);
      return jsonResponse(
        { message: toSummary(detail), mailbox: toPublicMailbox(mb) },
        201,
        [updatedCookie]
      );
    }

    return jsonResponse({ error: 'API endpoint không tồn tại.' }, 404);
  } catch {
    return jsonResponse({ error: 'Đã xảy ra lỗi trên máy chủ.' }, 500);
  }
}
