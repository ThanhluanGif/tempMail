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
import { resolveServerPort, shouldServeStaticDist } from './serverConfig';
import { onRequest as cfApiHandler } from '../../functions/api/[[path]]';
import cfWorker from '../../worker';

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

test('resolveServerPort avoids Nginx port 8080 collision while supporting standalone Cloud Run and CLI flags', () => {
  // AI Studio / Cloud Run container with Nginx on 8080 proxying to DEFAULT_APP_PORT=3000
  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
      NGINX_PORT: '8080',
      DEFAULT_APP_PORT: '3000',
    }),
    3000
  );

  // Nginx owns PORT even if DEFAULT_APP_PORT is missing
  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
      NGINX_PORT: '8080',
    }),
    3000
  );

  // Standalone Cloud Run without Nginx uses injected PORT=8080
  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
    }),
    8080
  );

  // Standalone Cloud Run with stray DEFAULT_APP_PORT=3000 (no NGINX_PORT) STILL binds PORT=8080
  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
      DEFAULT_APP_PORT: '3000',
    }),
    8080
  );

  // Explicit CLI --port flag overrides env vars
  assert.equal(
    resolveServerPort(['node', 'server.ts', '--port', '3099'], {
      PORT: '8080',
      DEFAULT_APP_PORT: '3000',
    }),
    3099
  );
  assert.equal(
    resolveServerPort(['node', 'server.ts', '--port=4100'], {
      PORT: '8080',
    }),
    4100
  );

  // Local default when no env vars exist
  assert.equal(resolveServerPort(['node', 'server.ts'], {}), 3000);
});

test('shouldServeStaticDist serves dist/ under node server.ts even with NODE_ENV=development, but keeps Vite in tsx dev', () => {
  // Deployed container running `node server.ts` even if NODE_ENV=development is inherited
  assert.equal(
    shouldServeStaticDist({
      argv: ['node', 'server.ts'],
      execArgv: [],
      env: { NODE_ENV: 'development' },
      hasBuiltDist: true,
    }),
    true
  );

  // Dev server running `npm run dev` via tsx keeps Vite middleware
  assert.equal(
    shouldServeStaticDist({
      argv: ['node', 'server.ts', '--port', '3000'],
      execArgv: ['--require', '/app/node_modules/tsx/dist/preflight.cjs'],
      env: { NODE_ENV: 'development', npm_lifecycle_event: 'dev' },
      hasBuiltDist: true,
    }),
    false
  );

  // Missing dist/ falls back to Vite instead of crashing
  assert.equal(
    shouldServeStaticDist({
      argv: ['node', 'server.ts'],
      execArgv: [],
      env: { NODE_ENV: 'production' },
      hasBuiltDist: false,
    }),
    false
  );
});

test('Cloudflare Pages Functions handler supports stateless encrypted HttpOnly cookie lifecycle end-to-end', async () => {
  const env = { MAILBOX_SESSION_SECRET: 'unit-test-secret-32-bytes-key-abc' };
  const cookieJar = new Map<string, string>();

  const callCf = async (method: string, path: string, body?: unknown) => {
    const cookieHeader = Array.from(cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const headers = new Headers({ Accept: 'application/json' });
    if (cookieHeader) headers.set('Cookie', cookieHeader);
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const req = new Request(`https://tempmail.pages.dev${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await cfApiHandler({ request: req, env, params: {} });

    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')!]
          : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (sc.includes('Max-Age=0') || !val) {
        cookieJar.delete(name);
      } else {
        cookieJar.set(name, val);
      }
    }

    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, setCookies };
  };

  // 1. Health check
  const health = await callCf('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.runtime, 'cloudflare-pages');

  // 2. Create mailbox (uses real upstream or falls back cleanly) & verify HttpOnly encrypted cookie
  const created = await callCf('POST', '/api/mailboxes', {
    mode: 'domain',
    username: 'cfedgeuser99',
    domain: 'sharklasers.com',
  });
  assert.equal(created.status, 201);
  const mailbox = created.json.mailbox as { id: string; address: string };
  assert.ok(mailbox.id.startsWith('mb_'));
  assert.ok(mailbox.address.includes('@'));
  // Ensure credentials are not leaked in response JSON and cookie is HttpOnly + Secure
  assert.equal((mailbox as Record<string, unknown>).guerrillaSid, undefined);
  assert.equal((mailbox as Record<string, unknown>).mailtmToken, undefined);
  assert.ok(created.setCookies.some((c) => c.includes('HttpOnly') && c.includes('Secure')));

  // 3. List mailboxes across stateless request via Cookie header
  const listed = await callCf('GET', '/api/mailboxes');
  assert.equal(listed.status, 200);
  const listArr = listed.json.mailboxes as Array<{ id: string }>;
  assert.ok(listArr.some((m) => m.id === mailbox.id));

  // 4. Send Meta 620252 test email & read it back
  const sampleRes = await callCf('POST', `/api/mailboxes/${mailbox.id}/test-email`, {});
  assert.equal(sampleRes.status, 201);
  const sampleMsg = sampleRes.json.message as { id: string; otpCodes: string[] };
  assert.deepEqual(sampleMsg.otpCodes, ['620252']);

  const inbox = await callCf('GET', `/api/mailboxes/${mailbox.id}/messages`);
  assert.equal(inbox.status, 200);
  const msgs = inbox.json.messages as Array<{ id: string; isRead: boolean }>;
  assert.ok(msgs.some((m) => m.id === sampleMsg.id && !m.isRead));

  const detail = await callCf('GET', `/api/mailboxes/${mailbox.id}/messages/${sampleMsg.id}`);
  assert.equal(detail.status, 200);
  assert.equal((detail.json.message as { isRead: boolean }).isRead, true);

  // 5. Delete message & verify removal
  const delMsg = await callCf('DELETE', `/api/mailboxes/${mailbox.id}/messages/${sampleMsg.id}`);
  assert.equal(delMsg.status, 200);

  const inboxAfterDel = await callCf('GET', `/api/mailboxes/${mailbox.id}/messages`);
  const msgsAfterDel = inboxAfterDel.json.messages as Array<{ id: string }>;
  assert.ok(!msgsAfterDel.some((m) => m.id === sampleMsg.id));

  // 6. Delete mailbox & verify cookie expiration + 404
  const delMb = await callCf('DELETE', `/api/mailboxes/${mailbox.id}`);
  assert.equal(delMb.status, 200);
  assert.equal(cookieJar.has(`tm_m_${mailbox.id}`), false);

  const missing = await callCf('GET', `/api/mailboxes/${mailbox.id}/messages`);
  assert.equal(missing.status, 404);

  // 7. Unknown API route returns JSON 404
  const unknown = await callCf('GET', '/api/nonexistent');
  assert.equal(unknown.status, 404);
  assert.equal(typeof unknown.json.error, 'string');
});

test('Cloudflare Worker entry point routes /api/* to edge handler and delegates static paths to ASSETS', async () => {
  let assetsCalled = false;
  const mockEnv = {
    MAILBOX_SESSION_SECRET: 'worker-test-secret',
    ASSETS: {
      async fetch(req: Request) {
        assetsCalled = true;
        return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
      },
    },
  };

  const apiRes = await cfWorker.fetch(
    new Request('https://tempmail-studio.workers.dev/api/health'),
    mockEnv
  );
  assert.equal(apiRes.status, 200);
  const apiJson = (await apiRes.json()) as { ok: boolean; runtime: string };
  assert.equal(apiJson.ok, true);
  assert.equal(assetsCalled, false);

  const pageRes = await cfWorker.fetch(
    new Request('https://tempmail-studio.workers.dev/'),
    mockEnv
  );
  assert.equal(pageRes.status, 200);
  assert.equal(assetsCalled, true);
  assert.equal(await pageRes.text(), 'asset:/');
});
