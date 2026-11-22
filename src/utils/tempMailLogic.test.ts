import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSafeEmailSrcDoc,
  extractOtpCodes,
  formatEmailDate,
  formatShortTime,
  generateFakerUsername,
  getLatestOtpForMessages,
  getSenderInitial,
  mergeInboxMessages,
  parseEmailInput,
  sanitizeEmailHtml,
} from './tempMailLogic';
import { resolveServerPort, shouldServeStaticDist } from './serverConfig';
import { decodeMimeHeader, parseRawMimeEmail } from './mimeParser';
import { onRequest as cfApiHandler, type CloudflareKvNamespace } from '../../functions/api/[[path]]';
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

test('extractOtpCodes handles spaced/hyphenated, HTML digit boxes, alphanumeric, multilingual OTPs and ignores URLs/time units', () => {
  // Spaced & hyphenated OTPs (TikTok / Apple / OpenAI)
  assert.deepEqual(extractOtpCodes('Your TikTok verification code is 482 910. Expires in 10min.', ''), ['482910']);
  assert.deepEqual(extractOtpCodes('Enter code: 593-812 to sign in.', ''), ['593812']);

  // HTML digit-by-digit table cells (Shopee / Meta / Banking)
  const boxedHtml =
    '<p>Mã xác thực của bạn:</p><table><tr><td>7</td><td>4</td><td>9</td><td>1</td><td>2</td><td>8</td></tr></table>';
  assert.deepEqual(extractOtpCodes(boxedHtml, 'Xác thực tài khoản'), ['749128']);

  // Uppercase alphanumeric OTP (Steam / AWS) while rejecting lowercase time units
  assert.deepEqual(extractOtpCodes('Your Steam Guard verification code: 5G8K2. Valid 5phut.', ''), ['5G8K2']);
  assert.deepEqual(extractOtpCodes('Mã OTP hết hạn sau 10min. Xem tại https://app.test/v?uid=998877', 'Thông báo'), []);

  // Multilingual OTPs (Chinese, Japanese, Korean)
  assert.deepEqual(extractOtpCodes('您的验证码：839201，请在5分钟内输入。', ''), ['839201']);
  assert.deepEqual(extractOtpCodes('認証コード: 591823 を入力してください。', ''), ['591823']);
  assert.deepEqual(extractOtpCodes('인증번호 739104 를 입력해 주세요.', ''), ['739104']);

  // Marketing email with isolated 4-digit store/order number must NOT false-positive as OTP
  assert.deepEqual(
    extractOtpCodes('New SKIMS Holiday Drops\nShop online now\n1339\nFree shipping over $75', 'Holiday Sale'),
    []
  );
});

test('getLatestOtpForMessages returns newest message containing an OTP code', () => {
  const latest = getLatestOtpForMessages([
    { id: 'm1', fromName: 'Newsletter', subject: 'Welcome', receivedAt: '2026-11-22T09:10:00Z', otpCodes: [] },
    { id: 'm2', fromName: 'Meta', subject: 'Code 620252', receivedAt: '2026-11-22T09:05:00Z', otpCodes: ['620252'] },
    { id: 'm3', fromName: 'GitHub', subject: 'Code 112233', receivedAt: '2026-11-22T09:00:00Z', otpCodes: ['112233'] },
  ]);
  assert.equal(latest?.code, '620252');
  assert.equal(latest?.messageId, 'm2');
  assert.equal(getLatestOtpForMessages([]), null);
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

test('sanitizeEmailHtml strips dangerous tags while preserving OTP content wrapped in <form>, and buildSafeEmailSrcDoc adds CSP + responsive CSS', () => {
  const dirty = `
    <div>
      <form action="https://evil.test"><p onclick="alert(1)">Mã xác nhận: <strong>620252</strong></p></form>
      <script>fetch("https://evil.test")</script>
      <img src="x" onerror="alert(2)" />
      <a href="javascript:alert(3)">Click</a>
      <iframe src="https://evil.test"></iframe>
    </div>
  `;
  const clean = sanitizeEmailHtml(dirty);
  assert.ok(clean.includes('620252'));
  assert.ok(!clean.includes('<form'));
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('<iframe'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(!clean.includes('javascript:'));

  const srcDoc = buildSafeEmailSrcDoc(dirty);
  assert.ok(srcDoc.includes("default-src 'none'"));
  assert.ok(srcDoc.includes('overflow-wrap: break-word'));
  assert.ok(srcDoc.includes('620252'));
  assert.ok(!srcDoc.includes('<script'));
});

test('mergeInboxMessages keeps discovered OTP codes and previously received messages across refreshes while honoring deletions', () => {
  const existing = [
    {
      id: 'm1',
      snippet: 'Your verification code is 620252',
      receivedAt: '2026-11-22T10:00:00Z',
      isRead: true,
      otpCodes: ['620252'],
    },
    {
      id: 'm_old',
      snippet: 'Earlier OTP 112233',
      receivedAt: '2026-11-22T09:50:00Z',
      isRead: false,
      otpCodes: ['112233'],
    },
  ];

  // Simulate later summary poll returning otpCodes: [] for m1 and transiently omitting m_old
  const incoming = [
    {
      id: 'm1',
      snippet: 'Verify your account',
      receivedAt: '2026-11-22T10:00:00Z',
      isRead: false,
      otpCodes: [],
    },
    {
      id: 'm2',
      snippet: 'New code 998877',
      receivedAt: '2026-11-22T10:05:00Z',
      isRead: false,
      otpCodes: ['998877'],
    },
  ];

  const merged = mergeInboxMessages(existing, incoming, new Set(['m_old']));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'm2');
  assert.deepEqual(merged[0].otpCodes, ['998877']);
  assert.equal(merged[1].id, 'm1');
  // Must preserve OTP 620252, longer snippet, and sticky isRead=true!
  assert.deepEqual(merged[1].otpCodes, ['620252']);
  assert.equal(merged[1].isRead, true);
  assert.equal(merged[1].snippet, 'Your verification code is 620252');

  // Without deletion, m_old is preserved even if incoming omits it
  const preserved = mergeInboxMessages(existing, [], new Set());
  assert.equal(preserved.length, 2);
  assert.deepEqual(preserved[0].otpCodes, ['620252']);
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

test('resolveServerPort avoids Nginx port 8080 collision while supporting standalone Cloud Run and CLI flags', () => {
  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
      NGINX_PORT: '8080',
      DEFAULT_APP_PORT: '3000',
    }),
    3000
  );

  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
      NGINX_PORT: '8080',
    }),
    3000
  );

  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
    }),
    8080
  );

  assert.equal(
    resolveServerPort(['node', 'server.ts'], {
      PORT: '8080',
      DEFAULT_APP_PORT: '3000',
    }),
    8080
  );

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

  assert.equal(resolveServerPort(['node', 'server.ts'], {}), 3000);
});

test('shouldServeStaticDist serves dist/ under node server.ts even with NODE_ENV=development, but keeps Vite in tsx dev', () => {
  assert.equal(
    shouldServeStaticDist({
      argv: ['node', 'server.ts'],
      execArgv: [],
      env: { NODE_ENV: 'development' },
      hasBuiltDist: true,
    }),
    true
  );

  assert.equal(
    shouldServeStaticDist({
      argv: ['node', 'server.ts', '--port', '3000'],
      execArgv: ['--require', '/app/node_modules/tsx/dist/preflight.cjs'],
      env: { NODE_ENV: 'development', npm_lifecycle_event: 'dev' },
      hasBuiltDist: true,
    }),
    false
  );

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

test('Cloudflare Edge API supports live TempMail.plus & Mail.tm mailboxes, removes test-email endpoint, and uses HttpOnly cookies', async () => {
  const env = { MAILBOX_SESSION_SECRET: 'unit-test-secret-32-bytes-key-abc' };
  const cookieJar = new Map<string, string>();

  const callCf = async (method: string, path: string, body?: unknown) => {
    const cookieHeader = Array.from(cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const headers = new Headers({ Accept: 'application/json' });
    if (cookieHeader) headers.set('Cookie', cookieHeader);
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const req = new Request(`https://tempmail.workers.dev${path}`, {
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

  // 1. Live domains exclude blacklisted GuerrillaMail and include clean TempMail.plus + Inboxes.com domains
  const domRes = await callCf('GET', '/api/domains');
  assert.equal(domRes.status, 200);
  const domains = domRes.json.domains as Array<{ domain: string; provider: string }>;
  assert.ok(domains.some((d) => d.domain === 'mailto.plus' && d.provider === 'tempmail_plus'));
  assert.ok(domains.some((d) => d.provider === 'inboxes'));
  assert.ok(!domains.some((d) => d.domain === 'sharklasers.com'));

  // 2. Create live TempMail.plus mailbox & verify HttpOnly Secure cookie
  const created = await callCf('POST', '/api/mailboxes', {
    mode: 'domain',
    username: `cfotp${Math.floor(10000 + Math.random() * 89999)}`,
    domain: 'fexpost.com',
  });
  assert.equal(created.status, 201);
  const mailbox = created.json.mailbox as {
    id: string;
    address: string;
    provider: string;
    isLive: boolean;
  };
  assert.ok(mailbox.id.startsWith('mb_'));
  assert.equal(mailbox.provider, 'tempmail_plus');
  assert.equal(mailbox.isLive, true);
  assert.ok(created.setCookies.some((c) => c.includes('HttpOnly') && c.includes('Secure')));

  // 2b. Create live Inboxes.com clean .com mailbox & poll it cleanly
  const inboxesDomain = domains.find((d) => d.provider === 'inboxes')!.domain;
  const createdInb = await callCf('POST', '/api/mailboxes', {
    mode: 'domain',
    username: `cfinb${Math.floor(10000 + Math.random() * 89999)}`,
    domain: inboxesDomain,
  });
  assert.equal(createdInb.status, 201);
  const inbMailbox = createdInb.json.mailbox as {
    id: string;
    provider: string;
    isLive: boolean;
  };
  assert.equal(inbMailbox.provider, 'inboxes');
  assert.equal(inbMailbox.isLive, true);

  const inbInbox = await callCf('GET', `/api/mailboxes/${inbMailbox.id}/messages`);
  assert.equal(inbInbox.status, 200);
  assert.ok(Array.isArray(inbInbox.json.messages));

  // 2c. Default generate + pregeneratedToken creates clean rotating domain (TempMail.lol) when available
  const genRes = await callCf('POST', '/api/mailboxes/generate', { mode: 'email' });
  assert.equal(genRes.status, 200);
  const genAddr = genRes.json.address as string;
  assert.ok(genAddr.includes('@'));
  const createdFromGen = await callCf('POST', '/api/mailboxes', {
    mode: 'email',
    email: genAddr,
    pregeneratedToken: genRes.json.pregeneratedToken as string | undefined,
  });
  assert.equal(createdFromGen.status, 201);
  const genMailbox = createdFromGen.json.mailbox as { id: string; address: string; provider: string };
  assert.equal(genMailbox.address, genAddr);

  // 3. List mailboxes and poll live messages cleanly
  const listed = await callCf('GET', '/api/mailboxes');
  assert.equal(listed.status, 200);
  assert.ok((listed.json.mailboxes as Array<{ id: string }>).some((m) => m.id === mailbox.id));
  assert.ok((listed.json.mailboxes as Array<{ id: string }>).some((m) => m.id === genMailbox.id));

  const inbox = await callCf('GET', `/api/mailboxes/${mailbox.id}/messages`);
  assert.equal(inbox.status, 200);
  assert.ok(Array.isArray(inbox.json.messages));

  const genInbox = await callCf('GET', `/api/mailboxes/${genMailbox.id}/messages`);
  assert.equal(genInbox.status, 200);
  assert.ok(Array.isArray(genInbox.json.messages));

  // 4. Removed fake test-email endpoint must return 404 JSON
  const fakeTest = await callCf('POST', `/api/mailboxes/${mailbox.id}/test-email`, {});
  assert.equal(fakeTest.status, 404);

  // 5. Delete mailboxes expire cookies and return 404 afterwards
  const delMb = await callCf('DELETE', `/api/mailboxes/${mailbox.id}`);
  assert.equal(delMb.status, 200);
  assert.equal(cookieJar.has(`tm_m_${mailbox.id}`), false);

  await callCf('DELETE', `/api/mailboxes/${inbMailbox.id}`);
  await callCf('DELETE', `/api/mailboxes/${genMailbox.id}`);
  const missing = await callCf('GET', `/api/mailboxes/${mailbox.id}/messages`);
  assert.equal(missing.status, 404);
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

test('MIME parser decodes RFC-2047 UTF-8 Vietnamese subject, quoted-printable text, and base64 HTML OTP email', () => {
  const utf8SubjectB64 = Buffer.from('Mã xác nhận Meta của bạn', 'utf8').toString('base64');
  const htmlB64 = Buffer.from(
    '<div><p>Mã xác nhận của bạn là:</p><table><tr><td>6</td><td>2</td><td>0</td><td>2</td><td>5</td><td>2</td></tr></table></div>',
    'utf8'
  ).toString('base64');

  const rawMime = [
    `From: "Meta Security" <security@account.meta.com>`,
    `To: user123@mycustom.dev`,
    `Subject: =?UTF-8?B?${utf8SubjectB64}?=`,
    `Date: Sun, 22 Nov 2026 09:30:00 +0000`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="bnd_otp_123"`,
    ``,
    `--bnd_otp_123`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    `M=C3=A3 x=C3=A1c nh=E1=BA=ADn c=E1=BB=A7a b=E1=BA=A1n l=C3=A0 620252.`,
    `--bnd_otp_123`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    htmlB64,
    `--bnd_otp_123--`,
  ].join('\r\n');

  assert.equal(decodeMimeHeader(`=?UTF-8?B?${utf8SubjectB64}?=`), 'Mã xác nhận Meta của bạn');
  const parsed = parseRawMimeEmail(rawMime, 'security@account.meta.com', 'user123@mycustom.dev');
  assert.equal(parsed.subject, 'Mã xác nhận Meta của bạn');
  assert.equal(parsed.fromName, 'Meta Security');
  assert.equal(parsed.fromAddress, 'security@account.meta.com');
  assert.ok(parsed.textBody.includes('620252'));
  assert.ok(parsed.htmlBody.includes('<td>6</td>'));
  assert.deepEqual(extractOtpCodes(`${parsed.textBody}\n${parsed.htmlBody}`, parsed.subject), ['620252']);
});

test('Cloudflare Worker email() + MAILBOX_KV receives real SMTP OTP email and serves it through API', async () => {
  const kvStore = new Map<string, string>();
  const mockKv: CloudflareKvNamespace = {
    async get(key: string) {
      return kvStore.get(key) ?? null;
    },
    async put(key: string, value: string) {
      kvStore.set(key, value);
    },
    async delete(key: string) {
      kvStore.delete(key);
    },
  };

  const env = {
    MAILBOX_SESSION_SECRET: 'cf-email-routing-test-secret',
    MAILBOX_KV: mockKv,
    CUSTOM_DOMAINS: 'otp.myprivate.dev',
  };

  const cookieJar = new Map<string, string>();
  const callWorker = async (method: string, path: string, body?: unknown) => {
    const cookieHeader = Array.from(cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const headers = new Headers({ Accept: 'application/json' });
    if (cookieHeader) headers.set('Cookie', cookieHeader);
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const res = await cfWorker.fetch(
      new Request(`https://tempmail.workers.dev${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      env
    );

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
      if (sc.includes('Max-Age=0') || !val) cookieJar.delete(name);
      else cookieJar.set(name, val);
    }

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  // 1. Custom domain appears first in /api/domains with provider cloudflare_email
  const domRes = await callWorker('GET', '/api/domains');
  assert.equal(domRes.status, 200);
  const domains = domRes.json.domains as Array<{ domain: string; provider: string }>;
  assert.equal(domains[0].domain, 'otp.myprivate.dev');
  assert.equal(domains[0].provider, 'cloudflare_email');

  // 2. Create mailbox on custom domain
  const createRes = await callWorker('POST', '/api/mailboxes', {
    mode: 'domain',
    username: 'luanotp',
    domain: 'otp.myprivate.dev',
  });
  assert.equal(createRes.status, 201);
  const mb = createRes.json.mailbox as { id: string; address: string; provider: string };
  assert.equal(mb.address, 'luanotp@otp.myprivate.dev');
  assert.equal(mb.provider, 'cloudflare_email');

  // 3. Simulate Cloudflare Email Routing delivering a real SMTP OTP message
  const rawSmtp = [
    'From: "Meta" <security@mail.instagram.com>',
    'To: luanotp@otp.myprivate.dev',
    'Subject: 847291 is your Instagram code',
    'Date: Sun, 22 Nov 2026 09:40:00 +0000',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Use verification code 847291 to confirm your account.',
  ].join('\r\n');

  const rawStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(rawSmtp));
      controller.close();
    },
  });

  await cfWorker.email(
    {
      from: 'security@mail.instagram.com',
      to: 'luanotp@otp.myprivate.dev',
      raw: rawStream,
      rawSize: rawSmtp.length,
    },
    env
  );

  // 4. Poll mailbox messages -> OTP 847291 arrives immediately
  const listRes = await callWorker('GET', `/api/mailboxes/${mb.id}/messages`);
  assert.equal(listRes.status, 200);
  const msgs = listRes.json.messages as Array<{ id: string; otpCodes: string[]; fromName: string }>;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].fromName, 'Meta');
  assert.deepEqual(msgs[0].otpCodes, ['847291']);

  // 5. Open full message detail
  const detailRes = await callWorker('GET', `/api/mailboxes/${mb.id}/messages/${msgs[0].id}`);
  assert.equal(detailRes.status, 200);
  const detail = detailRes.json.message as { textBody: string; otpCodes: string[]; isRead: boolean };
  assert.equal(detail.isRead, true);
  assert.deepEqual(detail.otpCodes, ['847291']);
  assert.ok(detail.textBody.includes('847291'));
});
