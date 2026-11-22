import type {
  CreateMailboxPayload,
  DomainInfo,
  EmailDetail,
  EmailSummary,
  GeneratedEmailPreview,
  Mailbox,
} from '../types/mail';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errMsg =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Yêu cầu thất bại (HTTP ${response.status}).`;
    throw new ApiError(errMsg, response.status);
  }

  if (!isJson || data === null || typeof data !== 'object') {
    throw new ApiError('Phản hồi từ máy chủ không hợp lệ.', response.status);
  }

  return data as T;
}

export async function fetchDomains(refresh = false): Promise<DomainInfo[]> {
  const res = await apiRequest<{ domains?: DomainInfo[] }>(
    `/api/domains${refresh ? '?refresh=1' : ''}`
  );
  return Array.isArray(res.domains) ? res.domains : [];
}

export async function fetchMailboxes(): Promise<Mailbox[]> {
  const res = await apiRequest<{ mailboxes?: Mailbox[] }>('/api/mailboxes');
  return Array.isArray(res.mailboxes)
    ? res.mailboxes.filter((mb): mb is Mailbox => Boolean(mb && typeof mb.id === 'string'))
    : [];
}

export async function generateEmailPreview(
  mode: 'domain' | 'email'
): Promise<GeneratedEmailPreview> {
  const res = await apiRequest<GeneratedEmailPreview>('/api/mailboxes/generate', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
  if (!res || typeof res.address !== 'string') {
    throw new Error('Không thể tạo gợi ý email.');
  }
  return res;
}

export async function createMailbox(payload: CreateMailboxPayload): Promise<Mailbox> {
  const res = await apiRequest<{ mailbox?: Mailbox }>('/api/mailboxes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.mailbox || typeof res.mailbox.id !== 'string') {
    throw new Error('Không thể tạo hộp thư mới.');
  }
  return res.mailbox;
}

export async function deleteMailbox(mailboxId: string): Promise<void> {
  await apiRequest<{ deleted: boolean }>(`/api/mailboxes/${encodeURIComponent(mailboxId)}`, {
    method: 'DELETE',
  });
}

export async function fetchMessages(
  mailboxId: string
): Promise<{
  mailbox: Mailbox;
  messages: EmailSummary[];
  syncError?: string;
  rateLimited?: boolean;
}> {
  const res = await apiRequest<{
    mailbox?: Mailbox;
    messages?: EmailSummary[];
    syncError?: string;
    rateLimited?: boolean;
  }>(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages`);
  if (!res.mailbox || typeof res.mailbox.id !== 'string' || !Array.isArray(res.messages)) {
    throw new Error('Dữ liệu hộp thư không hợp lệ.');
  }
  return {
    mailbox: res.mailbox,
    messages: res.messages.filter((m): m is EmailSummary => Boolean(m && typeof m.id === 'string')),
    syncError: typeof res.syncError === 'string' ? res.syncError : undefined,
    rateLimited: Boolean(res.rateLimited),
  };
}

export async function fetchMessageDetail(
  mailboxId: string,
  messageId: string
): Promise<EmailDetail> {
  const res = await apiRequest<{ message?: EmailDetail }>(
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`
  );
  if (!res.message || typeof res.message.id !== 'string') {
    throw new Error('Không thể tải chi tiết thư.');
  }
  return res.message;
}

export async function deleteMessage(mailboxId: string, messageId: string): Promise<void> {
  await apiRequest<{ deleted: boolean }>(
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' }
  );
}
