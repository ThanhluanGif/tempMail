export interface ParsedEmailInput {
  valid: boolean;
  username?: string;
  domain?: string;
  error?: string;
}

export interface SampleEmailContent {
  fromName: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  textBody: string;
  htmlBody: string;
  rawSource: string;
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
 */
export function stripHtmlToText(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects OTP / verification codes from Vietnamese and English email content while
 * filtering out dates, years, postal codes, phone fragments, and timestamps.
 */
export function extractOtpCodes(content: string, subject = ''): string[] {
  const combined = `${subject}\n${stripHtmlToText(content)}`;
  const candidates = new Set<string>();

  // Remove timestamps (08:33:28), dates (22-11-2026, 2026/11/22), and hex colors (#007AFF)
  const cleaned = combined
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
    .replace(/\b(?:CA|NY|TX|FL|WA)\s+\d{5}(?:-\d{4})?\b/g, ' ');

  const contextualPatterns: RegExp[] = [
    // Vietnamese & English OTP keywords followed by code
    /(?:mã\s*(?:xác\s*nhận|xác\s*minh|bảo\s*mật|otp|đăng\s*nhập|kích\s*hoạt)|verification\s*code|confirmation\s*code|security\s*code|passcode|one-time\s*code|login\s*code|otp)\s*(?:là|của\s*bạn\s*là|is|:|-|–)?\s*(?:[A-Z]-)?(\d{4,8})\b/gi,
    // Prefixed codes like G-620252 or FB-481920
    /\b([A-Z]{1,2}-\d{5,8})\b/g,
    // Code followed by OTP keyword (e.g. "620252 là mã xác nhận của bạn")
    /\b(\d{4,8})\s+(?:là\s+mã|is\s+your\s+(?:verification|confirmation|security|login|otp)\s+code)/gi,
  ];

  for (const regex of contextualPatterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      const code = (match[1] ?? '').trim();
      if (isLikelyOtp(code)) {
        candidates.add(code);
      }
    }
  }

  // Fallback: standalone 6-digit code on a line or prominent token if email mentions verification
  if (candidates.size === 0 && /(?:otp|xác\s*nhận|xác\s*minh|verify|confirm|code|mã)/i.test(cleaned)) {
    const standaloneRegex = /\b(\d{6})\b/g;
    let match: RegExpExecArray | null;
    while ((match = standaloneRegex.exec(cleaned)) !== null) {
      const code = match[1];
      if (isLikelyOtp(code)) {
        candidates.add(code);
      }
    }
  }

  return Array.from(candidates);
}

function isLikelyOtp(code: string): boolean {
  if (!code) return false;
  // Filter obvious 4-digit calendar years (1900-2099)
  if (/^(?:19|20)\d{2}$/.test(code)) return false;
  // Reject all identical digits only if length <= 4 (e.g. 0000)
  if (code.length <= 4 && /^(\d)\1+$/.test(code)) return false;
  return true;
}

/**
 * Sanitizes untrusted email HTML before passing into a strictly sandboxed iframe.
 * Removes scripts, active embeds, inline event handlers, and javascript:/data: URLs.
 */
export function sanitizeEmailHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  let html = rawHtml;
  // Remove dangerous elements completely
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<object[\s\S]*?<\/object>/gi, '');
  html = html.replace(/<embed[\s\S]*?>/gi, '');
  html = html.replace(/<form[\s\S]*?<\/form>/gi, '');
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
 * Builds realistic verification emails (starting with the Meta 620252 verification email)
 * for immediate in-app testing of OTP auto-detection, HTML rendering, and raw source inspection.
 */
export function buildSampleTestEmail(
  recipientAddress: string,
  variantIndex = 0,
  nowIso: string = new Date().toISOString()
): SampleEmailContent {
  const idx = Math.abs(variantIndex) % 3;

  if (idx === 0) {
    const otp = '620252';
    const subject = 'Xác nhận email cho Tài khoản Meta mới';
    const fromName = 'Meta';
    const fromAddress = 'security@account.meta.com';
    const textBody = [
      'Meta',
      '',
      'Vui lòng xác nhận email cho tài khoản Meta mới của bạn bằng cách nhập mã xác nhận sau đây.',
      '',
      'Mã xác nhận',
      otp,
      '',
      'Nếu bạn không yêu cầu mã xác nhận, hãy bỏ qua thông báo này.',
      '',
      '© Meta. Meta Platforms, Inc., Attention: Community Support, 1 Meta Way, Menlo Park, CA 94025',
      `Thư này đã được gửi đến ${recipientAddress}. Để góp phần bảo mật trang cá nhân của bạn, vui lòng không chuyển tiếp email này.`,
    ].join('\n');

    const htmlBody = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; padding: 28px 20px; background: #ffffff; color: #1c1e21; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; }
    .container { max-width: 560px; margin: 0 auto; }
    .brand { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 700; color: #1c2b33; padding-bottom: 18px; border-bottom: 1px solid #e5e7eb; margin-bottom: 24px; }
    .brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; background: #0064e0; color: #ffffff; font-size: 15px; font-weight: 700; }
    .lead { font-size: 15px; color: #1c2b33; margin: 0 0 20px; }
    .code-label { font-size: 13px; color: #606770; margin-bottom: 8px; font-weight: 600; }
    .code-box { display: inline-block; padding: 14px 24px; background: #f0f4f9; border: 1px solid #d5e1f2; border-radius: 10px; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0064e0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-bottom: 20px; }
    .note { font-size: 14px; color: #4b5563; margin: 0 0 28px; }
    .footer { border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 12px; color: #6b7280; line-height: 1.55; }
    .footer p { margin: 0 0 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand"><span class="brand-mark">M</span><span>Meta</span></div>
    <p class="lead">Vui lòng xác nhận email cho tài khoản Meta mới của bạn bằng cách nhập mã xác nhận sau đây.</p>
    <div class="code-label">Mã xác nhận</div>
    <div class="code-box">${otp}</div>
    <p class="note">Nếu bạn không yêu cầu mã xác nhận, hãy bỏ qua thông báo này.</p>
    <div class="footer">
      <p>© Meta. Meta Platforms, Inc., Attention: Community Support, 1 Meta Way, Menlo Park, CA 94025</p>
      <p>Thư này đã được gửi đến <strong>${recipientAddress}</strong>. Để góp phần bảo mật trang cá nhân của bạn, vui lòng không chuyển tiếp email này.</p>
    </div>
  </div>
</body>
</html>`;

    const rawSource = [
      `Delivered-To: ${recipientAddress}`,
      `From: "${fromName}" <${fromAddress}>`,
      `To: <${recipientAddress}>`,
      `Date: ${new Date(nowIso).toUTCString()}`,
      `Subject: ${subject}`,
      `Message-ID: <meta-verify-${Date.now()}@account.meta.com>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      textBody,
    ].join('\r\n');

    return { fromName, fromAddress, subject, receivedAt: nowIso, textBody, htmlBody, rawSource };
  }

  if (idx === 1) {
    const otp = '482917';
    const subject = '[GitHub] Mã xác minh thiết bị đăng nhập mới';
    const fromName = 'GitHub';
    const fromAddress = 'noreply@github.com';
    const textBody = [
      'Chào bạn,',
      '',
      'Chúng tôi phát hiện yêu cầu đăng nhập vào tài khoản GitHub từ một thiết bị mới.',
      `Mã xác minh của bạn là: ${otp}`,
      '',
      'Mã này sẽ hết hạn sau 15 phút. Nếu không phải bạn thực hiện, vui lòng bỏ qua email này.',
    ].join('\n');

    const htmlBody = `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8" /><style>
  body { margin: 0; padding: 28px 20px; background: #fff; color: #1f2328; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
  .wrap { max-width: 540px; margin: 0 auto; }
  .code { font-family: ui-monospace, monospace; font-size: 26px; font-weight: 700; letter-spacing: 5px; background: #f6f8fa; border: 1px solid #d0d7de; padding: 14px 22px; border-radius: 8px; display: inline-block; margin: 14px 0; }
  .muted { color: #656d76; font-size: 13px; }
</style></head>
<body>
  <div class="wrap">
    <h2 style="margin:0 0 12px;font-size:18px;">Xác minh thiết bị GitHub</h2>
    <p>Chúng tôi phát hiện yêu cầu đăng nhập từ thiết bị mới cho địa chỉ <strong>${recipientAddress}</strong>.</p>
    <div class="code">${otp}</div>
    <p class="muted">Mã xác minh có hiệu lực trong 15 phút. Không chia sẻ mã này cho bất kỳ ai.</p>
  </div>
</body>
</html>`;

    const rawSource = [
      `Delivered-To: ${recipientAddress}`,
      `From: "${fromName}" <${fromAddress}>`,
      `To: <${recipientAddress}>`,
      `Date: ${new Date(nowIso).toUTCString()}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      textBody,
    ].join('\r\n');

    return { fromName, fromAddress, subject, receivedAt: nowIso, textBody, htmlBody, rawSource };
  }

  const otp = '739104';
  const subject = 'Notion — Mã đăng nhập một lần của bạn';
  const fromName = 'Notion';
  const fromAddress = 'notify@mail.notion.so';
  const textBody = [
    'Xin chào,',
    '',
    `Mã đăng nhập tạm thời của bạn là ${otp}.`,
    'Nhập mã này vào cửa sổ trình duyệt để tiếp tục vào không gian làm việc Notion.',
  ].join('\n');

  const htmlBody = `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8" /><style>
  body { margin: 0; padding: 28px 20px; background: #fff; color: #2f3437; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
  .wrap { max-width: 540px; margin: 0 auto; }
  .code { font-family: ui-monospace, monospace; font-size: 26px; font-weight: 700; letter-spacing: 5px; background: #f7f6f3; border: 1px solid #e3e2de; padding: 14px 22px; border-radius: 8px; display: inline-block; margin: 14px 0; }
</style></head>
<body>
  <div class="wrap">
    <h2 style="margin:0 0 12px;font-size:18px;">Đăng nhập vào Notion</h2>
    <p>Sử dụng mã OTP bên dưới để hoàn tất đăng nhập cho <strong>${recipientAddress}</strong>:</p>
    <div class="code">${otp}</div>
    <p style="font-size:13px;color:#787774;">Nếu bạn không yêu cầu đăng nhập, bạn có thể an toàn bỏ qua thư này.</p>
  </div>
</body>
</html>`;

  const rawSource = [
    `Delivered-To: ${recipientAddress}`,
    `From: "${fromName}" <${fromAddress}>`,
    `To: <${recipientAddress}>`,
    `Date: ${new Date(nowIso).toUTCString()}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    textBody,
  ].join('\r\n');

  return { fromName, fromAddress, subject, receivedAt: nowIso, textBody, htmlBody, rawSource };
}
