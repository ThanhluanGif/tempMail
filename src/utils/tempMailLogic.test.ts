import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSampleTestEmail,
  extractOtpCodes,
  formatEmailDate,
  formatShortTime,
  generateFakerUsername,
  getSenderInitial,
  parseEmailInput,
  sanitizeEmailHtml,
} from './tempMailLogic';

test('extractOtpCodes detects Meta Vietnamese verification code 620252 and ignores postal code 94025', () => {
  const metaBody = `
    Vui lòng xác nhận email cho tài khoản Meta mới của bạn bằng cách nhập mã xác nhận sau đây.
    Mã xác nhận
    620252
    Nếu bạn không yêu cầu mã xác nhận, hãy bỏ qua thông báo này.
    © Meta. Meta Platforms, Inc., Attention: Community Support, 1 Meta Way, Menlo Park, CA 94025
    Ngày: 22-11-2026 08:33:28
  `;
  const codes = extractOtpCodes(metaBody, 'Xác nhận email cho Tài khoản Meta mới');
  assert.deepEqual(codes, ['620252']);
});

test('extractOtpCodes detects English OTP and prefixed verification codes without false positives on years', () => {
  const codesA = extractOtpCodes(
    'Your verification code is 481920. Copyright 2026 Example Inc.',
    'Confirm your email'
  );
  assert.deepEqual(codesA, ['481920']);

  const codesB = extractOtpCodes(
    'Use G-582914 to verify your Google sign-in at 14:22:09.',
    'Security alert'
  );
  assert.ok(codesB.includes('G-582914'));
});

test('generateFakerUsername creates valid lowercase RFC-safe usernames', () => {
  for (let i = 0; i < 20; i++) {
    const username = generateFakerUsername();
    assert.match(username, /^[a-z0-9]{6,20}$/);
  }
});

test('parseEmailInput handles custom usernames, pasted full emails, and rejects invalid input', () => {
  const okCustom = parseEmailInput('vayixaf693', 'euploading.com');
  assert.equal(okCustom.valid, true);
  assert.equal(okCustom.username, 'vayixaf693');
  assert.equal(okCustom.domain, 'euploading.com');

  const okPasted = parseEmailInput('  VayiXaf693@Forims.COM  ', 'euploading.com');
  assert.equal(okPasted.valid, true);
  assert.equal(okPasted.username, 'vayixaf693');
  assert.equal(okPasted.domain, 'forims.com');

  const empty = parseEmailInput('   ', 'euploading.com');
  assert.equal(empty.valid, false);
  assert.ok(empty.error);

  const badChars = parseEmailInput('user name!@#', 'euploading.com');
  assert.equal(badChars.valid, false);

  const tooShort = parseEmailInput('ab', 'euploading.com');
  assert.equal(tooShort.valid, false);
});

test('sanitizeEmailHtml strips scripts, iframes, inline event handlers, and javascript URLs', () => {
  const dirty = `
    <div>
      <p onclick="alert(1)">Mã xác nhận: <strong>620252</strong></p>
      <script>fetch("https://evil.test")</script>
      <img src="x" onerror="alert(2)" />
      <a href="javascript:alert(3)">Click</a>
      <iframe src="https://evil.test"></iframe>
    </div>
  `;
  const clean = sanitizeEmailHtml(dirty);
  assert.ok(clean.includes('620252'));
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('<iframe'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(!clean.includes('javascript:'));
});

test('formatEmailDate, formatShortTime, and getSenderInitial format cleanly', () => {
  const formatted = formatEmailDate('2026-11-22T08:33:28.000Z');
  assert.match(formatted, /^\d{2}-\d{2}-2026 \d{2}:\d{2}:\d{2}$/);

  const now = Date.parse('2026-11-22T08:35:00.000Z');
  assert.equal(formatShortTime('2026-11-22T08:34:40.000Z', now), 'Vừa xong');
  assert.equal(formatShortTime('2026-11-22T08:30:00.000Z', now), '5 phút trước');

  assert.equal(getSenderInitial('"Meta"', 'security@account.meta.com'), 'M');
  assert.equal(getSenderInitial('', 'noreply@github.com'), 'N');
});

test('buildSampleTestEmail produces Meta 620252 verification email by default', () => {
  const sample = buildSampleTestEmail('vayixaf693@forims.com', 0);
  assert.equal(sample.fromName, 'Meta');
  assert.equal(sample.fromAddress, 'security@account.meta.com');
  assert.equal(sample.subject, 'Xác nhận email cho Tài khoản Meta mới');
  assert.deepEqual(extractOtpCodes(sample.textBody, sample.subject), ['620252']);
  assert.ok(sample.rawSource.includes('Delivered-To: vayixaf693@forims.com'));
});
