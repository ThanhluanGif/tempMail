import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import type {
  CreateMailboxPayload,
  DomainInfo,
  EmailDetail,
  EmailSummary,
  GeneratedEmailPreview,
  Mailbox,
  MailProvider,
} from './src/types/mail';
import {
  buildSampleTestEmail,
  extractOtpCodes,
  generateFakerUsername,
  parseEmailInput,
  sanitizeEmailHtml,
  stripHtmlToText,
} from './src/utils/tempMailLogic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
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

interface StoredMailbox {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  createdAt: string;
  isLive: boolean;
  // Server-only provider credentials (never exposed to browser)
  mailtmAccountId?: string;
  mailtmToken?: string;
  tempmailLolToken?: string;
  guerrillaSid?: string;
  // Local sample / cached messages
  localMessages: EmailDetail[];
  deletedMessageIds: Set<string>;
  readMessageIds: Set<string>;
  sampleCounter: number;
  lastKnownRemoteCount: number;
  lastKnownRemoteUnread: number;
}

interface PendingGeneratedEmail {
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  token: string;
  createdAt: number;
}

const mailboxes = new Map<string, StoredMailbox>();
const pendingGenerated = new Map<string, PendingGeneratedEmail>();

let cachedDomains: DomainInfo[] = [];
let domainsFetchedAt = 0;
const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000;

const SAFE_ID_RE = /^[a-zA-Z0-9._-]{2,128}$/;

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
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`);
  }
  return (await response.json()) as T;
}

async function fetchLiveDomains(forceRefresh = false): Promise<DomainInfo[]> {
  const now = Date.now();
  if (!forceRefresh && cachedDomains.length > 0 && now - domainsFetchedAt < DOMAIN_CACHE_TTL_MS) {
    return cachedDomains;
  }

  const domains: DomainInfo[] = [];

  try {
    const data = await fetchJson<{
      'hydra:member'?: Array<{ domain?: string; isActive?: boolean }>;
    }>(`${MAILTM_API}/domains`);
    const members = data['hydra:member'] ?? [];
    for (const item of members) {
      if (item.domain && item.isActive !== false) {
        domains.push({
          domain: item.domain.toLowerCase(),
          provider: 'mailtm',
          active: true,
        });
      }
    }
  } catch {
    // Mail.tm temporarily unavailable; GuerrillaMail domains remain available
  }

  for (const d of GUERRILLA_DOMAINS) {
    if (!domains.some((item) => item.domain === d)) {
      domains.push({
        domain: d,
        provider: 'guerrilla',
        active: true,
      });
    }
  }

  cachedDomains = domains;
  domainsFetchedAt = now;
  return domains;
}

function toPublicMailbox(mb: StoredMailbox): Mailbox {
  const activeLocal = mb.localMessages.filter((m) => !mb.deletedMessageIds.has(m.id));
  const localUnread = activeLocal.filter((m) => !mb.readMessageIds.has(m.id)).length;
  return {
    id: mb.id,
    address: mb.address,
    username: mb.username,
    domain: mb.domain,
    provider: mb.provider,
    createdAt: mb.createdAt,
    messageCount: activeLocal.length + mb.lastKnownRemoteCount,
    unreadCount: localUnread + mb.lastKnownRemoteUnread,
    isLive: mb.isLive,
  };
}

function cleanupPendingGenerated() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, item] of pendingGenerated.entries()) {
    if (item.createdAt < cutoff) {
      pendingGenerated.delete(key);
    }
  }
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

async function createGuerrillaAccount(
  username: string,
  domain: string
): Promise<{ sid: string; address: string }> {
  const initData = await fetchJson<{ sid_token?: string; email_addr?: string }>(
    `${GUERRILLA_API}?f=get_email_address`
  );
  if (!initData.sid_token) {
    throw new Error('GuerrillaMail session unavailable');
  }
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

async function fetchRemoteMessages(mb: StoredMailbox): Promise<EmailDetail[]> {
  if (!mb.isLive) return [];

  if (mb.provider === 'mailtm' && mb.mailtmToken) {
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
        headers: { Authorization: `Bearer ${mb.mailtmToken}` },
      });

      const items = (list['hydra:member'] ?? []).filter((m) => !mb.deletedMessageIds.has(m.id));
      return items.map((item) => {
        const subject = item.subject || '(Không có tiêu đề)';
        const snippet = item.intro || '';
        const otpCodes = extractOtpCodes(snippet, subject);
        return {
          id: item.id,
          mailboxId: mb.id,
          fromName: item.from?.name || item.from?.address?.split('@')[0] || 'Người gửi',
          fromAddress: item.from?.address || 'unknown@sender',
          toAddress: item.to?.[0]?.address || mb.address,
          subject,
          snippet,
          receivedAt: item.createdAt || new Date().toISOString(),
          isRead: Boolean(item.seen) || mb.readMessageIds.has(item.id),
          otpCodes,
          textBody: snippet,
          htmlBody: '',
          rawSource: '',
        };
      });
    } catch {
      return [];
    }
  }

  if (mb.provider === 'tempmail_lol' && mb.tempmailLolToken) {
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
      }>(`${TEMPMAIL_LOL_API}/inbox?token=${encodeURIComponent(mb.tempmailLolToken)}`);

      const emails = data.emails ?? [];
      return emails
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
          const otpCodes = extractOtpCodes(`${textBody}\n${htmlBody}`, subject);
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
            otpCodes,
            textBody,
            htmlBody,
            rawSource,
          };
        })
        .filter((m) => !mb.deletedMessageIds.has(m.id));
    } catch {
      return [];
    }
  }

  if (mb.provider === 'guerrilla' && mb.guerrillaSid) {
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
      }>(`${GUERRILLA_API}?f=get_email_list&offset=0&sid_token=${encodeURIComponent(mb.guerrillaSid)}`);

      // Filter out GuerrillaMail's synthetic default welcome promo message
      const items = (data.list ?? []).filter((m) => {
        const isDefaultPromo =
          String(m.mail_id) === '1' ||
          (m.mail_from?.toLowerCase() === 'no-reply@guerrillamail.com' &&
            m.mail_subject === 'Welcome to Guerrilla Mail');
        return !isDefaultPromo && !mb.deletedMessageIds.has(`gm_${m.mail_id}`);
      });

      return items.map((item) => {
        const id = `gm_${item.mail_id}`;
        const parsedFrom = parseFromHeader(item.mail_from || 'unknown@sender');
        const subject = item.mail_subject || '(Không có tiêu đề)';
        const snippet = stripHtmlToText(item.mail_excerpt || '');
        const ts = Number(item.mail_timestamp);
        const receivedAt =
          Number.isFinite(ts) && ts > 1_000_000_000
            ? new Date(ts * 1000).toISOString()
            : new Date().toISOString();
        const otpCodes = extractOtpCodes(snippet, subject);

        return {
          id,
          mailboxId: mb.id,
          fromName: parsedFrom.name,
          fromAddress: parsedFrom.address,
          toAddress: mb.address,
          subject,
          snippet,
          receivedAt,
          isRead: item.mail_read === '1' || mb.readMessageIds.has(id),
          otpCodes,
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

function parseFromHeader(raw: string): { name: string; address: string } {
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const cleanName = match[1].replace(/^["'\s]+|["'\s]+$/g, '');
    return { name: cleanName || match[2].split('@')[0], address: match[2].trim() };
  }
  const trimmed = raw.trim();
  return { name: trimmed.split('@')[0] || 'Người gửi', address: trimmed };
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // 1. GET /api/domains — Live domains list
  app.get('/api/domains', async (req, res) => {
    try {
      const force = req.query.refresh === '1';
      const domains = await fetchLiveDomains(force);
      res.json({ domains });
    } catch {
      res.status(502).json({ error: 'Không thể tải danh sách tên miền.' });
    }
  });

  // 2. GET /api/mailboxes — List active mailboxes in current server session
  app.get('/api/mailboxes', (_req, res) => {
    const list = Array.from(mailboxes.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(toPublicMailbox);
    res.json({ mailboxes: list });
  });

  // 3. POST /api/mailboxes/generate — Generate a fresh email address preview
  app.post('/api/mailboxes/generate', async (req, res) => {
    cleanupPendingGenerated();
    const mode = req.body?.mode === 'domain' ? 'domain' : 'email';

    if (mode === 'email') {
      // Try TempMail.lol first for instant unique system email address
      try {
        const created = await createTempMailLolAccount();
        const [username, domain] = created.address.split('@');
        const previewId = crypto.randomBytes(12).toString('hex');
        pendingGenerated.set(previewId, {
          address: created.address,
          username,
          domain,
          provider: 'tempmail_lol',
          token: created.token,
          createdAt: Date.now(),
        });
        const payload: GeneratedEmailPreview = {
          address: created.address,
          username,
          domain,
          provider: 'tempmail_lol',
          pregeneratedToken: previewId,
        };
        res.json(payload);
        return;
      } catch {
        // Fall through to Mail.tm / GuerrillaMail preview
      }
    }

    const domains = await fetchLiveDomains();
    const preferred = domains[0] ?? { domain: 'sharklasers.com', provider: 'guerrilla' as MailProvider, active: true };
    const username = generateFakerUsername();
    const payload: GeneratedEmailPreview = {
      address: `${username}@${preferred.domain}`,
      username,
      domain: preferred.domain,
      provider: preferred.provider,
    };
    res.json(payload);
  });

  // 4. POST /api/mailboxes — Create and activate a real disposable mailbox
  app.post('/api/mailboxes', async (req, res) => {
    cleanupPendingGenerated();
    const body = (req.body ?? {}) as CreateMailboxPayload;
    const mode = body.mode === 'domain' ? 'domain' : 'email';
    const domains = await fetchLiveDomains();

    let createdMailbox: StoredMailbox | null = null;

    // Case A: Activating a pregenerated TempMail.lol system email from "Generate email"
    if (body.pregeneratedToken && pendingGenerated.has(body.pregeneratedToken)) {
      const pending = pendingGenerated.get(body.pregeneratedToken)!;
      pendingGenerated.delete(body.pregeneratedToken);
      const id = `mb_${crypto.randomBytes(8).toString('hex')}`;
      createdMailbox = {
        id,
        address: pending.address,
        username: pending.username,
        domain: pending.domain,
        provider: 'tempmail_lol',
        createdAt: new Date().toISOString(),
        isLive: true,
        tempmailLolToken: pending.token,
        localMessages: [],
        deletedMessageIds: new Set(),
        readMessageIds: new Set(),
        sampleCounter: 0,
        lastKnownRemoteCount: 0,
        lastKnownRemoteUnread: 0,
      };
    } else if (mode === 'email' && !body.email?.trim()) {
      // Instant creation in Email mode without pre-clicking Generate email
      try {
        const tml = await createTempMailLolAccount();
        const [username, domain] = tml.address.split('@');
        createdMailbox = {
          id: `mb_${crypto.randomBytes(8).toString('hex')}`,
          address: tml.address,
          username,
          domain,
          provider: 'tempmail_lol',
          createdAt: new Date().toISOString(),
          isLive: true,
          tempmailLolToken: tml.token,
          localMessages: [],
          deletedMessageIds: new Set(),
          readMessageIds: new Set(),
          sampleCounter: 0,
          lastKnownRemoteCount: 0,
          lastKnownRemoteUnread: 0,
        };
      } catch {
        // Fall through to Mail.tm / GuerrillaMail below
      }
    }

    if (!createdMailbox) {
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
        res.status(400).json({ error: parsed.error || 'Dữ liệu email không hợp lệ.' });
        return;
      }

      const username = parsed.username;
      const requestedDomain = parsed.domain;
      const domainEntry = domains.find((d) => d.domain === requestedDomain);

      // Avoid exact duplicate active mailbox; return existing if already created
      const existing = Array.from(mailboxes.values()).find(
        (m) => m.address.toLowerCase() === `${username}@${requestedDomain}`.toLowerCase()
      );
      if (existing) {
        res.json({ mailbox: toPublicMailbox(existing) });
        return;
      }

      const id = `mb_${crypto.randomBytes(8).toString('hex')}`;

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
            localMessages: [],
            deletedMessageIds: new Set(),
            readMessageIds: new Set(),
            sampleCounter: 0,
            lastKnownRemoteCount: 0,
            lastKnownRemoteUnread: 0,
          };
        } catch {
          // If username taken on mail.tm or rate limited, retry with suffix or fallback
        }
      }

      if (!createdMailbox && (domainEntry?.provider === 'guerrilla' || !domainEntry)) {
        try {
          const targetDomain = domainEntry ? requestedDomain : 'sharklasers.com';
          const gm = await createGuerrillaAccount(username, targetDomain);
          const [gmUser, gmDom] = gm.address.split('@');
          createdMailbox = {
            id,
            address: gm.address,
            username: gmUser,
            domain: gmDom,
            provider: 'guerrilla',
            createdAt: new Date().toISOString(),
            isLive: true,
            guerrillaSid: gm.sid,
            localMessages: [],
            deletedMessageIds: new Set(),
            readMessageIds: new Set(),
            sampleCounter: 0,
            lastKnownRemoteCount: 0,
            lastKnownRemoteUnread: 0,
          };
        } catch {
          // Final resilient fallback so app remains usable even if upstream APIs rate-limit
        }
      }

      if (!createdMailbox) {
        createdMailbox = {
          id,
          address: `${username}@${requestedDomain}`,
          username,
          domain: requestedDomain,
          provider: 'local',
          createdAt: new Date().toISOString(),
          isLive: false,
          localMessages: [],
          deletedMessageIds: new Set(),
          readMessageIds: new Set(),
          sampleCounter: 0,
          lastKnownRemoteCount: 0,
          lastKnownRemoteUnread: 0,
        };
      }
    }

    mailboxes.set(createdMailbox.id, createdMailbox);
    res.status(201).json({ mailbox: toPublicMailbox(createdMailbox) });
  });

  // 5. DELETE /api/mailboxes/:id — Remove mailbox
  app.delete('/api/mailboxes/:id', async (req, res) => {
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
  });

  // 6. GET /api/mailboxes/:id/messages — Poll live & local messages
  app.get('/api/mailboxes/:id/messages', async (req, res) => {
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

    const remoteMessages = await fetchRemoteMessages(mb);
    mb.lastKnownRemoteCount = remoteMessages.length;
    mb.lastKnownRemoteUnread = remoteMessages.filter((m) => !m.isRead).length;

    const activeLocal = mb.localMessages
      .filter((m) => !mb.deletedMessageIds.has(m.id))
      .map((m) => ({
        ...m,
        isRead: mb.readMessageIds.has(m.id),
      }));

    const merged = [...activeLocal, ...remoteMessages].sort(
      (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
    );

    res.json({
      mailbox: toPublicMailbox(mb),
      messages: merged.map(toSummary),
    });
  });

  // 7. GET /api/mailboxes/:id/messages/:messageId — Read full email detail & source
  app.get('/api/mailboxes/:id/messages/:messageId', async (req, res) => {
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

    // Check local messages first
    const localHit = mb.localMessages.find(
      (m) => m.id === messageId && !mb.deletedMessageIds.has(m.id)
    );
    if (localHit) {
      mb.readMessageIds.add(messageId);
      res.json({ message: { ...localHit, isRead: true } });
      return;
    }

    // Mail.tm full detail + raw source
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
        // Mark seen upstream quietly
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

    // TempMail.lol full detail
    if (mb.provider === 'tempmail_lol' && mb.tempmailLolToken) {
      const all = await fetchRemoteMessages(mb);
      const hit = all.find((m) => m.id === messageId);
      if (hit) {
        mb.readMessageIds.add(messageId);
        res.json({ message: { ...hit, isRead: true } });
        return;
      }
    }

    // GuerrillaMail full detail
    if (mb.provider === 'guerrilla' && mb.guerrillaSid && messageId.startsWith('gm_')) {
      const rawId = messageId.slice(3);
      try {
        const data = await fetchJson<{
          mail_id?: string;
          mail_from?: string;
          mail_subject?: string;
          mail_body?: string;
          mail_timestamp?: string;
        }>(
          `${GUERRILLA_API}?f=fetch_email&email_id=${encodeURIComponent(rawId)}&sid_token=${encodeURIComponent(mb.guerrillaSid)}`
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
        const otpCodes = extractOtpCodes(`${textBody}\n${htmlBody}`, subject);
        const rawSource = [
          `Delivered-To: ${mb.address}`,
          `From: ${data.mail_from || ''}`,
          `To: <${mb.address}>`,
          `Date: ${new Date(receivedAt).toUTCString()}`,
          `Subject: ${subject}`,
          ``,
          textBody,
        ].join('\r\n');

        mb.readMessageIds.add(messageId);
        const full: EmailDetail = {
          id: messageId,
          mailboxId: mb.id,
          fromName: parsedFrom.name,
          fromAddress: parsedFrom.address,
          toAddress: mb.address,
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

    res.status(404).json({ error: 'Không tìm thấy thư.' });
  });

  // 8. DELETE /api/mailboxes/:id/messages/:messageId — Delete a message
  app.delete('/api/mailboxes/:id/messages/:messageId', async (req, res) => {
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
    mb.localMessages = mb.localMessages.filter((m) => m.id !== messageId);

    if (mb.provider === 'mailtm' && mb.mailtmToken && !messageId.startsWith('sample_')) {
      fetch(`${MAILTM_API}/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${mb.mailtmToken}` },
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    } else if (mb.provider === 'guerrilla' && mb.guerrillaSid && messageId.startsWith('gm_')) {
      const rawId = messageId.slice(3);
      fetch(
        `${GUERRILLA_API}?f=del_email&email_ids[]=${encodeURIComponent(rawId)}&sid_token=${encodeURIComponent(mb.guerrillaSid)}`,
        { signal: AbortSignal.timeout(4000) }
      ).catch(() => {});
    }

    res.json({ deleted: true, messageId });
  });

  // 9. POST /api/mailboxes/:id/test-email — Deliver a realistic OTP test email (Meta 620252, GitHub, Notion)
  app.post('/api/mailboxes/:id/test-email', (req, res) => {
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

    const sample = buildSampleTestEmail(mb.address, mb.sampleCounter);
    mb.sampleCounter += 1;

    const msgId = `sample_${crypto.randomBytes(6).toString('hex')}`;
    const otpCodes = extractOtpCodes(sample.textBody, sample.subject);
    const detail: EmailDetail = {
      id: msgId,
      mailboxId: mb.id,
      fromName: sample.fromName,
      fromAddress: sample.fromAddress,
      toAddress: mb.address,
      subject: sample.subject,
      snippet: sample.textBody.replace(/\s+/g, ' ').slice(0, 140),
      receivedAt: sample.receivedAt,
      isRead: false,
      otpCodes,
      isSample: true,
      textBody: sample.textBody,
      htmlBody: sanitizeEmailHtml(sample.htmlBody),
      rawSource: sample.rawSource,
    };

    mb.localMessages.unshift(detail);
    res.status(201).json({ message: toSummary(detail), mailbox: toPublicMailbox(mb) });
  });

  // Ensure unmatched /api/* routes always return JSON rather than SPA index.html
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint không tồn tại.' });
  });

  if (IS_PROD) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Fallback index.html in dev for client routes
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TempMail server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
