import { useMemo, useState } from 'react';
import { Check, Copy, Mail, Search, Send } from 'lucide-react';
import type { EmailSummary, Mailbox } from '../types/mail';
import { formatShortTime, getSenderInitial } from '../utils/tempMailLogic';

interface MessageListProps {
  selectedMailbox: Mailbox | null;
  messages: EmailSummary[];
  selectedMessageId: string | null;
  isLoadingMessages: boolean;
  isSendingSample: boolean;
  copiedValue: string | null;
  onSelectMessage: (messageId: string) => void;
  onCopyText: (value: string, label?: string) => void;
  onSendSampleEmail: () => void;
}

export function MessageList({
  selectedMailbox,
  messages,
  selectedMessageId,
  isLoadingMessages,
  isSendingSample,
  copiedValue,
  onSelectMessage,
  onCopyText,
  onSendSampleEmail,
}: MessageListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.fromName.toLowerCase().includes(q) ||
        m.fromAddress.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q) ||
        m.otpCodes.some((c) => c.toLowerCase().includes(q))
    );
  }, [messages, searchQuery]);

  if (!selectedMailbox) {
    return (
      <section
        aria-label="Danh sách thư"
        className="w-full md:w-[348px] shrink-0 bg-white md:border-r border-[#E5E8EE] flex flex-col items-center justify-center p-8 text-center min-h-0"
      >
        <Mail className="w-11 h-11 text-[#CBD0D8] stroke-[1.4]" aria-hidden="true" />
        <h2 className="mt-3 text-[15px] font-semibold text-[#525864]">Chưa chọn hộp thư</h2>
        <p className="mt-1.5 text-[13px] text-[#949CA9] max-w-[260px] leading-relaxed">
          Tạo địa chỉ tạm mới ở thanh bên — username faker, domain ngẫu nhiên hoặc email của hệ
          thống.
        </p>
      </section>
    );
  }

  const isAddressCopied = copiedValue === selectedMailbox.address;

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
              {messages.length} thư · {selectedMailbox.isLive ? 'Nhận thư thực' : 'Hộp thư cục bộ'}
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

        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search
              className="w-3.5 h-3.5 text-[#949CA9] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="search-messages" className="sr-only">
              Tìm thư hoặc mã OTP
            </label>
            <input
              id="search-messages"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm thư hoặc mã OTP..."
              className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-[#F4F6F9] border border-transparent focus:bg-white focus:border-[#007AFF] focus:outline-none text-[12.5px] text-[#1D1D1F] placeholder:text-[#949CA9] transition-colors"
            />
          </div>

          <button
            type="button"
            onClick={onSendSampleEmail}
            disabled={isSendingSample}
            title="Nhận thư xác minh OTP mẫu để kiểm thử"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#EEF4FF] hover:bg-[#E1ECFF] text-[#0066D6] text-[12px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[#007AFF]"
          >
            <Send className="w-3 h-3" />
            <span>{isSendingSample ? 'Đang gửi...' : 'Thư thử OTP'}</span>
          </button>
        </div>
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
          <Mail className="w-10 h-10 text-[#CBD0D8] stroke-[1.4]" aria-hidden="true" />
          <h3 className="mt-3 text-[14.5px] font-semibold text-[#525864]">Đang chờ thư đến</h3>
          <p className="mt-1.5 text-[12.5px] text-[#949CA9] max-w-[250px] leading-relaxed">
            Gửi email bất kỳ tới địa chỉ trên để nhận trực tiếp, hoặc bấm nút bên dưới để nhận thư
            xác nhận OTP mẫu.
          </p>
          <button
            type="button"
            onClick={onSendSampleEmail}
            disabled={isSendingSample}
            className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#D4DAE3] bg-white hover:bg-[#F7F9FC] text-[12.5px] font-semibold text-[#1D1D1F] transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF]"
          >
            <Send className="w-3.5 h-3.5 text-[#007AFF]" />
            <span>{isSendingSample ? 'Đang gửi...' : 'Nhận thư thử OTP (Meta)'}</span>
          </button>
        </div>
      ) : filteredMessages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <p className="text-[13.5px] font-medium text-[#525864]">Không tìm thấy thư phù hợp</p>
          <p className="mt-1 text-[12px] text-[#949CA9]">Thử từ khóa khác hoặc xóa bộ lọc tìm kiếm.</p>
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

            return (
              <li key={msg.id}>
                <button
                  type="button"
                  onClick={() => onSelectMessage(msg.id)}
                  aria-current={isSelected ? 'true' : undefined}
                  className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#007AFF] ${
                    isSelected
                      ? 'bg-[#007AFF]/[0.08]'
                      : 'bg-white hover:bg-[#F7F9FC]'
                  }`}
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

                    {firstOtp && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-[#0066D6] font-mono tabular-nums font-semibold">
                        <span>OTP: {firstOtp}</span>
                      </div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
