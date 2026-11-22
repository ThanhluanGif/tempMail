import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Inbox, Mail, MailOpen } from 'lucide-react';
import {
  ApiError,
  createMailbox,
  deleteMailbox,
  deleteMessage,
  fetchDomains,
  fetchMailboxes,
  fetchMessageDetail,
  fetchMessages,
  generateEmailPreview,
} from './api/mailClient';
import { MessageList } from './components/MessageList';
import { MessageReader } from './components/MessageReader';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import type {
  CreationMode,
  DomainInfo,
  EmailDetail,
  EmailSummary,
  GeneratedEmailPreview,
  Mailbox,
} from './types/mail';

type MobilePane = 'sidebar' | 'list' | 'reader';

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [isLoadingDomains, setIsLoadingDomains] = useState(false);

  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(null);

  const [messagesByMailbox, setMessagesByMailbox] = useState<Record<string, EmailSummary[]>>({});
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedMessageDetail, setSelectedMessageDetail] = useState<EmailDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const [isCreating, setIsCreating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeletingMessage, setIsDeletingMessage] = useState(false);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSyncedLabel, setLastSyncedLabel] = useState<string | null>(null);

  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('sidebar');

  const toastTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const activeMessageRequestRef = useRef(0);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2400);
  }, []);

  const handleCopyText = useCallback(
    async (value: string, label = 'Đã sao chép vào bộ nhớ tạm') => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        }
      } catch {
        // Clipboard permission may be restricted in headless contexts; still reflect UI feedback
      }
      setCopiedValue(value);
      showToast(label);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedValue(null), 2000);
    },
    [showToast]
  );

  const stampSyncTime = useCallback(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setLastSyncedLabel(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
  }, []);

  const loadDomains = useCallback(async (refresh = false) => {
    setIsLoadingDomains(true);
    try {
      const list = await fetchDomains(refresh);
      setDomains(list);
      if (refresh) {
        showToast(`Đã cập nhật ${list.length} tên miền hoạt động`);
      }
    } catch {
      if (refresh) {
        showToast('Không thể làm mới tên miền lúc này');
      }
    } finally {
      setIsLoadingDomains(false);
    }
  }, [showToast]);

  const loadMessagesForMailbox = useCallback(
    async (mailboxId: string, silent = false) => {
      if (!silent) setIsLoadingMessages(true);
      try {
        const { mailbox, messages } = await fetchMessages(mailboxId);
        if (Array.isArray(messages)) {
          setMessagesByMailbox((prev) => ({ ...prev, [mailboxId]: messages }));
        }
        if (mailbox?.id) {
          setMailboxes((prev) =>
            prev
              .filter((mb): mb is Mailbox => Boolean(mb?.id))
              .map((mb) => (mb.id === mailbox.id ? mailbox : mb))
          );
        }
        stampSyncTime();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Mailbox expired or server restarted — remove stale mailbox so polling stops cleanly
          setMailboxes((prev) => {
            const remaining = prev.filter((mb) => mb?.id && mb.id !== mailboxId);
            setSelectedMailboxId((curr) =>
              curr === mailboxId ? (remaining[0]?.id ?? null) : curr
            );
            return remaining;
          });
          setMessagesByMailbox((prev) => {
            const next = { ...prev };
            delete next[mailboxId];
            return next;
          });
          setSelectedMessageId(null);
          setSelectedMessageDetail(null);
        }
      } finally {
        if (!silent) setIsLoadingMessages(false);
      }
    },
    [stampSyncTime]
  );

  // Initial load of domains and existing session mailboxes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadDomains(false);
      try {
        const existing = await fetchMailboxes();
        if (cancelled) return;
        setMailboxes(existing);
        if (existing.length > 0) {
          const firstId = existing[0].id;
          setSelectedMailboxId(firstId);
          loadMessagesForMailbox(firstId, false);
        }
      } catch {
        // Fresh session with 0 mailboxes
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDomains, loadMessagesForMailbox]);

  // Auto-refresh polling for active mailbox
  useEffect(() => {
    if (!autoRefresh || !selectedMailboxId) return;
    const interval = window.setInterval(() => {
      loadMessagesForMailbox(selectedMailboxId, true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, selectedMailboxId, loadMessagesForMailbox]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      const list = await fetchMailboxes();
      setMailboxes(list);
      if (selectedMailboxId) {
        await loadMessagesForMailbox(selectedMailboxId, true);
      } else {
        await loadDomains(false);
        stampSyncTime();
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleGeneratePreview = async (mode: CreationMode): Promise<GeneratedEmailPreview | null> => {
    setIsGenerating(true);
    setFormError(null);
    try {
      const preview = await generateEmailPreview(mode);
      return preview;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Không thể tạo gợi ý email.');
      return null;
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCreateMailbox = async (options: {
    mode: CreationMode;
    email?: string;
    username?: string;
    domain?: string;
    pregeneratedToken?: string;
  }): Promise<boolean> => {
    setIsCreating(true);
    setFormError(null);
    try {
      const created = await createMailbox(options);
      if (!created?.id) {
        throw new Error('Không thể tạo hộp thư mới.');
      }
      setMailboxes((prev) => [
        created,
        ...prev.filter((m): m is Mailbox => Boolean(m?.id) && m.id !== created.id),
      ]);
      setSelectedMailboxId(created.id);
      setSelectedMessageId(null);
      setSelectedMessageDetail(null);
      setMobilePane('list');
      await handleCopyText(created.address, `Đã tạo & chép ${created.address}`);
      loadMessagesForMailbox(created.id, false);
      return true;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Không thể tạo hộp thư mới.');
      return false;
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectMailbox = (mailboxId: string) => {
    setSelectedMailboxId(mailboxId);
    setSelectedMessageId(null);
    setSelectedMessageDetail(null);
    setMobilePane('list');
    loadMessagesForMailbox(mailboxId, false);
  };

  const handleDeleteMailbox = async (mailboxId: string) => {
    try {
      await deleteMailbox(mailboxId);
      setMailboxes((prev) => {
        const remaining = prev.filter((m) => m.id !== mailboxId);
        if (selectedMailboxId === mailboxId) {
          const next = remaining[0]?.id ?? null;
          setSelectedMailboxId(next);
          setSelectedMessageId(null);
          setSelectedMessageDetail(null);
          if (next) {
            loadMessagesForMailbox(next, false);
          } else {
            setMobilePane('sidebar');
          }
        }
        return remaining;
      });
      setMessagesByMailbox((prev) => {
        const copy = { ...prev };
        delete copy[mailboxId];
        return copy;
      });
      showToast('Đã xóa hộp thư tạm');
    } catch {
      showToast('Không thể xóa hộp thư lúc này');
    }
  };

  const handleSelectMessage = async (messageId: string) => {
    if (!selectedMailboxId) return;
    const targetMailboxId = selectedMailboxId;
    const requestId = ++activeMessageRequestRef.current;
    const wasUnread = (messagesByMailbox[targetMailboxId] ?? []).some(
      (m) => m.id === messageId && !m.isRead
    );
    setSelectedMessageId(messageId);
    setIsLoadingDetail(true);
    setMobilePane('reader');
    try {
      const detail = await fetchMessageDetail(targetMailboxId, messageId);
      if (activeMessageRequestRef.current !== requestId) return;
      setSelectedMessageDetail(detail);
      setMessagesByMailbox((prev) => ({
        ...prev,
        [targetMailboxId]: (prev[targetMailboxId] ?? []).map((m) =>
          m.id === messageId ? { ...m, isRead: true, otpCodes: detail.otpCodes } : m
        ),
      }));
      if (wasUnread) {
        setMailboxes((prev) =>
          prev
            .filter((mb): mb is Mailbox => Boolean(mb?.id))
            .map((mb) =>
              mb.id === targetMailboxId
                ? { ...mb, unreadCount: Math.max(0, mb.unreadCount - 1) }
                : mb
            )
        );
      }
    } catch {
      if (activeMessageRequestRef.current === requestId) {
        showToast('Không thể tải nội dung thư');
      }
    } finally {
      if (activeMessageRequestRef.current === requestId) {
        setIsLoadingDetail(false);
      }
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!selectedMailboxId) return;
    setIsDeletingMessage(true);
    try {
      await deleteMessage(selectedMailboxId, messageId);
      setMessagesByMailbox((prev) => ({
        ...prev,
        [selectedMailboxId]: (prev[selectedMailboxId] ?? []).filter((m) => m.id !== messageId),
      }));
      setMailboxes((prev) =>
        prev.map((mb) =>
          mb.id === selectedMailboxId
            ? { ...mb, messageCount: Math.max(0, mb.messageCount - 1) }
            : mb
        )
      );
      if (selectedMessageId === messageId) {
        setSelectedMessageId(null);
        setSelectedMessageDetail(null);
        setMobilePane('list');
      }
      showToast('Đã xoá thư');
    } catch {
      showToast('Không thể xoá thư');
    } finally {
      setIsDeletingMessage(false);
    }
  };

  const selectedMailbox = mailboxes.find((mb) => mb.id === selectedMailboxId) ?? null;
  const activeMessages = selectedMailboxId ? messagesByMailbox[selectedMailboxId] ?? [] : [];

  return (
    <div className="macos-wallpaper h-dvh w-full md:p-2.5 flex items-stretch justify-center overflow-hidden">
      <div className="w-full h-full bg-white md:rounded-[12px] md:shadow-[0_12px_40px_rgba(15,23,42,0.14),0_2px_6px_rgba(15,23,42,0.06)] md:ring-1 md:ring-black/[0.08] flex flex-col overflow-hidden relative">
        <TitleBar
          isRefreshing={isRefreshing}
          autoRefresh={autoRefresh}
          onRefresh={handleManualRefresh}
          onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
        />

        {/* 3-Pane Workspace (Desktop) / Single-Pane Switcher (Mobile) */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div
            className={`${
              mobilePane === 'sidebar' ? 'flex w-full' : 'hidden'
            } md:flex md:w-auto min-h-0`}
          >
            <Sidebar
              domains={domains}
              isLoadingDomains={isLoadingDomains}
              mailboxes={mailboxes}
              selectedMailboxId={selectedMailboxId}
              isCreating={isCreating}
              isGenerating={isGenerating}
              formError={formError}
              copiedValue={copiedValue}
              onRefreshDomains={() => loadDomains(true)}
              onGeneratePreview={handleGeneratePreview}
              onCreateMailbox={handleCreateMailbox}
              onSelectMailbox={handleSelectMailbox}
              onDeleteMailbox={handleDeleteMailbox}
              onCopyText={handleCopyText}
              onClearError={() => setFormError(null)}
            />
          </div>

          <div
            className={`${
              mobilePane === 'list' ? 'flex w-full' : 'hidden'
            } md:flex md:w-auto min-h-0`}
          >
            <MessageList
              selectedMailbox={selectedMailbox}
              messages={activeMessages}
              selectedMessageId={selectedMessageId}
              isLoadingMessages={isLoadingMessages}
              copiedValue={copiedValue}
              onSelectMessage={handleSelectMessage}
              onCopyText={handleCopyText}
            />
          </div>

          <div
            className={`${
              mobilePane === 'reader' ? 'flex w-full' : 'hidden'
            } md:flex md:flex-1 min-w-0 min-h-0`}
          >
            <MessageReader
              message={selectedMessageDetail}
              isLoading={isLoadingDetail}
              isDeleting={isDeletingMessage}
              copiedValue={copiedValue}
              onBackToList={() => {
                setSelectedMessageId(null);
                setSelectedMessageDetail(null);
                setMobilePane('list');
              }}
              onDeleteMessage={handleDeleteMessage}
              onCopyText={handleCopyText}
            />
          </div>
        </div>

        {/* Mobile Bottom Navigation */}
        <nav
          aria-label="Điều hướng di động"
          className="md:hidden shrink-0 h-12 bg-white border-t border-[#E3E6EC] grid grid-cols-3"
        >
          <button
            type="button"
            onClick={() => setMobilePane('sidebar')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
              mobilePane === 'sidebar' ? 'text-[#007AFF]' : 'text-[#6B7280]'
            }`}
          >
            <Inbox className="w-4 h-4" />
            <span>Hộp thư ({mailboxes.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMobilePane('list')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
              mobilePane === 'list' ? 'text-[#007AFF]' : 'text-[#6B7280]'
            }`}
          >
            <Mail className="w-4 h-4" />
            <span>Thư đến ({activeMessages.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMobilePane('reader')}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
              mobilePane === 'reader' ? 'text-[#007AFF]' : 'text-[#6B7280]'
            }`}
          >
            <MailOpen className="w-4 h-4" />
            <span>Đọc thư</span>
          </button>
        </nav>

        <StatusBar
          mailboxCount={mailboxes.length}
          autoRefresh={autoRefresh}
          domainCount={domains.length}
          lastSyncedLabel={lastSyncedLabel}
        />

        {/* Subtle macOS Floating Feedback Toast */}
        {toastMessage && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#1D1D1F]/92 text-white text-[12.5px] font-medium shadow-lg whitespace-nowrap"
          >
            <Check className="w-3.5 h-3.5 text-[#34D399]" />
            <span>{toastMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
