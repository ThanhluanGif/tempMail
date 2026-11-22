import {
  extractOtpCodes,
  generateFakerUsername,
  parseEmailInput,
  sanitizeEmailHtml,
  stripHtmlToText,
} from '../../src/utils/tempMailLogic';
import { parseRawMimeEmail } from '../../src/utils/mimeParser';
import type {
  CreateMailboxPayload,
  DomainInfo,
  EmailDetail,
  EmailSummary,
  GeneratedEmailPreview,
  Mailbox,
  MailProvider,
} from '../../src/types/mail';

export interface CloudflareKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CloudflarePagesEnv {
  MAILBOX_SESSION_SECRET?: string;
  MAILBOX_KV?: CloudflareKvNamespace;
  CUSTOM_DOMAINS?: string;
}

interface CloudflarePagesContext {
  request: Request;
  env: CloudflarePagesEnv;
  params: Record<string, string | string[]>;
}

interface RemoteFetchResult {
  messages: EmailDetail[];
  syncError?: string;
  rateLimited?: boolean;
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
  del?: string[]; // deletedMessageIds
  rd?: string[]; // readMessageIds
}

interface PendingPreviewRecord {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  token?: string;
  accountId?: string;
  createdAt: number;
}

const REQUEST_TIMEOUT_MS = 7000;
const MAILTM_API = 'https://api.mail.tm';
const TEMPMAIL_PLUS_API = 'https://tempmail.plus/api/mails';
const INBOXES_API = 'https://inboxes.com/api/v2';
const TEMPMAIL_LOL_API = 'https://api.tempmail.lol/v2';

const TEMPMAIL_PLUS_DOMAINS = [
  'mailto.plus',
  'fexpost.com',
  'fexbox.org',
  'fextemp.com',
  'merepost.com',
  'chitthi.in',
  'any.pink',
];

const INBOXES_FALLBACK_DOMAINS = [
  'blondmail.com',
  'chapsmail.com',
  'clowmail.com',
  'dropjar.com',
  'fivermail.com',
  'getairmail.com',
  'getmule.com',
  'gimpmail.com',
  'givmail.com',
  'guysmail.com',
  'inboxbear.com',
  'replyloop.com',
  'tafmail.com',
  'temptami.com',
  'tupmail.com',
];

const SAFE_ID_RE = /^[a-zA-Z0-9._-]{2,128}$/;
const MAILBOX_COOKIE_PREFIX = 'tm_m_';
const PENDING_COOKIE_NAME = 'tm_pending';
const MAX_STORED_IDS = 40;

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

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/ld+json, application/json, */*',
      'User-Agent': BROWSER_USER_AGENT,
      'Cache-Control': 'no-cache',
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

function classifyUpstreamError(err: unknown): { syncError: string; rateLimited: boolean } {
  const status = (err as { status?: number })?.status;
  if (status === 429) {
    return {
      rateLimited: true,
      syncError: 'Máy chủ tên miền tạm giới hạn tần suất (429) — đang tự động thử lại...',
    };
  }
  if (status === 403 || status === 401) {
    return {
      rateLimited: false,
      syncError: 'Máy chủ tên miền từ chối kết nối tạm thời — thử đổi tên miền khác trong tab Domain.',
    };
  }
  return {
    rateLimited: false,
    syncError: 'Không thể đồng bộ hộp thư lúc này — hệ thống sẽ tự động thử lại.',
  };
}

function getConfiguredCustomDomains(env?: CloudflarePagesEnv): string[] {
  const raw = env?.CUSTOM_DOMAINS || '';
  if (!raw.trim() || !env?.MAILBOX_KV) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => Boolean(d) && d.includes('.'));
}

export async function storeIncomingCloudflareEmail(
  env: CloudflarePagesEnv,
  rawEmail: string,
  envelopeFrom: string,
  envelopeTo: string
): Promise<{ stored: boolean; id?: string; otpCodes?: string[] }> {
  if (!env?.MAILBOX_KV) return { stored: false };
  const parsed = parseRawMimeEmail(rawEmail, envelopeFrom, envelopeTo);
  const recipient = (envelopeTo || parsed.toAddress).trim().toLowerCase();
  if (!recipient || !recipient.includes('@')) return { stored: false };

  const id = `cf_${randomHex(8)}`;
  const htmlBody = sanitizeEmailHtml(parsed.htmlBody);
  const textBody = parsed.textBody || stripHtmlToText(htmlBody);
  const otpCodes = extractOtpCodes(`${textBody}\n${htmlBody}`, parsed.subject);
  const detail: EmailDetail = {
    id,
    mailboxId: recipient,
    fromName: parsed.fromName,
    fromAddress: parsed.fromAddress,
    toAddress: recipient,
    subject: parsed.subject,
    snippet: textBody.replace(/\s+/g, ' ').slice(0, 140) || parsed.subject,
    receivedAt: parsed.receivedAt,
    isRead: false,
    otpCodes,
    textBody,
    htmlBody,
    rawSource: parsed.rawSource,
  };

  const ttl = 86400;
  await env.MAILBOX_KV.put(`msg:${recipient}:${id}`, JSON.stringify(detail), {
    expirationTtl: ttl,
  });

  const indexKey = `inbox:${recipient}`;
  const rawIndex = await env.MAILBOX_KV.get(indexKey);
  let existingSummaries: EmailSummary[] = [];
  if (rawIndex) {
    try {
      const arr = JSON.parse(rawIndex);
      if (Array.isArray(arr)) existingSummaries = arr as EmailSummary[];
    } catch {
      existingSummaries = [];
    }
  }

  const nextSummaries = [toSummary(detail), ...existingSummaries.filter((m) => m.id !== id)].slice(
    0,
    30
  );
  await env.MAILBOX_KV.put(indexKey, JSON.stringify(nextSummaries), { expirationTtl: ttl });
  return { stored: true, id, otpCodes };
}

function extractHydraItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec['hydra:member'])) return rec['hydra:member'] as T[];
    if (Array.isArray(rec.member)) return rec.member as T[];
  }
  return [];
}

async function fetchLiveDomains(env?: CloudflarePagesEnv): Promise<DomainInfo[]> {
  const domains: DomainInfo[] = [];
  const seen = new Set<string>();
  const addDomain = (domain: string, provider: MailProvider) => {
    const clean = domain.trim().toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    domains.push({ domain: clean, provider, active: true });
  };

  // Custom Cloudflare Email Routing domains take top priority (private, zero blocklist)
  for (const custom of getConfiguredCustomDomains(env)) {
    addDomain(custom, 'cloudflare_email');
  }

  // Query Mail.tm and Inboxes.com in parallel for fast domain discovery
  const [mailtmResult, inboxesResult] = await Promise.allSettled([
    fetchJson<unknown>(`${MAILTM_API}/domains`),
    fetchJson<{ domains?: Array<{ qdn?: string }> }>(`${INBOXES_API}/domain`),
  ]);

  if (mailtmResult.status === 'fulfilled') {
    const members = extractHydraItems<{ domain?: string; isActive?: boolean }>(mailtmResult.value);
    for (const item of members) {
      if (item.domain && item.isActive !== false) {
        addDomain(item.domain, 'mailtm');
      }
    }
  }

  for (const d of TEMPMAIL_PLUS_DOMAINS) {
    addDomain(d, 'tempmail_plus');
  }

  let addedInboxes = 0;
  if (inboxesResult.status === 'fulfilled') {
    for (const item of inboxesResult.value?.domains ?? []) {
      if (item.qdn && item.qdn.includes('.')) {
        addDomain(item.qdn, 'inboxes');
        addedInboxes++;
      }
    }
  }
  if (addedInboxes === 0) {
    for (const d of INBOXES_FALLBACK_DOMAINS) {
      addDomain(d, 'inboxes');
    }
  }

  return domains;
}

/**
 * Picks a reliable default OTP domain:
 * 1. Private Cloudflare Email Routing domain (if configured)
 * 2. Fresh rotating Mail.tm or un-throttled TempMail.plus domains
 * 3. Remaining domains as fallback
 */
function pickPreferredOtpDomain(domains: DomainInfo[]): DomainInfo {
  const custom = domains.filter((d) => d.provider === 'cloudflare_email');
  if (custom.length > 0) {
    return custom[Math.floor(Math.random() * custom.length)];
  }
  const primary = domains.filter((d) => d.provider === 'mailtm' || d.provider === 'tempmail_plus');
  if (primary.length > 0) {
    return primary[Math.floor(Math.random() * primary.length)];
  }
  return (
    domains[Math.floor(Math.random() * Math.max(1, domains.length))] ?? {
      domain: 'mailto.plus',
      provider: 'tempmail_plus',
      active: true,
    }
  );
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

function parseLooseDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const isoCandidate = raw.replace(' ', 'T') + 'Z';
  const parsedIso = Date.parse(isoCandidate);
  if (!Number.isNaN(parsedIso)) return new Date(parsedIso).toISOString();
  return new Date().toISOString();
}

function toPublicMailbox(
  mb: PersistedMailboxRecord,
  remoteCount = 0,
  remoteUnread = 0
): Mailbox {
  return {
    id: mb.i,
    address: mb.a,
    username: mb.u,
    domain: mb.d,
    provider: mb.p,
    createdAt: mb.c,
    messageCount: remoteCount,
    unreadCount: remoteUnread,
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

function sanitizeLolPrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  return clean.length >= 2 ? clean : undefined;
}

async function createTempMailLolAccount(
  prefix?: string
): Promise<{ address: string; token: string }> {
  const cleanPrefix = sanitizeLolPrefix(prefix);
  const attempts: Array<Record<string, unknown>> = [
    { community: true, ...(cleanPrefix ? { prefix: cleanPrefix } : {}) },
    { ...(cleanPrefix ? { prefix: cleanPrefix } : {}) },
  ];

  let lastErr: unknown;
  for (const payload of attempts) {
    try {
      const data = await fetchJson<{ address?: string; token?: string }>(
        `${TEMPMAIL_LOL_API}/inbox/create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      if (data.address && data.token) {
        return { address: data.address.toLowerCase(), token: data.token };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('TempMail.lol did not return an inbox');
}

async function fetchTempMailPlusDetail(
  address: string,
  mailboxId: string,
  rawMailId: string,
  isRead: boolean
): Promise<EmailDetail | null> {
  try {
    const data = await fetchJson<{
      result?: boolean;
      mail_id?: number | string;
      from?: string;
      from_mail?: string;
      from_name?: string;
      to?: string;
      subject?: string;
      date?: string;
      text?: string;
      html?: string;
      message_id?: string;
    }>(`${TEMPMAIL_PLUS_API}/${encodeURIComponent(rawMailId)}?email=${encodeURIComponent(address)}&epin=`);

    if (!data || data.result === false) return null;

    const subject = data.subject || '(Không có tiêu đề)';
    const htmlBody = sanitizeEmailHtml(data.html || '');
    const textBody = data.text || stripHtmlToText(htmlBody);
    const fromAddress = data.from_mail || parseFromHeader(data.from || '').address || 'unknown@sender';
    const fromName =
      data.from_name || parseFromHeader(data.from || '').name || fromAddress.split('@')[0] || 'Người gửi';
    const receivedAt = parseLooseDate(data.date);
    const otpCodes = extractOtpCodes(`${textBody}\n${htmlBody}`, subject);
    const rawSource = [
      `Delivered-To: ${address}`,
      `From: ${data.from || `"${fromName}" <${fromAddress}>`}`,
      `To: <${data.to || address}>`,
      `Date: ${data.date || new Date(receivedAt).toUTCString()}`,
      `Subject: ${subject}`,
      ...(data.message_id ? [`Message-ID: ${data.message_id}`] : []),
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      textBody,
    ].join('\r\n');

    return {
      id: `tmp_${rawMailId}`,
      mailboxId,
      fromName,
      fromAddress,
      toAddress: data.to || address,
      subject,
      snippet: textBody.slice(0, 140),
      receivedAt,
      isRead,
      otpCodes,
      textBody,
      htmlBody,
      rawSource,
    };
  } catch {
    return null;
  }
}

async function fetchInboxesMessageDetail(
  address: string,
  mailboxId: string,
  rawUid: string,
  isRead: boolean
): Promise<EmailDetail | null> {
  try {
    const data = await fetchJson<{
      uid?: string;
      f?: string;
      s?: string;
      cr?: string;
      r?: number;
      html?: string;
      text?: string;
    }>(`${INBOXES_API}/message/${encodeURIComponent(rawUid)}`);

    if (!data || !data.uid) return null;

    const subject = data.s || '(Không có tiêu đề)';
    const htmlBody = sanitizeEmailHtml(data.html || '');
    const textBody = data.text || stripHtmlToText(htmlBody);
    const parsedFrom = parseFromHeader(data.f || 'unknown@sender');
    const receivedAt = data.cr
      ? parseLooseDate(data.cr)
      : data.r
        ? new Date(data.r > 1e12 ? data.r : data.r * 1000).toISOString()
        : new Date().toISOString();
    const otpCodes = extractOtpCodes(`${textBody}\n${htmlBody}`, subject);
    const rawSource = [
      `Delivered-To: ${address}`,
      `From: ${data.f || `"${parsedFrom.name}" <${parsedFrom.address}>`}`,
      `To: <${address}>`,
      `Date: ${new Date(receivedAt).toUTCString()}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      textBody,
    ].join('\r\n');

    return {
      id: `inb_${rawUid}`,
      mailboxId,
      fromName: parsedFrom.name,
      fromAddress: parsedFrom.address,
      toAddress: address,
      subject,
      snippet: textBody.replace(/\s+/g, ' ').slice(0, 140),
      receivedAt,
      isRead,
      otpCodes,
      textBody,
      htmlBody,
      rawSource,
    };
  } catch {
    return null;
  }
}

async function fetchRemoteMessages(
  mb: PersistedMailboxRecord,
  env?: CloudflarePagesEnv
): Promise<RemoteFetchResult> {
  if (!mb.l) return { messages: [] };
  const deleted = new Set(mb.del ?? []);
  const read = new Set(mb.rd ?? []);

  if (mb.p === 'cloudflare_email' && env?.MAILBOX_KV) {
    try {
      const rawIndex = await env.MAILBOX_KV.get(`inbox:${mb.a.toLowerCase()}`);
      if (!rawIndex) return { messages: [] };
      const parsed = JSON.parse(rawIndex) as EmailSummary[];
      const filtered = (Array.isArray(parsed) ? parsed : [])
        .filter((m) => Boolean(m?.id) && !deleted.has(m.id))
        .map((m) => ({
          ...m,
          mailboxId: mb.i,
          isRead: m.isRead || read.has(m.id),
          textBody: m.snippet,
          htmlBody: '',
          rawSource: '',
        }));
      return { messages: filtered };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  if (mb.p === 'mailtm' && mb.mt) {
    try {
      const raw = await fetchJson<unknown>(`${MAILTM_API}/messages`, {
        headers: { Authorization: `Bearer ${mb.mt}` },
      });
      const items = extractHydraItems<{
        id: string;
        from?: { name?: string; address?: string };
        to?: Array<{ address?: string }>;
        subject?: string;
        intro?: string;
        createdAt?: string;
        seen?: boolean;
      }>(raw).filter((m) => Boolean(m?.id) && !deleted.has(m.id));

      const summaries: EmailDetail[] = items.map((item) => {
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

      // Enrich at most 2 newest messages without OTP in intro (keep OTP visible even after opening)
      const needsOtpCheck = summaries
        .filter((m) => m.otpCodes.length === 0)
        .slice(0, 2);
      await Promise.all(
        needsOtpCheck.map(async (msg) => {
          try {
            const detail = await fetchJson<{ text?: string; html?: string[] }>(
              `${MAILTM_API}/messages/${encodeURIComponent(msg.id)}`,
              { headers: { Authorization: `Bearer ${mb.mt}` } }
            );
            const htmlStr = Array.isArray(detail.html) ? detail.html.join('\n') : '';
            const fullText = detail.text || stripHtmlToText(htmlStr);
            const detected = extractOtpCodes(`${fullText}\n${htmlStr}`, msg.subject);
            if (detected.length > 0) msg.otpCodes = detected;
            if (!msg.snippet && fullText) msg.snippet = fullText.slice(0, 140);
          } catch {
            // Keep summary as-is
          }
        })
      );

      return { messages: summaries };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  if (mb.p === 'tempmail_plus') {
    try {
      const data = await fetchJson<{
        result?: boolean;
        mail_list?: Array<{
          mail_id: number | string;
          from_mail?: string;
          from_name?: string;
          subject?: string;
          time?: string;
          is_new?: boolean;
        }>;
      }>(`${TEMPMAIL_PLUS_API}?email=${encodeURIComponent(mb.a)}&limit=20&epin=`);

      const list = (data.mail_list ?? []).filter(
        (m) => m.mail_id !== undefined && !deleted.has(`tmp_${m.mail_id}`)
      );

      // Enrich top 3 newest messages in parallel so snippets and OTP codes appear immediately
      const enriched = await Promise.all(
        list.map(async (item, idx) => {
          const rawId = String(item.mail_id);
          const id = `tmp_${rawId}`;
          const isRead = read.has(id) || item.is_new === false;
          if (idx < 3) {
            const detail = await fetchTempMailPlusDetail(mb.a, mb.i, rawId, isRead);
            if (detail) return detail;
          }
          const subject = item.subject || '(Không có tiêu đề)';
          return {
            id,
            mailboxId: mb.i,
            fromName: item.from_name || item.from_mail?.split('@')[0] || 'Người gửi',
            fromAddress: item.from_mail || 'unknown@sender',
            toAddress: mb.a,
            subject,
            snippet: subject,
            receivedAt: parseLooseDate(item.time),
            isRead,
            otpCodes: extractOtpCodes(subject, subject),
            textBody: '',
            htmlBody: '',
            rawSource: '',
          };
        })
      );
      return { messages: enriched };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  if (mb.p === 'inboxes') {
    try {
      const data = await fetchJson<{
        msgs?: Array<{
          uid?: string;
          f?: string;
          s?: string;
          cr?: string;
          r?: number;
          ph?: string;
        }>;
      }>(`${INBOXES_API}/inbox/${encodeURIComponent(mb.a)}`);

      const list = (data.msgs ?? []).filter(
        (m) => Boolean(m.uid) && !deleted.has(`inb_${m.uid}`)
      );

      // Enrich at most 2 newest messages lacking OTP in preview to stay below Inboxes.com rate limit
      let enrichBudget = 2;
      const messages = await Promise.all(
        list.map(async (item) => {
          const rawUid = String(item.uid);
          const id = `inb_${rawUid}`;
          const isRead = read.has(id);
          const parsedFrom = parseFromHeader(item.f || 'unknown@sender');
          const subject = item.s || '(Không có tiêu đề)';
          const snippet = (item.ph || subject).replace(/\s+/g, ' ').slice(0, 140);
          const quickOtps = extractOtpCodes(`${item.ph || ''}\n${subject}`, subject);

          if (quickOtps.length === 0 && enrichBudget > 0) {
            enrichBudget--;
            const detail = await fetchInboxesMessageDetail(mb.a, mb.i, rawUid, isRead);
            if (detail) return detail;
          }

          const receivedAt = item.cr
            ? parseLooseDate(item.cr)
            : item.r
              ? new Date(item.r > 1e12 ? item.r : item.r * 1000).toISOString()
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
            isRead,
            otpCodes: quickOtps,
            textBody: item.ph || '',
            htmlBody: '',
            rawSource: '',
          };
        })
      );
      return { messages };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  if (mb.p === 'tempmail_lol' && mb.lt) {
    try {
      const data = await fetchJson<{
        expired?: boolean;
        emails?: Array<{
          from?: string;
          to?: string;
          subject?: string;
          body?: string;
          html?: string;
          date?: number;
        }>;
      }>(`${TEMPMAIL_LOL_API}/inbox?token=${encodeURIComponent(mb.lt)}`);

      if (data.expired === true) {
        return {
          messages: [],
          syncError: 'Hộp thư xoay vòng này đã hết hạn (sau 1 giờ) — hãy bấm "Tạo email" để lấy địa chỉ sạch mới.',
        };
      }

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
      return { messages: mapped.filter((m) => !deleted.has(m.id)) };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  return { messages: [] };
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

  const pathname = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const segments = pathname ? pathname.split('/').map(decodeURIComponent) : [];

  try {
    // 0. GET /api/health
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      return jsonResponse({
        ok: true,
        runtime: 'cloudflare-workers',
        customDomains: getConfiguredCustomDomains(env),
      });
    }

    // 1. GET /api/domains
    if (method === 'GET' && segments.length === 1 && segments[0] === 'domains') {
      const domains = await fetchLiveDomains(env);
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

      const customDomains = getConfiguredCustomDomains(env);
      if (customDomains.length > 0) {
        const username = generateFakerUsername();
        const domain = customDomains[Math.floor(Math.random() * customDomains.length)];
        const payload: GeneratedEmailPreview = {
          address: `${username}@${domain}`,
          username,
          domain,
          provider: 'cloudflare_email',
        };
        return jsonResponse(payload);
      }

      // Default: fresh rotating community domain (un-blacklisted for strict OTP providers like Grok/xAI)
      try {
        const tml = await createTempMailLolAccount();
        const [username, domain] = tml.address.split('@');
        const pendingId = `pre_${randomHex(8)}`;
        const pendingRecord: PendingPreviewRecord = {
          id: pendingId,
          address: tml.address,
          username,
          domain,
          provider: 'tempmail_lol',
          token: tml.token,
          createdAt: Date.now(),
        };
        const encryptedPending = await encryptCookiePayload(pendingRecord, secret);
        const pendingCookie = buildCookieHeader(PENDING_COOKIE_NAME, encryptedPending, 900, isHttps);
        const payload: GeneratedEmailPreview = {
          address: tml.address,
          username,
          domain,
          provider: 'tempmail_lol',
          pregeneratedToken: pendingId,
        };
        return jsonResponse(payload, 200, [pendingCookie]);
      } catch {
        // Fallback to Mail.tm / TempMail.plus if TempMail.lol create quota is temporarily busy
      }

      const domains = await fetchLiveDomains(env);
      const username = generateFakerUsername();
      const picked = pickPreferredOtpDomain(domains);
      const payload: GeneratedEmailPreview = {
        address: `${username}@${picked.domain}`,
        username,
        domain: picked.domain,
        provider: picked.provider,
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
      const domains = await fetchLiveDomains(env);
      const setCookies: string[] = [];
      let created: PersistedMailboxRecord | null = null;

      // Case A: Pre-generated token if present
      if (body.pregeneratedToken) {
        const rawPending = cookies.get(PENDING_COOKIE_NAME);
        if (rawPending) {
          const pending = await decryptCookiePayload<PendingPreviewRecord>(rawPending, secret);
          if (pending && pending.id === body.pregeneratedToken && pending.token) {
            created = {
              i: `mb_${randomHex(8)}`,
              a: pending.address,
              u: pending.username,
              d: pending.domain,
              p: pending.provider,
              c: new Date().toISOString(),
              l: true,
              lt: pending.provider === 'tempmail_lol' ? pending.token : undefined,
              mt: pending.provider === 'mailtm' ? pending.token : undefined,
              ma: pending.accountId,
            };
            setCookies.push(buildCookieHeader(PENDING_COOKIE_NAME, '', 0, isHttps));
          }
        }
      }

      // Case B: Auto-create clean rotating domain when no explicit domain/full email was chosen
      const customDomains = getConfiguredCustomDomains(env);
      const rawUserText =
        mode === 'email' ? (body.email ?? '').trim() : (body.username ?? '').trim();
      const wantsCleanRotating =
        !created &&
        customDomains.length === 0 &&
        !rawUserText.includes('@') &&
        ((mode === 'email' && !rawUserText) ||
          (mode === 'domain' && (!body.domain || body.domain === 'random')));

      if (wantsCleanRotating) {
        if (rawUserText) {
          const checkPrefix = parseEmailInput(rawUserText, 'example.com');
          if (!checkPrefix.valid) {
            return jsonResponse({ error: checkPrefix.error || 'Username không hợp lệ.' }, 400);
          }
        }
        try {
          const tml = await createTempMailLolAccount(rawUserText || undefined);
          const [tmlUser, tmlDom] = tml.address.split('@');
          created = {
            i: `mb_${randomHex(8)}`,
            a: tml.address,
            u: tmlUser,
            d: tmlDom,
            p: 'tempmail_lol',
            c: new Date().toISOString(),
            l: true,
            lt: tml.token,
          };
        } catch {
          // Fall through seamlessly to Mail.tm / TempMail.plus
        }
      }

      if (!created) {
        const rawInput =
          mode === 'email'
            ? (body.email ?? '').trim() || generateFakerUsername()
            : (body.username ?? '').trim() || generateFakerUsername();

        // Pick a reliable primary OTP domain (Custom CF -> Mail.tm / TempMail.plus -> Inboxes)
        const randomDomain = pickPreferredOtpDomain(domains).domain;

        const fallbackDomain =
          body.domain && body.domain !== 'random' ? body.domain : randomDomain;

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

        // Provider 0: Private Cloudflare Email Routing domain (100% real SMTP delivery, zero blocklist)
        if (domainEntry?.provider === 'cloudflare_email' && env?.MAILBOX_KV) {
          created = {
            i: id,
            a: `${username}@${requestedDomain}`,
            u: username,
            d: requestedDomain,
            p: 'cloudflare_email',
            c: new Date().toISOString(),
            l: true,
          };
        }

        // Provider 1: Mail.tm (clean 2-level rotating .com domain)
        if (!created && domainEntry?.provider === 'mailtm') {
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

        // Provider 2: Inboxes.com (18+ clean 2-level .com domains, stateless across Cloudflare Edge)
        if (!created && domainEntry?.provider === 'inboxes') {
          const candidateAddr = `${username}@${requestedDomain}`;
          try {
            const check = await fetchJson<{ msgs?: unknown[] }>(
              `${INBOXES_API}/inbox/${encodeURIComponent(candidateAddr)}`
            );
            if (check && Array.isArray(check.msgs)) {
              created = {
                i: id,
                a: candidateAddr,
                u: username,
                d: requestedDomain,
                p: 'inboxes',
                c: new Date().toISOString(),
                l: true,
              };
            }
          } catch {
            // Fall through to TempMail.plus
          }
        }

        // Provider 3: TempMail.plus (7 clean 2-level domains, stateless across all Edge IPs)
        if (!created) {
          const targetPlusDomain = TEMPMAIL_PLUS_DOMAINS.includes(requestedDomain)
            ? requestedDomain
            : TEMPMAIL_PLUS_DOMAINS[Math.floor(Math.random() * TEMPMAIL_PLUS_DOMAINS.length)];
          const candidateAddr = `${username}@${targetPlusDomain}`;
          try {
            const check = await fetchJson<{ result?: boolean }>(
              `${TEMPMAIL_PLUS_API}?email=${encodeURIComponent(candidateAddr)}&limit=1&epin=`
            );
            if (check?.result !== false) {
              created = {
                i: id,
                a: candidateAddr,
                u: username,
                d: targetPlusDomain,
                p: 'tempmail_plus',
                c: new Date().toISOString(),
                l: true,
              };
            }
          } catch {
            // Fall through to Inboxes.com fallback if not tried yet
          }
        }

        // Provider 3b: Inboxes.com fallback when Mail.tm / TempMail.plus are unavailable
        if (!created) {
          const fallbackInboxes =
            domains.find((d) => d.provider === 'inboxes')?.domain || INBOXES_FALLBACK_DOMAINS[0];
          const candidateAddr = `${username}@${fallbackInboxes}`;
          try {
            const check = await fetchJson<{ msgs?: unknown[] }>(
              `${INBOXES_API}/inbox/${encodeURIComponent(candidateAddr)}`
            );
            if (check && Array.isArray(check.msgs)) {
              created = {
                i: id,
                a: candidateAddr,
                u: username,
                d: fallbackInboxes,
                p: 'inboxes',
                c: new Date().toISOString(),
                l: true,
              };
            }
          } catch {
            // Fall through to TempMail.lol backup
          }
        }

        // Provider 4: TempMail.lol backup (token-authenticated)
        if (!created) {
          try {
            const tml = await createTempMailLolAccount();
            const [tmlUser, tmlDom] = tml.address.split('@');
            created = {
              i: id,
              a: tml.address,
              u: tmlUser,
              d: tmlDom,
              p: 'tempmail_lol',
              c: new Date().toISOString(),
              l: true,
              lt: tml.token,
            };
          } catch {
            return jsonResponse(
              { error: 'Không thể kết nối máy chủ nhận email thực lúc này. Vui lòng thử lại sau giây lát.' },
              502
            );
          }
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

      const { messages: remoteMessages, syncError, rateLimited } = await fetchRemoteMessages(
        mb,
        env
      );
      const remoteUnread = remoteMessages.filter((m) => !m.isRead).length;
      const sorted = remoteMessages.sort(
        (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
      );

      return jsonResponse({
        mailbox: toPublicMailbox(mb, sorted.length, remoteUnread),
        messages: sorted.map(toSummary),
        ...(syncError ? { syncError, rateLimited: Boolean(rateLimited) } : {}),
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

      // Cloudflare Email Routing (KV-backed custom domain) detail
      if (mb.p === 'cloudflare_email' && env?.MAILBOX_KV) {
        const rawMsg = await env.MAILBOX_KV.get(`msg:${mb.a.toLowerCase()}:${messageId}`);
        if (rawMsg) {
          try {
            const parsed = JSON.parse(rawMsg) as EmailDetail;
            const setCookies = await markReadAndPersist();
            return jsonResponse(
              { message: { ...parsed, mailboxId: mb.i, isRead: true } },
              200,
              setCookies
            );
          } catch {
            // Fall through
          }
        }
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

      // TempMail.plus detail
      if (mb.p === 'tempmail_plus' && messageId.startsWith('tmp_')) {
        const rawMailId = messageId.slice(4);
        const detail = await fetchTempMailPlusDetail(mb.a, mb.i, rawMailId, true);
        if (detail) {
          const setCookies = await markReadAndPersist();
          return jsonResponse({ message: detail }, 200, setCookies);
        }
      }

      // Inboxes.com detail
      if (mb.p === 'inboxes' && messageId.startsWith('inb_')) {
        const rawUid = messageId.slice(4);
        const detail = await fetchInboxesMessageDetail(mb.a, mb.i, rawUid, true);
        if (detail) {
          const setCookies = await markReadAndPersist();
          return jsonResponse({ message: detail }, 200, setCookies);
        }
      }

      // TempMail.lol detail
      if (mb.p === 'tempmail_lol' && mb.lt) {
        const { messages: all } = await fetchRemoteMessages(mb, env);
        const hit = all.find((m) => m.id === messageId);
        if (hit) {
          const setCookies = await markReadAndPersist();
          return jsonResponse({ message: { ...hit, isRead: true } }, 200, setCookies);
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

      if (mb.p === 'mailtm' && mb.mt) {
        fetch(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${mb.mt}` },
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      } else if (mb.p === 'tempmail_plus' && messageId.startsWith('tmp_')) {
        const rawMailId = messageId.slice(4);
        fetch(
          `${TEMPMAIL_PLUS_API}/${encodeURIComponent(rawMailId)}?email=${encodeURIComponent(mb.a)}&epin=`,
          { method: 'DELETE', signal: AbortSignal.timeout(4000) }
        ).catch(() => {});
      } else if (mb.p === 'inboxes' && messageId.startsWith('inb_')) {
        const rawUid = messageId.slice(4);
        fetch(`${INBOXES_API}/message/${encodeURIComponent(rawUid)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      }

      const updatedCookie = await persistMailboxCookie(mb, secret, isHttps);
      return jsonResponse({ deleted: true, messageId }, 200, [updatedCookie]);
    }

    return jsonResponse({ error: 'API endpoint không tồn tại.' }, 404);
  } catch {
    return jsonResponse({ error: 'Đã xảy ra lỗi trên máy chủ.' }, 500);
  }
}
