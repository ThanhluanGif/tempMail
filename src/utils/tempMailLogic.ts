export interface ParsedEmailInput {
  valid: boolean;
  username?: string;
  domain?: string;
  error?: string;
}

const ADJECTIVES = [
  'minh',
  'linh',
  'khang',
  'vayi',
  'nora',
  'tuan',
  'huy',
  'anh',
  'vy',
  'khoa',
  'thao',
  'nam',
  'son',
  'mai',
  'bao',
  'duc',
  'quang',
  'ha',
  'phuc',
  'ngoc',
];

const NOUNS = [
  'xaf',
  'nova',
  'mail',
  'cloud',
  'box',
  'dev',
  'tech',
  'sky',
  'zen',
  'wave',
  'arc',
  'flux',
  'mint',
  'spark',
  'core',
  'line',
  'leaf',
  'star',
  'rio',
  'neo',
];

/**
 * Generates a realistic, RFC-safe disposable email username (lowercase alphanumeric).
 */
export function generateFakerUsername(rng: () => number = Math.random): string {
  const partA = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)];
  const partB = NOUNS[Math.floor(rng() * NOUNS.length)];
  const digits = Math.floor(100 + rng() * 900);
  return `${partA}${partB}${digits}`.toLowerCase();
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/i;
const FULL_EMAIL_RE = /^([a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?)@([a-z0-9.-]+\.[a-z]{2,})$/i;

/**
 * Parses either a plain username or a full pasted email address into validated username/domain parts.
 */
export function parseEmailInput(
  rawInput: string,
  selectedDomain?: string
): ParsedEmailInput {
  const trimmed = rawInput.trim().toLowerCase();

  if (!trimmed) {
    return {
      valid: false,
      error: 'Vui lòng nhập username hoặc bấm tạo ngẫu nhiên.',
    };
  }

  if (trimmed.includes('@')) {
    const match = trimmed.match(FULL_EMAIL_RE);
    if (!match) {
      return {
        valid: false,
        error: 'Địa chỉ email không hợp lệ. Vui lòng kiểm tra lại định dạng.',
      };
    }
    return {
      valid: true,
      username: match[1],
      domain: match[2],
    };
  }

  if (trimmed.length < 3) {
    return {
      valid: false,
      error: 'Username phải có ít nhất 3 ký tự.',
    };
  }

  if (!USERNAME_RE.test(trimmed)) {
    return {
      valid: false,
      error: 'Username chỉ được chứa chữ cái, chữ số, dấu chấm, gạch dưới hoặc gạch ngang.',
    };
  }

  if (!selectedDomain) {
    return {
      valid: false,
      error: 'Vui lòng chọn một tên miền hợp lệ.',
    };
  }

  return {
    valid: true,
    username: trimmed,
    domain: selectedDomain.trim().toLowerCase(),
  };
}

/**
 * Strips HTML tags down to clean searchable plain text for OTP analysis and snippets.
 * Preserves line breaks for block elements so standalone OTP lines remain recognizable.
 */
export function stripHtmlToText(input: string): string {
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

/**
 * Collapses HTML digit-by-digit OTP cells like <td>6</td><td>2</td><td>0</td><td>2</td><td>5</td><td>2</td>
 * or <span>4</span><span>8</span>... into contiguous tokens before plain-text extraction.
 */
function collapseHtmlDigitBoxes(raw: string): string {
  if (!raw || !raw.includes('<')) return raw;
  // Repeatedly merge adjacent single-digit inline/cell elements into one token
  return raw.replace(
    /(<(?:td|th|span|div|b|strong|p)\b[^>]*>\s*[0-9]\s*<\/(?:td|th|span|div|b|strong|p)>\s*){4,8}/gi,
    (block) => {
      const digits = block.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
      return /^\d{4,8}$/.test(digits) ? `\n${digits}\n` : block;
    }
  );
}

/**
 * Detects OTP / verification codes from Vietnamese, English, and international emails
 * (including spaced/hyphenated codes, prefixed codes like G-582914 or FB-481920,
 * HTML digit boxes, alphanumeric codes, and standalone subject/line codes) while filtering
 * out URLs, dates, years, postal codes, phone numbers, CSS values, and timestamps.
 */
export function extractOtpCodes(content: string, subject = ''): string[] {
  const normalizedHtml = collapseHtmlDigitBoxes(content);
  const plainBody = stripHtmlToText(normalizedHtml);
  const cleanSubject = stripHtmlToText(subject);
  const combined = `${cleanSubject}\n${plainBody}`;
  const candidates = new Set<string>();

  // Remove URLs, email addresses, timestamps, dates, hex colors, CSS units, and US postal codes
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
    // Preserve letter prefix like G-582914 or FB-481920, collapse internal spaces/hyphens in pure digit groups (e.g. "123 456" -> "123456")
    const normalized = /^[A-Z]{1,3}-\d{4,8}$/.test(trimmed)
      ? trimmed
      : trimmed.replace(/[\s-]+/g, '');
    if (isLikelyOtp(normalized)) {
      candidates.add(normalized);
    }
  };

  // 1. Prefixed verification codes like G-582914, FB-481920, IG-481920
  const prefixedRe = /\b([A-Z]{1,2}-\d{4,8})\b/g;
  let match: RegExpExecArray | null;
  while ((match = prefixedRe.exec(cleaned)) !== null) {
    addCandidate(match[1]);
  }

  // 2. Multilingual contextual keywords followed by numeric, spaced/hyphenated numeric, or alphanumeric OTP
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

  // 3. Code followed by OTP keyword (e.g. "620252 là mã xác nhận Facebook của bạn", "492817 is your Instagram code")
  const contextualBeforeRe =
    /\b((?:\d{4,8})|(?:\d{3}[\s-]\d{3})|(?:\d{4}[\s-]\d{4}))\s+(?:là\s+mã|is\s+your\s+(?:[a-z]+\s+)?(?:verification|confirmation|security|login|sign[- ]?in|otp|one-time)?\s*code|to\s+verify|để\s+xác\s*(?:nhận|minh|thực))/gi;
  while ((match = contextualBeforeRe.exec(cleaned)) !== null) {
    addCandidate(match[1]);
  }

  // 4. Subject-line prominent numeric code (e.g. "[GitHub] 482910", "482910 - Meta", "Your code: 482 910")
  if (candidates.size === 0 && cleanedSubject) {
    const subjectCodeRe = /\b((?:\d{4,8})|(?:\d{3}[\s-]\d{3}))\b/g;
    while ((match = subjectCodeRe.exec(cleanedSubject)) !== null) {
      addCandidate(match[1]);
    }
  }

  // 5. Isolated line containing ONLY a 5–8 digit code (or 4-digit code if verification keyword is present)
  const hasVerifyContext =
    /(?:\botp\b|xác\s*nhận|xác\s*minh|xác\s*thực|\bverify\b|\bverification\b|\bconfirm(?:ation)?\b|\bpasscode\b|mã\s*(?:otp|xác|bảo|đăng)|\bpin\b|\btoken\b|验证|認証|인증)/i.test(
      cleaned
    );

  if (candidates.size === 0) {
    const lines = cleaned.split('\n');
    for (const line of lines) {
      const t = line.trim();
      const pattern = hasVerifyContext
        ? /^(?:(?:\d{4,8})|(?:\d{3}[\s-]\d{3})|(?:\d{2}[\s-]\d{2}[\s-]\d{2})|(?:\d{4}[\s-]\d{4})|(?:\d(?:\s+\d){3,7}))$/
        : /^(?:(?:\d{5,8})|(?:\d{3}[\s-]\d{3})|(?:\d{2}[\s-]\d{2}[\s-]\d{2})|(?:\d{4}[\s-]\d{4})|(?:\d(?:\s+\d){4,7}))$/;
      if (pattern.test(t)) {
        addCandidate(t);
      }
    }
  }

  // 6. Fallback: standalone 4–8 digit code when email mentions any verification/OTP keyword
  if (
    candidates.size === 0 &&
    (hasVerifyContext || /(?:\bcode\b|\bmã\b)/i.test(cleaned))
  ) {
    const standaloneRegex = /\b(\d{6}|\d{5}|\d{4}|\d{8})\b/g;
    while ((match = standaloneRegex.exec(cleaned)) !== null) {
      addCandidate(match[1]);
    }
  }

  return Array.from(candidates);
}

function isLikelyOtp(code: string): boolean {
  if (!code) return false;
  // Prefixed codes like G-582914 or FB-481920 are always valid OTPs
  if (/^[A-Z]{1,2}-\d{4,8}$/.test(code)) return true;
  // Filter obvious 4-digit calendar years (1900-2099)
  if (/^(?:19|20)\d{2}$/.test(code)) return false;
  // Reject all identical digits only if length <= 4 (e.g. 0000)
  if (code.length <= 4 && /^(\d)\1+$/.test(code)) return false;
  // Reject pure letters or tokens with lowercase letters (avoids false positives like "10min", "5phut")
  if (/^[A-Za-z]+$/.test(code) || /[a-z]/.test(code)) return false;
  return code.length >= 4 && code.length <= 10;
}

export interface LatestOtpInfo {
  code: string;
  messageId: string;
  fromName: string;
  subject: string;
  receivedAt: string;
}

/**
 * Returns the newest OTP code across a mailbox's sorted message list (newest-first).
 */
export function getLatestOtpForMessages(
  messages: Array<{
    id: string;
    fromName: string;
    subject: string;
    receivedAt: string;
    otpCodes: string[];
  }>
): LatestOtpInfo | null {
  for (const msg of messages) {
    if (msg.otpCodes && msg.otpCodes.length > 0) {
      return {
        code: msg.otpCodes[0],
        messageId: msg.id,
        fromName: msg.fromName,
        subject: msg.subject,
        receivedAt: msg.receivedAt,
      };
    }
  }
  return null;
}

/**
 * Sanitizes untrusted email HTML before passing into a strictly sandboxed iframe.
 * Removes scripts, active embeds, inline event handlers, and javascript:/data: URLs.
 */
export function sanitizeEmailHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  let html = rawHtml;
  // Remove dangerous active elements completely
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<object[\s\S]*?<\/object>/gi, '');
  html = html.replace(/<embed[\s\S]*?>/gi, '');
  // Unwrap <form> tags instead of deleting inner content so OTP boxes wrapped in <form> stay visible
  html = html.replace(/<\/?form\b[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
  html = html.replace(/<base[^>]*>/gi, '');

  // Strip inline event handlers like onclick="..." or onerror=...
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Neutralize javascript:, vbscript:, and data: URIs in href/src attributes
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

/**
 * Formats an ISO timestamp into Vietnamese DD-MM-YYYY HH:mm:ss format.
 */
export function formatEmailDate(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Formats a concise relative or short clock timestamp for the message list.
 */
export function formatShortTime(isoDate: string, nowMs: number = Date.now()): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date(nowMs);
  if (
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear()
  ) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/**
 * Returns the uppercase single-character avatar initial for a sender.
 */
export function getSenderInitial(fromName: string, fromAddress: string): string {
  const source = (fromName || fromAddress || '?').replace(/^["'\s]+/, '');
  const firstChar = source.charAt(0).toUpperCase();
  return firstChar || '?';
}

/**
 * Wraps sanitized email HTML in a responsive, strictly CSP-locked document so HTML OTP emails
 * render cleanly without horizontal overflow, missing fonts, or clipped layouts.
 */
export function buildSafeEmailSrcDoc(sanitizedHtml: string): string {
  const safe = sanitizeEmailHtml(sanitizedHtml);
  const headInjection = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: http: data:; style-src \'unsafe-inline\'; font-src https: data:;" />',
    '<base target="_blank" />',
    `<style>
      html, body {
        margin: 0;
        padding: 16px 20px;
        background: #ffffff;
        color: #1d1d1f;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        overflow-wrap: break-word;
        word-break: break-word;
        box-sizing: border-box;
      }
      *, *::before, *::after { box-sizing: inherit; }
      img, svg, video { max-width: 100% !important; height: auto !important; }
      table { max-width: 100% !important; border-collapse: collapse; }
      td, th { word-break: break-word; }
      pre, code { white-space: pre-wrap; word-break: break-all; }
      a { color: #0066d6; }
    </style>`,
  ].join('\n');

  if (/<html[\s>]/i.test(safe)) {
    if (/<head[\s>]/i.test(safe)) {
      return safe.replace(/<head([^>]*)>/i, `<head$1>\n${headInjection}`);
    }
    return safe.replace(/<html([^>]*)>/i, `<html$1><head>\n${headInjection}\n</head>`);
  }

  return `<!doctype html><html><head>${headInjection}</head><body>${safe}</body></html>`;
}

/**
 * Merges freshly polled inbox messages with existing cached messages so:
 * - Already-extracted OTP codes are never erased when a later summary poll returns otpCodes: []
 * - Read state stays sticky across refreshes
 * - Previously received OTP emails are preserved even if an ephemeral provider transiently omits them
 *   (unless explicitly deleted by the user)
 */
export function mergeInboxMessages<
  T extends {
    id: string;
    snippet: string;
    receivedAt: string;
    isRead: boolean;
    otpCodes: string[];
  },
>(existing: T[], incoming: T[], deletedIds?: ReadonlySet<string>): T[] {
  const byId = new Map<string, T>();

  for (const prev of existing) {
    if (deletedIds?.has(prev.id)) continue;
    byId.set(prev.id, prev);
  }

  for (const next of incoming) {
    if (deletedIds?.has(next.id)) continue;
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      continue;
    }
    const mergedOtps = next.otpCodes.length > 0 ? next.otpCodes : prev.otpCodes;
    const mergedSnippet =
      next.snippet && next.snippet.length >= prev.snippet.length ? next.snippet : prev.snippet;
    byId.set(next.id, {
      ...prev,
      ...next,
      isRead: prev.isRead || next.isRead,
      otpCodes: mergedOtps,
      snippet: mergedSnippet || next.snippet || prev.snippet,
    });
  }

  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
  );
}
