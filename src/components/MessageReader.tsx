import { useState } from 'react';
import { ArrowLeft, Check, Code2, Copy, FileText, Mail, Trash2 } from 'lucide-react';
import type { EmailDetail } from '../types/mail';
import { formatEmailDate, getSenderInitial } from '../utils/tempMailLogic';

type ReaderViewMode = 'html' | 'text' | 'source';

interface MessageReaderProps {
  message: EmailDetail | null;
  isLoading: boolean;
  isDeleting: boolean;
  copiedValue: string | null;
  onBackToList: () => void;
  onDeleteMessage: (messageId: string) => void;
  onCopyText: (value: string, label?: string) => void;
}

export function MessageReader({
  message,
  isLoading,
  isDeleting,
  copiedValue,
  onBackToList,
  onDeleteMessage,
  onCopyText,
}: MessageReaderProps) {
  const [viewMode, setViewMode] = useState<ReaderViewMode>('html');

  if (isLoading) {
    return (
      <main
        aria-label="Nội dung thư"
        className="flex-1 min-w-0 bg-[#F5F6F8] p-6 overflow-y-auto thin-scroll"
      >
        <div className="max-w-3xl mx-auto bg-white rounded-xl border border-[#E5E8EE] p-6 space-y-4 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#ECEFF4]" />
            <div className="space-y-2 flex-1">
              <div className="h-4 bg-[#ECEFF4] rounded w-40" />
              <div className="h-3 bg-[#F2F4F8] rounded w-60" />
            </div>
          </div>
          <div className="h-5 bg-[#ECEFF4] rounded w-3/4" />
          <div className="space-y-2.5 pt-2">
            <div className="h-3.5 bg-[#F2F4F8] rounded w-full" />
            <div className="h-3.5 bg-[#F2F4F8] rounded w-11/12" />
            <div className="h-3.5 bg-[#F2F4F8] rounded w-2/3" />
          </div>
        </div>
      </main>
    );
  }

  if (!message) {
    return (
      <main
        aria-label="Nội dung thư"
        className="flex-1 min-w-0 bg-[#F5F6F8] flex flex-col items-center justify-center p-8 text-center min-h-0"
      >
        <Mail className="w-11 h-11 text-[#CBD0D8] stroke-[1.4]" aria-hidden="true" />
        <h2 className="mt-3 text-[15px] font-semibold text-[#525864]">Không có thư nào được chọn</h2>
        <p className="mt-1.5 text-[13px] text-[#949CA9] max-w-[290px] leading-relaxed">
          Chọn một thư trong danh sách để đọc. Mã OTP sẽ tự được nhận diện và nổi bật để chép nhanh.
        </p>
      </main>
    );
  }

  const initial = getSenderInitial(message.fromName, message.fromAddress);
  const activeView: ReaderViewMode =
    viewMode === 'html' && !message.htmlBody ? 'text' : viewMode;
  const primaryOtp = message.otpCodes[0];

  return (
    <main aria-label="Chi tiết thư" className="flex-1 min-w-0 bg-[#F5F6F8] flex flex-col min-h-0">
      {/* Reader Action Toolbar */}
      <div className="px-4 sm:px-5 py-2.5 bg-white border-b border-[#E5E8EE] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <button
          type="button"
          onClick={onBackToList}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] font-medium text-[#374151] hover:bg-[#F3F5F8] transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF]"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Quay lại danh sách</span>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <div
            role="tablist"
            aria-label="Chế độ xem nội dung thư"
            className="inline-flex items-center p-0.5 bg-[#F1F3F6] rounded-lg border border-[#E5E8EE]"
          >
            {message.htmlBody && (
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'html'}
                onClick={() => setViewMode('html')}
                className={`px-2.5 py-1 text-[12px] rounded-[6px] transition-colors whitespace-nowrap cursor-pointer ${
                  activeView === 'html'
                    ? 'bg-white text-[#1D1D1F] font-semibold shadow-xs'
                    : 'text-[#6B7280] font-medium hover:text-[#1D1D1F]'
                }`}
              >
                Hiển thị
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'text'}
              onClick={() => setViewMode('text')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[12px] rounded-[6px] transition-colors whitespace-nowrap cursor-pointer ${
                activeView === 'text'
                  ? 'bg-white text-[#1D1D1F] font-semibold shadow-xs'
                  : 'text-[#6B7280] font-medium hover:text-[#1D1D1F]'
              }`}
            >
              <FileText className="w-3 h-3" />
              <span>Văn bản</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'source'}
              onClick={() => setViewMode('source')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[12px] rounded-[6px] transition-colors whitespace-nowrap cursor-pointer ${
                activeView === 'source'
                  ? 'bg-white text-[#1D1D1F] font-semibold shadow-xs'
                  : 'text-[#6B7280] font-medium hover:text-[#1D1D1F]'
              }`}
            >
              <Code2 className="w-3 h-3" />
              <span>Nguồn</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => onDeleteMessage(message.id)}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] font-medium text-[#DC2626] hover:bg-[#FEF2F2] transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[#DC2626]"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{isDeleting ? 'Đang xoá...' : 'Xoá'}</span>
          </button>
        </div>
      </div>

      {/* Reader Content */}
      <div className="flex-1 overflow-y-auto thin-scroll p-4 sm:p-5">
        <div className="max-w-3xl mx-auto space-y-4">
          {/* Auto-detected OTP Banner */}
          {primaryOtp && (
            <div className="bg-white rounded-xl border border-[#007AFF]/30 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 shadow-[0_1px_3px_rgba(0,122,255,0.08)]">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-[#525866]">
                  Mã xác nhận (OTP) được phát hiện tự động
                </p>
                <div className="flex flex-wrap items-center gap-3 mt-1">
                  {message.otpCodes.map((code) => (
                    <span
                      key={code}
                      className="font-mono tabular-nums text-[24px] font-bold tracking-[0.14em] text-[#0066D6]"
                    >
                      {code}
                    </span>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => onCopyText(primaryOtp, `Đã chép mã OTP ${primaryOtp}`)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#007AFF] hover:bg-[#0068D9] text-white text-[13px] font-semibold shadow-[0_1px_2px_rgba(0,122,255,0.28)] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#007AFF]"
              >
                {copiedValue === primaryOtp ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Đã chép mã</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Chép mã {primaryOtp}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Email Metadata & Body Card */}
          <article className="bg-white rounded-xl border border-[#E5E8EE] overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EEF0F4]">
              <div className="flex items-start gap-3">
                <div
                  className="w-10 h-10 rounded-full bg-[#EEF4FF] text-[#0066D6] font-bold text-[15px] flex items-center justify-center shrink-0"
                  aria-hidden="true"
                >
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[15px] font-semibold text-[#1D1D1F] truncate">
                      {message.fromName}
                    </p>
                    <span className="text-[12px] text-[#7D8696] font-mono tabular-nums">
                      Ngày: {formatEmailDate(message.receivedAt)}
                    </span>
                  </div>
                  <p className="text-[12.5px] font-mono text-[#6B7280] truncate mt-0.5">
                    {message.fromAddress}
                  </p>
                </div>
              </div>

              <dl className="mt-3.5 pt-3 border-t border-[#F2F4F7] grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 gap-x-4 text-[12.5px]">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <dt className="text-[#8E95A2] shrink-0">Tiêu đề:</dt>
                  <dd className="font-semibold text-[#1D1D1F] break-words">{message.subject}</dd>
                </div>
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <dt className="text-[#8E95A2] shrink-0">Đến:</dt>
                  <dd className="font-mono text-[#374151] truncate" title={message.toAddress}>
                    {message.toAddress}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Safe Body View */}
            {activeView === 'html' && message.htmlBody ? (
              <div className="bg-white">
                <iframe
                  title={`Nội dung thư: ${message.subject}`}
                  sandbox=""
                  srcDoc={message.htmlBody}
                  className="w-full min-h-[420px] border-0 bg-white block"
                />
              </div>
            ) : activeView === 'source' ? (
              <div className="bg-[#F8FAFC]">
                <div className="px-4 py-2 border-b border-[#E5E8EE] flex items-center justify-between">
                  <span className="text-[11.5px] font-medium text-[#64748B]">
                    Nguồn thô (RFC-822 / MIME)
                  </span>
                  <button
                    type="button"
                    onClick={() => onCopyText(message.rawSource, 'Đã chép nguồn email')}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] font-medium text-[#334155] hover:bg-black/[0.05] cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Chép nguồn</span>
                  </button>
                </div>
                <pre className="p-5 text-[12px] font-mono text-[#334155] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                  {message.rawSource || message.textBody}
                </pre>
              </div>
            ) : (
              <pre className="p-5 text-[14px] text-[#272B33] whitespace-pre-wrap font-sans leading-relaxed">
                {message.textBody || '(Thư không có nội dung văn bản)'}
              </pre>
            )}
          </article>
        </div>
      </div>
    </main>
  );
}
