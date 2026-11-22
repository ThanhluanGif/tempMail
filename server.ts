import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

type MailProvider = 'cloudflare_email' | 'mailtm' | 'tempmail_plus' | 'inboxes' | 'tempmail_lol';

interface DomainInfo {
  domain: string;
  provider: MailProvider;
  active: boolean;
}

interface Mailbox {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  createdAt: string;
  messageCount: number;
  unreadCount: number;
  isLive: boolean;
}

interface EmailSummary {
  id: string;
  mailboxId: string;
  fromName: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  otpCodes: string[];
}

interface EmailDetail extends EmailSummary {
  textBody: string;
  htmlBody: string;
  rawSource: string;
}

interface CreateMailboxPayload {
  mode: 'domain' | 'email';
  username?: string;
  domain?: string;
  email?: string;
  pregeneratedToken?: string;
}

interface GeneratedEmailPreview {
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  pregeneratedToken?: string;
}

interface ParsedEmailInput {
  valid: boolean;
  username?: string;
  domain?: string;
  error?: string;
}

function parseValidPort(value: string | undefined): number | null {
  if (!value) return null;
  const num = Number(value);
  if (Number.isInteger(num) && num > 0 && num < 65536) return num;
  return null;
}

function resolveServerPort(
  argv: string[],
  env: Record<string, string | undefined>
): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const cliPort = parseValidPort(argv[i + 1]);
      if (cliPort !== null) return cliPort;
    } else if (arg.startsWith('--port=')) {
      const cliPort = parseValidPort(arg.slice('--port='.length));
      if (cliPort !== null) return cliPort;
    }
  }

  const envPort = parseValidPort(env.PORT);
  const nginxPort = parseValidPort(env.NGINX_PORT);
  const defaultAppPort = parseValidPort(env.DEFAULT_APP_PORT);

  if (nginxPort !== null && (envPort === null || envPort === nginxPort)) {
    return defaultAppPort ?? 3000;
  }

  if (envPort !== null) {
    return envPort;
  }

  return defaultAppPort ?? 3000;
}

function shouldServeStaticDist(input: {
  execArgv: string[];
  env: Record<string, string | undefined>;
  hasBuiltDist: boolean;
}): boolean {
  if (!input.hasBuiltDist) return false;
  if (input.env.NODE_ENV === 'production') return true;
  if (input.env.npm_lifecycle_event === 'start') return true;

  const isTsxRuntime = input.execArgv.some((arg) => arg.includes('tsx'));
  const isDevLifecycle = input.env.npm_lifecycle_event === 'dev';
  if (isDevLifecycle || isTsxRuntime) return false;

  return true;
}

const ADJECTIVES = [
  'minh', 'linh', 'khang', 'vayi', 'nora', 'tuan', 'huy', 'anh', 'vy', 'khoa',
  'thao', 'nam', 'son', 'mai', 'bao', 'duc', 'quang', 'ha', 'phuc', 'ngoc',
];
const NOUNS = [
  'xaf', 'nova', 'mail', 'cloud', 'box', 'dev', 'tech', 'sky', 'zen', 'wave',
  'arc', 'flux', 'mint', 'spark', 'core', 'line', 'leaf', 'star', 'rio', 'neo',
];
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/i;
const FULL_EMAIL_RE = /^([a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?)@([a-z0-9.-]+\.[a-z]{2,})$/i;

function generateFakerUsername(): string {
  const partA = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const partB = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const digits = Math.floor(100 + Math.random() * 900);
  return `${partA}${partB}${digits}`.toLowerCase();
}

function parseEmailInput(rawInput: string, selectedDomain?: string): ParsedEmailInput {
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, error: 'Vui lòng nhập username hoặc bấm tạo ngẫu nhiên.' };
  }
  if (trimmed.includes('@')) {
    const match = trimmed.match(FULL_EMAIL_RE);
    if (!match) {
      return { valid: false, error: 'Địa chỉ email không hợp lệ. Vui lòng kiểm tra lại định dạng.' };
    }
    return { valid: true, username: match[1], domain: match[2] };
  }
  if (trimmed.length < 3) {
    return { valid: false, error: 'Username phải có ít nhất 3 ký tự.' };
  }
  if (!USERNAME_RE.test(trimmed)) {
    return {
      valid: false,
      error: 'Username chỉ được chứa chữ cái, chữ số, dấu chấm, gạch dưới hoặc gạch ngang.',
    };
  }
  if (!selectedDomain) {
    return { valid: false, error: 'Vui lòng chọn một tên miền hợp lệ.' };
  }
  return { valid: true, username: trimmed, domain: selectedDomain.trim().toLowerCase() };
}

function stripHtmlToText(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/td|\/th)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function collapseHtmlDigitBoxes(raw: string): string {
  if (!raw || !raw.includes('<')) return raw;
  return raw.replace(
    /(<(?:td|th|span|div|b|strong|p)\b[^>]*>\s*[0-9]\s*<\/(?:td|th|span|div|b|strong|p)>\s*){4,8}/gi,
    (block) => {
      const digits = block.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
      return /^\d{4,8}$/.test(digits) ? `\n${digits}\n` : block;
    }
  );
}

function isLikelyOtp(code: string): boolean {
  if (!code) return false;
  if (/^[A-Z]{1,2}-\d{4,8}$/.test(code)) return true;
  if (/^(?:19|20)\d{2}$/.test(code)) return false;
  if (code.length <= 4 && /^(\d)\1+$/.test(code)) return false;
  if (/^[A-Za-z]+$/.test(code) || /[a-z]/.test(code)) return false;
  return code.length >= 4 && code.length <= 10;
}

function extractOtpCodes(content: string, subject = ''): string[] {
  const normalizedHtml = collapseHtmlDigitBoxes(content);
  const plainBody = stripHtmlToText(normalizedHtml);
  const cleanSubject = stripHtmlToText(subject);
  const combined = `${cleanSubject}\n${plainBody}`;
  const candidates = new Set<string>();

  const stripNoise = (text: string) =>
    text
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')
      .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
      .replace(/\b\d+(?:\.\d+)?(?:px|pt|em|rem|vh|vw|%)\b/gi, ' ')
      .replace(/\b(?:CA|NY|TX|FL|WA|IL|MA|NJ|PA|OH|GA|NC|MI|VA|CO|AZ)\s+\d{5}(?:-\d{4})?\b/g, ' ')
      .replace(/\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g, ' ');

  const cleaned = stripNoise(combined);
  const cleanedSubject = stripNoise(cleanSubject);

  const addCandidate = (rawCode: string) => {
    const trimmed = rawCode.trim();
    if (!trimmed) return;
    const normalized = /^[A-Z]{1,3}-\d{4,8}$/.test(trimmed)
      ? trimmed
      : trimmed.replace(/[\s-]+/g, '');
    if (isLikelyOtp(normalized)) candidates.add(normalized);
  };

  const prefixedRe = /\b([A-Z]{1,2}-\d{4,8})\b/g;
  let match: RegExpExecArray | null;
  while ((match = prefixedRe.exec(cleaned)) !== null) {
    addCandidate(match[1]);
  }

  const otpKeyword =
    '(?:' +
    'mã\\s*(?:xác\\s*nhận|xác\\s*minh|xác\\s*thực|bảo\\s*mật|otp|đăng\\s*nhập|kích\\s*hoạt|khôi\\s*phục|dùng\\s*một\\s*lần|đặt\\s*lại(?:\\s*mật\\s*khẩu)?)|' +
    'verification\\s*code|confirmation\\s*code|security\\s*code|auth(?:entication)?\\s*code|' +
    'passcode|one-time\\s*(?:pass)?code|login\\s*code|sign[- ]?in\\s*code|verify\\s*code|access\\s*code|recovery\\s*code|pin\\s*code|2fa\\s*code|otp|' +
    'your\\s+code|the\\s+code|enter\\s+(?:the\\s+)?code|use\\s+(?:the\\s+)?code|nhập\\s+mã|' +
    '验证码|動態密碼|动态密码|認証コード|確認コード|인증\\s*번호|인증\\s*코드|código\\s+de\\s+verificación|code\\s+de\\s+vérification|bestätigungscode|код\\s+подтверждения|kode\\s+verifikasi|รหัสยืนยัน' +
    ')';

  const contextualAfterRe = new RegExp(
    `(?:${otpKeyword})\\s*(?:là|của\\s*bạn\\s*(?:là)?|is|của\\s*bạn|:|：|-|–|\\s)*\\s*((?:\\d{4,8})|(?:\\d{3}[\\s-]\\d{3})|(?:\\d{2}[\\s-]\\d{2}[\\s-]\\d{2})|(?:\\d{4}[\\s-]\\d{4})|(?:(?=[A-Z0-9]{5,8}\\b)(?=[A-Z0-9]*\\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8}))\\b`,
    'gi'
  );
  while ((match = contextualAfterRe.exec(cleaned)) !== null) {
    addCandidate(match[1]);
  }

  const contextualBeforeRe =
    /\b((?:\d{4,8})|(?:\d{3}[\s-]\d{3})|(?:\d{4}[\s-]\d{4}))\s+(?:là\s+mã|is\s+your\s+(?:[a-z]+\s+)?(?:verification|confirmation|security|login|sign[- ]?in|otp|one-time)?\s*code|to\s+verify|để\s+xác\s*(?:nhận|minh|thực))/gi;
  while ((match = contextualBeforeRe.exec(cleaned)) !== null) {
    addCandidate(match[1]);
  }

  if (candidates.size === 0 && cleanedSubject) {
    const subjectCodeRe = /\b((?:\d{4,8})|(?:\d{3}[\s-]\d{3}))\b/g;
    while ((match = subjectCodeRe.exec(cleanedSubject)) !== null) {
      addCandidate(match[1]);
    }
  }

  const hasVerificationContext =
    /(?:\botp\b|xác\s*nhận|xác\s*minh|xác\s*thực|\bverify\b|\bverification\b|\bconfirm(?:ation)?\b|\bpasscode\b|mã\s*(?:otp|xác|bảo|đăng)|\bpin\b|\btoken\b|验证|認証|인증)/i.test(
      cleaned
    );

  if (candidates.size === 0) {
    const lines = cleaned.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (
        /^(?:(?:\d{5,8})|(?:\d{3}[\s-]\d{3})|(?:\d{2}[\s-]\d{2}[\s-]\d{2})|(?:\d{4}[\s-]\d{4})|(?:\d(?:\s+\d){4,7}))$/.test(
          t
        ) ||
        (hasVerificationContext && /^(?:\d{4}|\d(?:\s+\d){3})$/.test(t))
      ) {
        addCandidate(t);
      }
    }
  }

  if (
    candidates.size === 0 &&
    (hasVerificationContext || /(?:\bcode\b|\bmã\b)/i.test(cleaned))
  ) {
    const standaloneRegex = /\b(\d{6}|\d{5}|\d{4}|\d{8})\b/g;
    while ((match = standaloneRegex.exec(cleaned)) !== null) {
      addCandidate(match[1]);
    }
  }

  return Array.from(candidates);
}

function sanitizeEmailHtml(rawHtml: string): string {
  if (!rawHtml) return '';
  let html = rawHtml;
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<object[\s\S]*?<\/object>/gi, '');
  html = html.replace(/<embed[\s\S]*?>/gi, '');
  html = html.replace(/<\/?form\b[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
  html = html.replace(/<base[^>]*>/gi, '');
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(
    /\b(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data):[\s\S]*?\2/gi,
    '$1=$2#$2'
  );
  html = html.replace(
    /\b(href|src)\s*=\s*(?:javascript|vbscript|data):[^\s>]+/gi,
    '$1="#"'
  );
  return html;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = resolveServerPort(process.argv, process.env);
const DIST_DIR = path.resolve(__dirname, 'dist');
const HAS_BUILT_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));
const SERVE_STATIC_DIST = shouldServeStaticDist({
  execArgv: process.execArgv,
  env: process.env,
  hasBuiltDist: HAS_BUILT_DIST,
});
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

interface RemoteFetchResult {
  messages: EmailDetail[];
  syncError?: string;
  rateLimited?: boolean;
}

interface StoredMailbox {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  createdAt: string;
  isLive: boolean;
  mailtmAccountId?: string;
  mailtmToken?: string;
  tempmailLolToken?: string;
  deletedMessageIds: Set<string>;
  readMessageIds: Set<string>;
  detailCache: Map<string, EmailDetail>;
  lastKnownRemoteCount: number;
  lastKnownRemoteUnread: number;
}

interface PendingPreview {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  token: string;
  createdAt: number;
}

const mailboxes = new Map<string, StoredMailbox>();
const pendingPreviews = new Map<string, PendingPreview>();
let cachedDomains: DomainInfo[] = [];
let domainsFetchedAt = 0;
const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000;
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{2,128}$/;

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

function pickPreferredOtpDomain(domains: DomainInfo[]): DomainInfo {
  const fallback: DomainInfo = {
    domain: 'mailto.plus',
    provider: 'tempmail_plus',
    active: true,
  };
  if (domains.length === 0) return fallback;

  const custom = domains.filter((d) => d.provider === 'cloudflare_email');
  if (custom.length > 0) {
    return custom[Math.floor(Math.random() * custom.length)];
  }

  const preferred = domains.filter(
    (d) => d.provider === 'mailtm' || d.provider === 'tempmail_plus'
  );
  if (preferred.length > 0) {
    return preferred[Math.floor(Math.random() * preferred.length)];
  }

  return domains[Math.floor(Math.random() * domains.length)] ?? fallback;
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

async function fetchLiveDomains(forceRefresh = false): Promise<DomainInfo[]> {
  const now = Date.now();
  if (!forceRefresh && cachedDomains.length > 0 && now - domainsFetchedAt < DOMAIN_CACHE_TTL_MS) {
    return cachedDomains;
  }

  const domains: DomainInfo[] = [];
  const seen = new Set<string>();
  const addDomain = (domain: string, provider: MailProvider) => {
    const clean = domain.trim().toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    domains.push({ domain: clean, provider, active: true });
  };

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

  cachedDomains = domains;
  domainsFetchedAt = now;
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

function parseLooseDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const isoCandidate = raw.replace(' ', 'T') + 'Z';
  const parsedIso = Date.parse(isoCandidate);
  if (!Number.isNaN(parsedIso)) return new Date(parsedIso).toISOString();
  return new Date().toISOString();
}

function toPublicMailbox(mb: StoredMailbox): Mailbox {
  return {
    id: mb.id,
    address: mb.address,
    username: mb.username,
    domain: mb.domain,
    provider: mb.provider,
    createdAt: mb.createdAt,
    messageCount: mb.lastKnownRemoteCount,
    unreadCount: mb.lastKnownRemoteUnread,
    isLive: mb.isLive,
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
  const password = crypto.randomBytes(16).toString('hex');
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

async function fetchRemoteMessages(mb: StoredMailbox): Promise<RemoteFetchResult> {
  if (!mb.isLive) return { messages: [] };

  if (mb.provider === 'mailtm' && mb.mailtmToken) {
    try {
      const raw = await fetchJson<unknown>(`${MAILTM_API}/messages`, {
        headers: { Authorization: `Bearer ${mb.mailtmToken}` },
      });
      const items = extractHydraItems<{
        id: string;
        from?: { name?: string; address?: string };
        to?: Array<{ address?: string }>;
        subject?: string;
        intro?: string;
        createdAt?: string;
        seen?: boolean;
      }>(raw).filter((m) => Boolean(m?.id) && !mb.deletedMessageIds.has(m.id));

      const summaries: EmailDetail[] = items.map((item) => {
        const cached = mb.detailCache.get(item.id);
        const isRead = Boolean(item.seen) || mb.readMessageIds.has(item.id);
        if (cached) {
          return { ...cached, isRead };
        }
        const subject = item.subject || '(Không có tiêu đề)';
        const snippet = item.intro || '';
        return {
          id: item.id,
          mailboxId: mb.id,
          fromName: item.from?.name || item.from?.address?.split('@')[0] || 'Người gửi',
          fromAddress: item.from?.address || 'unknown@sender',
          toAddress: item.to?.[0]?.address || mb.address,
          subject,
          snippet,
          receivedAt: item.createdAt || new Date().toISOString(),
          isRead,
          otpCodes: extractOtpCodes(snippet, subject),
          textBody: snippet,
          htmlBody: '',
          rawSource: '',
        };
      });

      const needsOtpCheck = summaries
        .filter((m) => !mb.detailCache.has(m.id) && m.otpCodes.length === 0)
        .slice(0, 2);
      await Promise.all(
        needsOtpCheck.map(async (msg) => {
          try {
            const detail = await fetchJson<{ text?: string; html?: string[] }>(
              `${MAILTM_API}/messages/${encodeURIComponent(msg.id)}`,
              { headers: { Authorization: `Bearer ${mb.mailtmToken}` } }
            );
            const rawHtml = Array.isArray(detail.html) ? detail.html.join('\n') : '';
            const htmlBody = sanitizeEmailHtml(rawHtml);
            const fullText = detail.text || stripHtmlToText(htmlBody);
            const detected = extractOtpCodes(`${fullText}\n${htmlBody}`, msg.subject);
            if (detected.length > 0) msg.otpCodes = detected;
            if (!msg.snippet && fullText) msg.snippet = fullText.slice(0, 140);
            msg.textBody = fullText;
            msg.htmlBody = htmlBody;
            mb.detailCache.set(msg.id, { ...msg });
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

  if (mb.provider === 'tempmail_plus') {
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
      }>(`${TEMPMAIL_PLUS_API}?email=${encodeURIComponent(mb.address)}&limit=20&epin=`);

      const list = (data.mail_list ?? []).filter(
        (m) => m.mail_id !== undefined && !mb.deletedMessageIds.has(`tmp_${m.mail_id}`)
      );

      let uncachedFetches = 0;
      const messages = await Promise.all(
        list.map(async (item) => {
          const rawId = String(item.mail_id);
          const id = `tmp_${rawId}`;
          const isRead = mb.readMessageIds.has(id) || item.is_new === false;
          const cached = mb.detailCache.get(id);
          if (cached) {
            return { ...cached, isRead };
          }
          if (uncachedFetches < 3) {
            uncachedFetches++;
            const detail = await fetchTempMailPlusDetail(mb.address, mb.id, rawId, isRead);
            if (detail) {
              mb.detailCache.set(id, detail);
              return detail;
            }
          }
          const subject = item.subject || '(Không có tiêu đề)';
          return {
            id,
            mailboxId: mb.id,
            fromName: item.from_name || item.from_mail?.split('@')[0] || 'Người gửi',
            fromAddress: item.from_mail || 'unknown@sender',
            toAddress: mb.address,
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

      return { messages };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  if (mb.provider === 'inboxes') {
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
      }>(`${INBOXES_API}/inbox/${encodeURIComponent(mb.address)}`);

      const list = (data.msgs ?? []).filter(
        (m) => Boolean(m.uid) && !mb.deletedMessageIds.has(`inb_${m.uid}`)
      );

      let uncachedFetches = 0;
      const messages = await Promise.all(
        list.map(async (item) => {
          const rawUid = String(item.uid);
          const id = `inb_${rawUid}`;
          const isRead = mb.readMessageIds.has(id);
          const cached = mb.detailCache.get(id);
          if (cached) {
            return { ...cached, isRead };
          }
          const parsedFrom = parseFromHeader(item.f || 'unknown@sender');
          const subject = item.s || '(Không có tiêu đề)';
          const snippet = (item.ph || subject).replace(/\s+/g, ' ').slice(0, 140);
          const inlineOtp = extractOtpCodes(`${snippet}\n${subject}`, subject);
          if (inlineOtp.length === 0 && uncachedFetches < 2) {
            uncachedFetches++;
            const detail = await fetchInboxesMessageDetail(mb.address, mb.id, rawUid, isRead);
            if (detail) {
              mb.detailCache.set(id, detail);
              return detail;
            }
          }
          const receivedAt = item.cr
            ? parseLooseDate(item.cr)
            : item.r
              ? new Date(item.r > 1e12 ? item.r : item.r * 1000).toISOString()
              : new Date().toISOString();
          return {
            id,
            mailboxId: mb.id,
            fromName: parsedFrom.name,
            fromAddress: parsedFrom.address,
            toAddress: mb.address,
            subject,
            snippet,
            receivedAt,
            isRead,
            otpCodes: inlineOtp,
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

  if (mb.provider === 'tempmail_lol' && mb.tempmailLolToken) {
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
      }>(`${TEMPMAIL_LOL_API}/inbox?token=${encodeURIComponent(mb.tempmailLolToken)}`);

      if (data.expired === true) {
        return {
          messages: [],
          syncError:
            'Hộp thư xoay vòng này đã hết hạn (sau 1 giờ) — hãy bấm "Tạo email" để lấy địa chỉ sạch mới.',
        };
      }

      const messages = (data.emails ?? [])
        .map((item, idx) => {
          const stableHash = crypto
            .createHash('sha1')
            .update(`${item.from ?? ''}|${item.subject ?? ''}|${item.date ?? idx}`)
            .digest('hex')
            .slice(0, 16);
          const id = `tml_${stableHash}`;
          const fromRaw = item.from || 'unknown@sender';
          const parsedFrom = parseFromHeader(fromRaw);
          const subject = item.subject || '(Không có tiêu đề)';
          const textBody = item.body || stripHtmlToText(item.html || '');
          const htmlBody = sanitizeEmailHtml(item.html || '');
          const receivedAt = item.date
            ? new Date(item.date > 1e12 ? item.date : item.date * 1000).toISOString()
            : new Date().toISOString();
          const rawSource = [
            `Delivered-To: ${mb.address}`,
            `From: ${fromRaw}`,
            `To: <${item.to || mb.address}>`,
            `Date: ${new Date(receivedAt).toUTCString()}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset="UTF-8"`,
            ``,
            textBody,
          ].join('\r\n');

          return {
            id,
            mailboxId: mb.id,
            fromName: parsedFrom.name,
            fromAddress: parsedFrom.address,
            toAddress: item.to || mb.address,
            subject,
            snippet: textBody.slice(0, 140),
            receivedAt,
            isRead: mb.readMessageIds.has(id),
            otpCodes: extractOtpCodes(`${textBody}\n${htmlBody}`, subject),
            textBody,
            htmlBody,
            rawSource,
          };
        })
        .filter((m) => !mb.deletedMessageIds.has(m.id));
      return { messages };
    } catch (err) {
      return { messages: [], ...classifyUpstreamError(err) };
    }
  }

  return { messages: [] };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const wrapAsync =
    (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };

  // 1. GET /api/domains
  app.get(
    '/api/domains',
    wrapAsync(async (req, res) => {
      try {
        const force = req.query.refresh === '1';
        const domains = await fetchLiveDomains(force);
        res.json({ domains });
      } catch {
        res.status(502).json({ error: 'Không thể tải danh sách tên miền.' });
      }
    })
  );

  // 2. GET /api/mailboxes
  app.get('/api/mailboxes', (_req, res) => {
    const list = Array.from(mailboxes.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(toPublicMailbox);
    res.json({ mailboxes: list });
  });

  // 3. POST /api/mailboxes/generate
  app.post(
    '/api/mailboxes/generate',
    wrapAsync(async (_req, res) => {
      // Prune stale previews older than 15 minutes
      const cutoff = Date.now() - 15 * 60 * 1000;
      for (const [k, v] of pendingPreviews.entries()) {
        if (v.createdAt < cutoff) pendingPreviews.delete(k);
      }

      // Default: fresh rotating community domain (un-blacklisted for strict OTP providers like Grok/xAI)
      try {
        const tml = await createTempMailLolAccount();
        const [username, domain] = tml.address.split('@');
        const pendingId = `pre_${crypto.randomBytes(8).toString('hex')}`;
        pendingPreviews.set(pendingId, {
          id: pendingId,
          address: tml.address,
          username,
          domain,
          provider: 'tempmail_lol',
          token: tml.token,
          createdAt: Date.now(),
        });
        const payload: GeneratedEmailPreview = {
          address: tml.address,
          username,
          domain,
          provider: 'tempmail_lol',
          pregeneratedToken: pendingId,
        };
        res.json(payload);
        return;
      } catch {
        // Fall back to Mail.tm / TempMail.plus
      }

      const domains = await fetchLiveDomains();
      const username = generateFakerUsername();
      const preferred = pickPreferredOtpDomain(domains);
      const payload: GeneratedEmailPreview = {
        address: `${username}@${preferred.domain}`,
        username,
        domain: preferred.domain,
        provider: preferred.provider,
      };
      res.json(payload);
    })
  );

  // 4. POST /api/mailboxes
  app.post(
    '/api/mailboxes',
    wrapAsync(async (req, res) => {
      const body = (req.body ?? {}) as CreateMailboxPayload;
      const mode = body.mode === 'domain' ? 'domain' : 'email';

      // Case A: Activate a pre-generated clean rotating mailbox
      if (body.pregeneratedToken) {
        const pending = pendingPreviews.get(body.pregeneratedToken);
        if (pending) {
          pendingPreviews.delete(body.pregeneratedToken);
          const id = `mb_${crypto.randomBytes(8).toString('hex')}`;
          const created: StoredMailbox = {
            id,
            address: pending.address,
            username: pending.username,
            domain: pending.domain,
            provider: pending.provider,
            createdAt: new Date().toISOString(),
            isLive: true,
            tempmailLolToken: pending.provider === 'tempmail_lol' ? pending.token : undefined,
            deletedMessageIds: new Set(),
            readMessageIds: new Set(),
            detailCache: new Map(),
            lastKnownRemoteCount: 0,
            lastKnownRemoteUnread: 0,
          };
          mailboxes.set(created.id, created);
          res.status(201).json({ mailbox: toPublicMailbox(created) });
          return;
        }
      }

      // Case B: Auto-create clean rotating domain when no fixed domain/full email was requested
      const rawUserText =
        mode === 'email' ? (body.email ?? '').trim() : (body.username ?? '').trim();
      const wantsCleanRotating =
        !rawUserText.includes('@') &&
        ((mode === 'email' && !rawUserText) ||
          (mode === 'domain' && (!body.domain || body.domain === 'random')));

      if (wantsCleanRotating) {
        if (rawUserText) {
          const checkPrefix = parseEmailInput(rawUserText, 'example.com');
          if (!checkPrefix.valid) {
            res.status(400).json({ error: checkPrefix.error || 'Username không hợp lệ.' });
            return;
          }
        }
        try {
          const tml = await createTempMailLolAccount(rawUserText || undefined);
          const [tmlUser, tmlDom] = tml.address.split('@');
          const id = `mb_${crypto.randomBytes(8).toString('hex')}`;
          const created: StoredMailbox = {
            id,
            address: tml.address,
            username: tmlUser,
            domain: tmlDom,
            provider: 'tempmail_lol',
            createdAt: new Date().toISOString(),
            isLive: true,
            tempmailLolToken: tml.token,
            deletedMessageIds: new Set(),
            readMessageIds: new Set(),
            detailCache: new Map(),
            lastKnownRemoteCount: 0,
            lastKnownRemoteUnread: 0,
          };
          mailboxes.set(created.id, created);
          res.status(201).json({ mailbox: toPublicMailbox(created) });
          return;
        } catch {
          // Fall through seamlessly to Mail.tm / TempMail.plus
        }
      }

      const domains = await fetchLiveDomains();

      const rawInput =
        mode === 'email'
          ? (body.email ?? '').trim() || generateFakerUsername()
          : (body.username ?? '').trim() || generateFakerUsername();

      const randomDomain = pickPreferredOtpDomain(domains).domain;

      const fallbackDomain =
        body.domain && body.domain !== 'random' ? body.domain : randomDomain;

      const parsed = parseEmailInput(rawInput, fallbackDomain);
      if (!parsed.valid || !parsed.username || !parsed.domain) {
        res.status(400).json({ error: parsed.error || 'Dữ liệu email không hợp lệ.' });
        return;
      }

      const username = parsed.username;
      const requestedDomain = parsed.domain;
      const domainEntry = domains.find((d) => d.domain === requestedDomain);

      const existing = Array.from(mailboxes.values()).find(
        (m) => m.address.toLowerCase() === `${username}@${requestedDomain}`.toLowerCase()
      );
      if (existing) {
        res.json({ mailbox: toPublicMailbox(existing) });
        return;
      }

      const id = `mb_${crypto.randomBytes(8).toString('hex')}`;
      const isExplicitMailTm =
        domainEntry?.provider === 'mailtm' &&
        Boolean(body.domain && body.domain !== 'random') &&
        Boolean(body.username?.trim() || body.email?.trim());

      let createdMailbox: StoredMailbox | null = null;

      if (domainEntry?.provider === 'mailtm') {
        try {
          const mt = await createMailTmAccount(username, requestedDomain);
          createdMailbox = {
            id,
            address: mt.address,
            username,
            domain: requestedDomain,
            provider: 'mailtm',
            createdAt: new Date().toISOString(),
            isLive: true,
            mailtmAccountId: mt.accountId,
            mailtmToken: mt.token,
            deletedMessageIds: new Set(),
            readMessageIds: new Set(),
            detailCache: new Map(),
            lastKnownRemoteCount: 0,
            lastKnownRemoteUnread: 0,
          };
        } catch (err) {
          const status = (err as { status?: number })?.status;
          if (status === 422 && isExplicitMailTm) {
            res.status(409).json({
              error: `Địa chỉ ${username}@${requestedDomain} đã được sử dụng. Hãy đổi username khác hoặc chọn tên miền khác.`,
            });
            return;
          }
        }
      }

      if (!createdMailbox && domainEntry?.provider === 'inboxes') {
        const candidateAddr = `${username}@${requestedDomain}`;
        try {
          const check = await fetchJson<{ msgs?: unknown[] }>(
            `${INBOXES_API}/inbox/${encodeURIComponent(candidateAddr)}`
          );
          if (check && Array.isArray(check.msgs)) {
            createdMailbox = {
              id,
              address: candidateAddr,
              username,
              domain: requestedDomain,
              provider: 'inboxes',
              createdAt: new Date().toISOString(),
              isLive: true,
              deletedMessageIds: new Set(),
              readMessageIds: new Set(),
              detailCache: new Map(),
              lastKnownRemoteCount: 0,
              lastKnownRemoteUnread: 0,
            };
          }
        } catch {
          // Fall through to TempMail.plus
        }
      }

      if (!createdMailbox) {
        const targetPlusDomain = TEMPMAIL_PLUS_DOMAINS.includes(requestedDomain)
          ? requestedDomain
          : TEMPMAIL_PLUS_DOMAINS[Math.floor(Math.random() * TEMPMAIL_PLUS_DOMAINS.length)];
        const candidateAddr = `${username}@${targetPlusDomain}`;
        try {
          const check = await fetchJson<{ result?: boolean }>(
            `${TEMPMAIL_PLUS_API}?email=${encodeURIComponent(candidateAddr)}&limit=1&epin=`
          );
          if (check?.result !== false) {
            createdMailbox = {
              id,
              address: candidateAddr,
              username,
              domain: targetPlusDomain,
              provider: 'tempmail_plus',
              createdAt: new Date().toISOString(),
              isLive: true,
              deletedMessageIds: new Set(),
              readMessageIds: new Set(),
              detailCache: new Map(),
              lastKnownRemoteCount: 0,
              lastKnownRemoteUnread: 0,
            };
          }
        } catch {
          // Fall through to Inboxes.com fallback
        }
      }

      if (!createdMailbox) {
        const fallbackInboxes =
          domains.find((d) => d.provider === 'inboxes')?.domain || INBOXES_FALLBACK_DOMAINS[0];
        const candidateAddr = `${username}@${fallbackInboxes}`;
        try {
          const check = await fetchJson<{ msgs?: unknown[] }>(
            `${INBOXES_API}/inbox/${encodeURIComponent(candidateAddr)}`
          );
          if (check && Array.isArray(check.msgs)) {
            createdMailbox = {
              id,
              address: candidateAddr,
              username,
              domain: fallbackInboxes,
              provider: 'inboxes',
              createdAt: new Date().toISOString(),
              isLive: true,
              deletedMessageIds: new Set(),
              readMessageIds: new Set(),
              detailCache: new Map(),
              lastKnownRemoteCount: 0,
              lastKnownRemoteUnread: 0,
            };
          }
        } catch {
          // Fall through to TempMail.lol backup
        }
      }

      if (!createdMailbox) {
        try {
          const tml = await createTempMailLolAccount();
          const [tmlUser, tmlDom] = tml.address.split('@');
          createdMailbox = {
            id,
            address: tml.address,
            username: tmlUser,
            domain: tmlDom,
            provider: 'tempmail_lol',
            createdAt: new Date().toISOString(),
            isLive: true,
            tempmailLolToken: tml.token,
            deletedMessageIds: new Set(),
            readMessageIds: new Set(),
            detailCache: new Map(),
            lastKnownRemoteCount: 0,
            lastKnownRemoteUnread: 0,
          };
        } catch {
          res.status(502).json({
            error: 'Không thể kết nối máy chủ nhận email thực lúc này. Vui lòng thử lại sau giây lát.',
          });
          return;
        }
      }

      mailboxes.set(createdMailbox.id, createdMailbox);
      res.status(201).json({ mailbox: toPublicMailbox(createdMailbox) });
    })
  );

  // 5. DELETE /api/mailboxes/:id
  app.delete(
    '/api/mailboxes/:id',
    wrapAsync(async (req, res) => {
      const id = req.params.id;
      if (!SAFE_ID_RE.test(id)) {
        res.status(400).json({ error: 'ID hộp thư không hợp lệ.' });
        return;
      }
      const mb = mailboxes.get(id);
      if (!mb) {
        res.status(404).json({ error: 'Không tìm thấy hộp thư.' });
        return;
      }

      if (mb.provider === 'mailtm' && mb.mailtmAccountId && mb.mailtmToken) {
        fetch(`${MAILTM_API}/accounts/${encodeURIComponent(mb.mailtmAccountId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${mb.mailtmToken}` },
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      }

      mailboxes.delete(id);
      res.json({ deleted: true, id });
    })
  );

  // 6. GET /api/mailboxes/:id/messages
  app.get(
    '/api/mailboxes/:id/messages',
    wrapAsync(async (req, res) => {
      const id = req.params.id;
      if (!SAFE_ID_RE.test(id)) {
        res.status(400).json({ error: 'ID hộp thư không hợp lệ.' });
        return;
      }
      const mb = mailboxes.get(id);
      if (!mb) {
        res.status(404).json({ error: 'Không tìm thấy hộp thư.' });
        return;
      }

      const { messages: remoteMessages, syncError, rateLimited } = await fetchRemoteMessages(mb);
      if (!syncError) {
        mb.lastKnownRemoteCount = remoteMessages.length;
        mb.lastKnownRemoteUnread = remoteMessages.filter((m) => !m.isRead).length;
      }

      const sorted = remoteMessages.sort(
        (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
      );

      res.json({
        mailbox: toPublicMailbox(mb),
        messages: sorted.map(toSummary),
        ...(syncError ? { syncError, rateLimited } : {}),
      });
    })
  );

  // 7. GET /api/mailboxes/:id/messages/:messageId
  app.get(
    '/api/mailboxes/:id/messages/:messageId',
    wrapAsync(async (req, res) => {
      const { id, messageId } = req.params;
      if (!SAFE_ID_RE.test(id) || !SAFE_ID_RE.test(messageId)) {
        res.status(400).json({ error: 'Tham số không hợp lệ.' });
        return;
      }
      const mb = mailboxes.get(id);
      if (!mb) {
        res.status(404).json({ error: 'Không tìm thấy hộp thư.' });
        return;
      }

      if (mb.provider === 'mailtm' && mb.mailtmToken) {
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
            headers: { Authorization: `Bearer ${mb.mailtmToken}` },
          });

          let rawSource = '';
          try {
            const src = await fetchJson<{ data?: string }>(
              `${MAILTM_API}/sources/${encodeURIComponent(messageId)}`,
              { headers: { Authorization: `Bearer ${mb.mailtmToken}` } }
            );
            rawSource = src.data || '';
          } catch {
            rawSource = '';
          }

          const subject = detail.subject || '(Không có tiêu đề)';
          const rawHtml = Array.isArray(detail.html) ? detail.html.join('\n') : '';
          const htmlBody = sanitizeEmailHtml(rawHtml);
          const textBody = detail.text || stripHtmlToText(htmlBody);
          const otpCodes = extractOtpCodes(`${textBody}\n${htmlBody}`, subject);
          const receivedAt = detail.createdAt || new Date().toISOString();

          if (!rawSource) {
            rawSource = [
              `Delivered-To: ${mb.address}`,
              `From: "${detail.from?.name || ''}" <${detail.from?.address || ''}>`,
              `To: <${detail.to?.[0]?.address || mb.address}>`,
              `Date: ${new Date(receivedAt).toUTCString()}`,
              `Subject: ${subject}`,
              ``,
              textBody,
            ].join('\r\n');
          }

          mb.readMessageIds.add(messageId);
          fetch(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${mb.mailtmToken}`,
              'Content-Type': 'application/merge-patch+json',
            },
            body: JSON.stringify({ seen: true }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});

          const full: EmailDetail = {
            id: detail.id,
            mailboxId: mb.id,
            fromName: detail.from?.name || detail.from?.address?.split('@')[0] || 'Người gửi',
            fromAddress: detail.from?.address || 'unknown@sender',
            toAddress: detail.to?.[0]?.address || mb.address,
            subject,
            snippet: textBody.slice(0, 140),
            receivedAt,
            isRead: true,
            otpCodes,
            textBody,
            htmlBody,
            rawSource,
          };
          res.json({ message: full });
          return;
        } catch {
          res.status(404).json({ error: 'Không thể tải nội dung thư.' });
          return;
        }
      }

      if (mb.provider === 'tempmail_plus' && messageId.startsWith('tmp_')) {
        const cached = mb.detailCache.get(messageId);
        if (cached && cached.rawSource) {
          mb.readMessageIds.add(messageId);
          res.json({ message: { ...cached, isRead: true } });
          return;
        }
        const rawMailId = messageId.slice(4);
        const detail = await fetchTempMailPlusDetail(mb.address, mb.id, rawMailId, true);
        if (detail) {
          mb.readMessageIds.add(messageId);
          mb.detailCache.set(messageId, detail);
          res.json({ message: detail });
          return;
        }
      }

      if (mb.provider === 'inboxes' && messageId.startsWith('inb_')) {
        const cached = mb.detailCache.get(messageId);
        if (cached && cached.rawSource) {
          mb.readMessageIds.add(messageId);
          res.json({ message: { ...cached, isRead: true } });
          return;
        }
        const rawUid = messageId.slice(4);
        const detail = await fetchInboxesMessageDetail(mb.address, mb.id, rawUid, true);
        if (detail) {
          mb.readMessageIds.add(messageId);
          mb.detailCache.set(messageId, detail);
          res.json({ message: detail });
          return;
        }
      }

      if (mb.provider === 'tempmail_lol' && mb.tempmailLolToken) {
        const { messages: all } = await fetchRemoteMessages(mb);
        const hit = all.find((m) => m.id === messageId);
        if (hit) {
          mb.readMessageIds.add(messageId);
          res.json({ message: { ...hit, isRead: true } });
          return;
        }
      }

      res.status(404).json({ error: 'Không tìm thấy thư.' });
    })
  );

  // 8. DELETE /api/mailboxes/:id/messages/:messageId
  app.delete(
    '/api/mailboxes/:id/messages/:messageId',
    wrapAsync(async (req, res) => {
      const { id, messageId } = req.params;
      if (!SAFE_ID_RE.test(id) || !SAFE_ID_RE.test(messageId)) {
        res.status(400).json({ error: 'Tham số không hợp lệ.' });
        return;
      }
      const mb = mailboxes.get(id);
      if (!mb) {
        res.status(404).json({ error: 'Không tìm thấy hộp thư.' });
        return;
      }

      mb.deletedMessageIds.add(messageId);

      if (mb.provider === 'mailtm' && mb.mailtmToken) {
        fetch(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${mb.mailtmToken}` },
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      } else if (mb.provider === 'tempmail_plus' && messageId.startsWith('tmp_')) {
        const rawMailId = messageId.slice(4);
        fetch(
          `${TEMPMAIL_PLUS_API}/${encodeURIComponent(rawMailId)}?email=${encodeURIComponent(mb.address)}&epin=`,
          { method: 'DELETE', signal: AbortSignal.timeout(4000) }
        ).catch(() => {});
      } else if (mb.provider === 'inboxes' && messageId.startsWith('inb_')) {
        const rawUid = messageId.slice(4);
        fetch(`${INBOXES_API}/message/${encodeURIComponent(rawUid)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      }

      res.json({ deleted: true, messageId });
    })
  );

  // Healthcheck endpoints
  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      mode: SERVE_STATIC_DIST ? 'static' : 'vite-dev',
      node: process.version,
    });
  });
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint không tồn tại.' });
  });

  if (SERVE_STATIC_DIST) {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) return next();
      try {
        const htmlPath = path.resolve(__dirname, 'index.html');
        const template = fs.readFileSync(htmlPath, 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status =
        typeof (err as { status?: unknown })?.status === 'number'
          ? (err as { status: number }).status
          : 500;
      if (req.originalUrl.startsWith('/api')) {
        res.status(status >= 400 && status < 600 ? status : 500).json({
          error: status === 400 ? 'Dữ liệu gửi lên không hợp lệ.' : 'Đã xảy ra lỗi trên máy chủ.',
        });
        return;
      }
      res.status(500).send('Internal Server Error');
    }
  );

  const fallbackPort = parseValidPort(process.env.DEFAULT_APP_PORT) ?? 3000;
  const httpServer = http.createServer(app);
  let activePort = PORT;
  let retriedFallback = false;

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && !retriedFallback && activePort !== fallbackPort) {
      retriedFallback = true;
      activePort = fallbackPort;
      console.warn(
        `Port ${PORT} is already in use; retrying on fallback port ${fallbackPort}...`
      );
      httpServer.listen(activePort, '0.0.0.0');
      return;
    }
    console.error('Server listen error:', err);
    process.exit(1);
  });

  httpServer.listen(activePort, '0.0.0.0', () => {
    console.log(
      `TempMail server running at http://0.0.0.0:${activePort} (${SERVE_STATIC_DIST ? 'static' : 'vite-dev'}, node ${process.version})`
    );
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
