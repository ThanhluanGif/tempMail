export type MailProvider = 'mailtm' | 'tempmail_plus' | 'tempmail_lol';

export type CreationMode = 'domain' | 'email';

export interface DomainInfo {
  domain: string;
  provider: MailProvider;
  active: boolean;
}

export interface Mailbox {
  id: string;
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  createdAt: string;
  unreadCount: number;
  messageCount: number;
  isLive: boolean;
}

export interface EmailSummary {
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

export interface EmailDetail extends EmailSummary {
  textBody: string;
  htmlBody: string;
  rawSource: string;
}

export interface CreateMailboxPayload {
  mode: CreationMode;
  username?: string;
  domain?: string;
  email?: string;
  pregeneratedToken?: string;
  pregeneratedProvider?: MailProvider;
}

export interface GeneratedEmailPreview {
  address: string;
  username: string;
  domain: string;
  provider: MailProvider;
  pregeneratedToken?: string;
}
