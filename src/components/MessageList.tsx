import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Mail, RefreshCw, Search } from 'lucide-react';
import type { EmailSummary, Mailbox } from '../types/mail';
import {
  formatShortTime,
  getLatestOtpForMessages,
  getSenderInitial,
} from '../utils/tempMailLogic';

interface MessageListProps {
  selectedMailbox: Mailbox | null;
  messages: EmailSummary[];
  selectedMessageId: string | null;
  isLoadingMessages: boolean;
  syncError?: string | null;
  copiedValue: string | null;
  onSelectMessage: (messageId: string) => void;
  onCopyText: (value: string, label?: string) => void;
  onRetrySync?: () => void;
}

export function MessageList({
  selectedMailbox,
  messages,
  selectedMessageId,
  isLoadingMessages,
  syncError,
  copiedValue,
  onSelectMessage,
  onCopyText,
  onRetrySync,
}: MessageListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyOtp, setOnlyOtp] = useState(false);

  useEffect(() => {
    setSearchQuery('');
    setOnlyOtp(false);
  }, [selectedMailbox?.id]);

  const latestOtp = useMemo(() => getLatestOtpForMessages(messages), [messages]);
  const otpMessageCount = useMemo(
    () => messages.filter((m) => m.otpCodes.length > 0).length,
    [messages]
  );

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((m) => {
      if (onlyOtp && m.otpCodes.length === 0) return false;
      if (!q) return true;
      return (
        m.subject.toLowerCase().includes(q) ||
        m.fromName.toLowerCase().includes(q) ||
        m.fromAddress.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q) ||
        m.otpCodes.some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [messages, searchQuery, onlyOtp]);

  if (!selectedMailbox) {
    return (
      <section
        aria-label="Danh sách thư OTP"
        className="w-full md:w-[348px] shrink-0 bg-white md:border-r border-[#E5E8EE] flex flex-col items-center justify-center p-8 text-center min-h-0"
      >
        <Mail className="w-11 h-11 text-[#CBD0D8] stroke-[1.4]" aria-hidden="true" />
        <h2 className="mt-3 text-[15px] font-semibold text-[#525864]">Chưa chọn email lấy OTP</h2>
        <p className="mt-1.5 text-[13px] text-[#949CA9] max-w-[260px] leading-relaxed">
          Tạo địa chỉ tạm mới ở thanh bên để nhận mã xác minh OTP từ các dịch vụ trực tuyến.
        </p>
      </section>
    );
  }

  const isAddressCopied = copiedValue === selectedMailbox.address;
  const isLatestOtpCopied = Boolean(latestOtp && copiedValue === latestOtp.code);

  return (
    <section
      aria-label="Danh sách thư đến"
      className="w-full md:w-[348px] shrink-0 bg-white md:border-r border-[#E5E8EE] flex flex-col min-h-0"
    >
      {/* Active Mailbox Header */}
      <div className="px-4 py-3 border-b border-[#ECEFF4] bg-white shrink-0 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p
              title={selectedMailbox.address}
              className="font-mono text-[12.5px] font-semibold text-[#1D1D1F] truncate"
            >
              {selectedMailbox.address}
            </p>
            <p className="text-[11.5px] text-[#7D8696] mt-0.5 tabular-nums">
              {messages.length} thư · Tự động lấy OTP mỗi 10 giây
            </p>
          </div>
          <button
            type="button"
            onClick={() => onCopyText(selectedMailbox.address, 'Đã chép địa chỉ email')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#D8DEE7] bg-white hover:bg-[#F5F7FA] text-[12px] font-medium text-[#1D1D1F] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF]"
          >
            {isAddressCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                <span className="text-[#16A34A]">Đã chép</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-[#525866]" />
                <span>Chép</span>
              </>
            )}
          </button>
        </div>

        {/* Latest OTP Quick-Copy Bar */}
        {latestOtp && (
          <div className="rounded-lg bg-[#F0F7FF] border border-[#C6DFFF] px-3 py-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onSelectMessage(latestOtp.messageId)}
              className="min-w-0 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF] rounded"
            >
              <p className="text-[11px] font-medium text-[#476899] truncate">
                Mã OTP mới nhất · {latestOtp.fromName}
              </p>
              <p className="font-mono tabular-nums text-[18px] font-bold tracking-[0.12em] text-[#005FCC] leading-tight mt-0.5">
                {latestOtp.code}
              </p>
            </button>
            <button
              type="button"
              onClick={() => onCopyText(latestOtp.code, `Đã chép mã OTP ${latestOtp.code}`)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#007AFF] hover:bg-[#0068D9] text-white text-[12px] font-semibold shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#007AFF]"
            >
              {isLatestOtpCopied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Đã chép</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Chép OTP</span>
                </>
              )}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search
              className="w-3.5 h-3.5 text-[#949CA9] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="search-messages" className="sr-only">
              Tìm mã OTP hoặc người gửi
            </label>
            <input
              id="search-messages"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm mã OTP, người gửi..."
              className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-[#F4F6F9] border border-transparent focus:bg-white focus:border-[#007AFF] focus:outline-none text-[12.5px] text-[#1D1D1F] placeholder:text-[#949CA9] transition-colors"
            />
          </div>

          <button
            type="button"
            onClick={() => setOnlyOtp((prev) => !prev)}
            aria-pressed={onlyOtp}
            title="Chỉ hiện thư có mã OTP"
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF] ${
              onlyOtp
                ? 'bg-[#EEF5FF] border-[#99C7FF] text-[#005FCC]'
                : 'bg-[#F4F6F9] border-transparent text-[#5B6472] hover:bg-[#E9EDF3]'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span className="tabular-nums">OTP{otpMessageCount > 0 ? ` (${otpMessageCount})` : ''}</span>
          </button>
        </div>

        {syncError && (
          <div
            role="status"
            className="rounded-lg bg-[#FFFBEB] border border-[#FDE68A] px-2.5 py-2 flex items-start justify-between gap-2 text-[11.5px] text-[#92400E]"
          >
            <div className="flex items-start gap-1.5 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 text-[#D97706] shrink-0 mt-0.5" aria-hidden="true" />
              <span className="leading-snug">{syncError}</span>
            </div>
            {onRetrySync && (
              <button
                type="button"
                onClick={onRetrySync}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-[#FCD34D] hover:bg-[#FEF3C7] text-[11px] font-semibold text-[#92400E] whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#D97706]"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Thử lại</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Message List Content */}
      {isLoadingMessages && messages.length === 0 ? (
        <div className="p-4 space-y-3" aria-busy="true">
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="animate-pulse flex items-start gap-3 py-2">
              <div className="w-9 h-9 rounded-full bg-[#ECEFF4] shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 bg-[#ECEFF4] rounded w-2/3" />
                <div className="h-3 bg-[#F2F4F8] rounded w-5/6" />
                <div className="h-2.5 bg-[#F5F7FA] rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <KeyRound className="w-10 h-10 text-[#CBD0D8] stroke-[1.4]" aria-hidden="true" />
          <h3 className="mt-3 text-[14.5px] font-semibold text-[#525864]">Đang chờ mã OTP đến</h3>
          <p className="mt-1.5 text-[12.5px] text-[#949CA9] max-w-[260px] leading-relaxed">
            Dán địa chỉ email trên vào dịch vụ cần xác minh — hộp thư tự động kiểm tra mỗi 10 giây
            và giữ nguyên mã OTP khi làm mới.
          </p>
          <button
            type="button"
            onClick={() => onCopyText(selectedMailbox.address, 'Đã chép địa chỉ email')}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D4DAE3] bg-white hover:bg-[#F7F9FC] text-[12.5px] font-medium text-[#1D1D1F] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF]"
          >
            {isAddressCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                <span className="text-[#16A34A]">Đã chép địa chỉ email</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-[#525866]" />
                <span>Chép địa chỉ email</span>
              </>
            )}
          </button>
        </div>
      ) : filteredMessages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <p className="text-[13.5px] font-medium text-[#525864]">
            {onlyOtp ? 'Chưa có thư nào chứa mã OTP' : 'Không tìm thấy thư phù hợp'}
          </p>
          <p className="mt-1 text-[12px] text-[#949CA9]">
            {onlyOtp
              ? 'Tắt bộ lọc OTP để xem toàn bộ thư đã nhận.'
              : 'Thử từ khóa khác hoặc xóa bộ lọc tìm kiếm.'}
          </p>
        </div>
      ) : (
        <ul
          aria-label="Thư trong hộp thư đến"
          className="flex-1 overflow-y-auto thin-scroll divide-y divide-[#F1F3F7]"
        >
          {filteredMessages.map((msg) => {
            const isSelected = msg.id === selectedMessageId;
            const initial = getSenderInitial(msg.fromName, msg.fromAddress);
            const firstOtp = msg.otpCodes[0];
            const isRowOtpCopied = Boolean(firstOtp && copiedValue === firstOtp);

            return (
              <li
                key={msg.id}
                className={`transition-colors ${
                  isSelected ? 'bg-[#007AFF]/[0.08]' : 'bg-white hover:bg-[#F7F9FC]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectMessage(msg.id)}
                  aria-current={isSelected ? 'true' : undefined}
                  className="w-full text-left px-4 pt-3.5 pb-2.5 flex items-start gap-3 cursor-pointer focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#007AFF]"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-semibold shrink-0 mt-0.5 ${
                      isSelected
                        ? 'bg-[#007AFF] text-white'
                        : 'bg-[#EEF4FF] text-[#0066D6]'
                    }`}
                    aria-hidden="true"
                  >
                    {initial}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {!msg.isRead && (
                          <span
                            className="w-2 h-2 rounded-full bg-[#007AFF] shrink-0"
                            aria-label="Chưa đọc"
                          />
                        )}
                        <span
                          className={`text-[13.5px] truncate ${
                            msg.isRead
                              ? 'font-medium text-[#374151]'
                              : 'font-semibold text-[#1D1D1F]'
                          }`}
                        >
                          {msg.fromName}
                        </span>
                      </div>
                      <span className="text-[11px] text-[#8E95A2] tabular-nums shrink-0">
                        {formatShortTime(msg.receivedAt)}
                      </span>
                    </div>

                    <p
                      className={`text-[13px] truncate mt-0.5 ${
                        msg.isRead ? 'text-[#4B5563]' : 'font-medium text-[#1D1D1F]'
                      }`}
                    >
                      {msg.subject}
                    </p>

                    <p className="text-[12px] text-[#8B93A1] truncate mt-0.5">{msg.snippet}</p>
                  </div>
                </button>

                {firstOtp && (
                  <div className="pl-[64px] pr-4 pb-3 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onCopyText(firstOtp, `Đã chép mã OTP ${firstOtp}`)}
                      aria-label={`Chép mã OTP ${firstOtp} từ ${msg.fromName}`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#EEF5FF] hover:bg-[#DFECFF] border border-[#CFE2FF] text-[12px] font-mono tabular-nums font-bold text-[#005FCC] tracking-[0.06em] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF]"
                    >
                      <span>OTP: {firstOtp}</span>
                      {isRowOtpCopied ? (
                        <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                      ) : (
                        <Copy className="w-3 h-3 text-[#007AFF]" />
                      )}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
