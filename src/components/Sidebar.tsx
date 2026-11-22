import { useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Shuffle, Trash2 } from 'lucide-react';
import type { CreationMode, DomainInfo, GeneratedEmailPreview, Mailbox } from '../types/mail';
import { generateFakerUsername } from '../utils/tempMailLogic';

interface SidebarProps {
  domains: DomainInfo[];
  isLoadingDomains: boolean;
  mailboxes: Mailbox[];
  selectedMailboxId: string | null;
  isCreating: boolean;
  isGenerating: boolean;
  formError: string | null;
  copiedValue: string | null;
  onRefreshDomains: () => void;
  onGeneratePreview: (mode: CreationMode) => Promise<GeneratedEmailPreview | null>;
  onCreateMailbox: (options: {
    mode: CreationMode;
    email?: string;
    username?: string;
    domain?: string;
    pregeneratedToken?: string;
  }) => Promise<boolean>;
  onSelectMailbox: (mailboxId: string) => void;
  onDeleteMailbox: (mailboxId: string) => void;
  onCopyText: (value: string, label?: string) => void;
  onClearError: () => void;
}

export function Sidebar({
  domains,
  isLoadingDomains,
  mailboxes,
  selectedMailboxId,
  isCreating,
  isGenerating,
  formError,
  copiedValue,
  onRefreshDomains,
  onGeneratePreview,
  onCreateMailbox,
  onSelectMailbox,
  onDeleteMailbox,
  onCopyText,
  onClearError,
}: SidebarProps) {
  const [mode, setMode] = useState<CreationMode>('email');
  const [emailInput, setEmailInput] = useState('');
  const [pregeneratedToken, setPregeneratedToken] = useState<string | undefined>(undefined);
  const [usernameInput, setUsernameInput] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<string>('random');

  const handleSwitchMode = (nextMode: CreationMode) => {
    setMode(nextMode);
    onClearError();
  };

  const handleGenerateEmail = async () => {
    onClearError();
    if (mode === 'email') {
      const preview = await onGeneratePreview('email');
      if (preview) {
        setEmailInput(preview.address);
        setPregeneratedToken(preview.pregeneratedToken);
      }
    } else {
      setUsernameInput(generateFakerUsername());
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    onClearError();

    if (mode === 'email') {
      const ok = await onCreateMailbox({
        mode: 'email',
        email: emailInput.trim() || undefined,
        pregeneratedToken,
      });
      if (ok) {
        setEmailInput('');
        setPregeneratedToken(undefined);
      }
    } else {
      const ok = await onCreateMailbox({
        mode: 'domain',
        username: usernameInput.trim() || undefined,
        domain: selectedDomain,
      });
      if (ok) {
        setUsernameInput('');
      }
    }
  };

  return (
    <aside
      aria-label="Quản lý hộp thư tạm thời"
      className="w-full md:w-[286px] shrink-0 bg-[#F0F4FA] md:border-r border-[#E2E6EE] flex flex-col min-h-0"
    >
      <div className="p-3.5 shrink-0">
        <div className="flex items-center justify-between mb-2.5 px-0.5">
          <h2 className="text-[11px] font-semibold tracking-[0.04em] text-[#8B94A3]">
            TẠO ĐỊA CHỈ MỚI
          </h2>
          <button
            type="button"
            onClick={onRefreshDomains}
            disabled={isLoadingDomains}
            aria-label="Làm mới danh sách tên miền"
            title="Làm mới danh sách tên miền"
            className="p-1 rounded-md text-[#007AFF] hover:bg-[#007AFF]/10 transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[#007AFF]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDomains ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl p-3 border border-[#E2E7F0] shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          {/* Segmented Control: Domain | Email */}
          <div
            role="tablist"
            aria-label="Chế độ tạo địa chỉ"
            className="grid grid-cols-2 p-[3px] bg-[#F1F3F6] rounded-lg border border-[#E6E9EF]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'domain'}
              onClick={() => handleSwitchMode('domain')}
              className={`py-1.5 text-[12.5px] rounded-[6px] transition-all whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF] ${
                mode === 'domain'
                  ? 'bg-white text-[#1D1D1F] font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-[#6B7280] font-medium hover:text-[#1D1D1F]'
              }`}
            >
              Domain
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'email'}
              onClick={() => handleSwitchMode('email')}
              className={`py-1.5 text-[12.5px] rounded-[6px] transition-all whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF] ${
                mode === 'email'
                  ? 'bg-white text-[#1D1D1F] font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-[#6B7280] font-medium hover:text-[#1D1D1F]'
              }`}
            >
              Email
            </button>
          </div>

          {mode === 'email' ? (
            <div className="mt-2.5 space-y-2">
              <div>
                <label htmlFor="email-preview-input" className="sr-only">
                  Địa chỉ email tạo mới hoặc dán sẵn
                </label>
                <input
                  id="email-preview-input"
                  type="text"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    setPregeneratedToken(undefined);
                    if (formError) onClearError();
                  }}
                  placeholder="—"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-[#D4DAE3] bg-white px-3 py-2.5 text-[13px] font-mono text-[#1D1D1F] placeholder:text-[#9CA3AF] focus:outline-none focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/15 transition-colors"
                />
              </div>

              <button
                type="button"
                onClick={handleGenerateEmail}
                disabled={isGenerating || isCreating}
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-[#D4DAE3] bg-white hover:bg-[#F7F9FC] active:scale-[0.99] text-[13px] font-semibold text-[#1D1D1F] transition-all whitespace-nowrap cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[#007AFF]"
              >
                <Shuffle className={`w-3.5 h-3.5 text-[#374151] ${isGenerating ? 'animate-spin' : ''}`} />
                <span>{isGenerating ? 'Đang tạo gợi ý...' : 'Generate email'}</span>
              </button>

              <button
                type="submit"
                disabled={isCreating}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#007AFF] hover:bg-[#0068D9] active:scale-[0.99] text-white text-[13px] font-semibold shadow-[0_1px_2px_rgba(0,122,255,0.28)] transition-all whitespace-nowrap cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#007AFF]"
              >
                <Plus className="w-4 h-4 stroke-[2.2]" />
                <span>{isCreating ? 'Đang tạo...' : 'Tạo email'}</span>
              </button>
            </div>
          ) : (
            <div className="mt-2.5 space-y-2">
              <div className="relative">
                <label htmlFor="custom-username-input" className="sr-only">
                  Username hoặc địa chỉ email
                </label>
                <input
                  id="custom-username-input"
                  type="text"
                  value={usernameInput}
                  onChange={(e) => {
                    setUsernameInput(e.target.value);
                    if (formError) onClearError();
                  }}
                  placeholder="username hoặc dán email..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-[#D4DAE3] bg-white pl-3 pr-9 py-2 text-[13px] font-mono text-[#1D1D1F] placeholder:text-[#9CA3AF] placeholder:font-sans focus:outline-none focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/15 transition-colors"
                />
                <button
                  type="button"
                  onClick={handleGenerateEmail}
                  aria-label="Tạo username ngẫu nhiên"
                  title="Tạo username ngẫu nhiên"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-[#6B7280] hover:text-[#1D1D1F] hover:bg-black/[0.04] transition-colors cursor-pointer"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                </button>
              </div>

              <div>
                <label htmlFor="domain-select" className="sr-only">
                  Chọn tên miền
                </label>
                <select
                  id="domain-select"
                  value={selectedDomain}
                  onChange={(e) => setSelectedDomain(e.target.value)}
                  className="w-full rounded-lg border border-[#D4DAE3] bg-white px-3 py-2 text-[13px] font-mono text-[#1D1D1F] focus:outline-none focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/15 transition-colors cursor-pointer"
                >
                  <option value="random">@ Ngẫu nhiên ({domains.length} tên miền)</option>
                  {domains.map((item) => (
                    <option key={item.domain} value={item.domain}>
                      @{item.domain}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={isCreating}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-[#007AFF] hover:bg-[#0068D9] active:scale-[0.99] text-white text-[13px] font-semibold shadow-[0_1px_2px_rgba(0,122,255,0.28)] transition-all whitespace-nowrap cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#007AFF]"
              >
                <Plus className="w-4 h-4 stroke-[2.2]" />
                <span>{isCreating ? 'Đang tạo...' : 'Tạo & Chép'}</span>
              </button>
            </div>
          )}

          {formError && (
            <p role="alert" className="mt-2 text-[12px] text-[#DC2626] leading-snug">
              {formError}
            </p>
          )}
        </form>
      </div>

      {/* Mailbox list */}
      <div className="flex-1 min-h-0 flex flex-col px-3.5 pb-3 pt-1">
        <div className="flex items-center justify-between mb-2 px-0.5 shrink-0">
          <h2 className="text-[11px] font-semibold tracking-[0.04em] text-[#8B94A3] tabular-nums">
            HỘP THƯ ( {mailboxes.length} )
          </h2>
        </div>

        {mailboxes.length === 0 ? (
          <div className="px-0.5 pt-1 text-[12.5px] text-[#8E96A4] leading-relaxed">
            <p>Chưa có hộp thư nào.</p>
            <p className="mt-1">
              Bấm <strong className="font-semibold text-[#5E6673]">Tạo email</strong> để tạo địa
              chỉ đầu tiên, hoặc chuyển sang tab{' '}
              <strong className="font-semibold text-[#5E6673]">Domain</strong> để dán địa chỉ vào ô
              username.
            </p>
          </div>
        ) : (
          <ul
            aria-label="Danh sách hộp thư tạm"
            className="flex-1 overflow-y-auto thin-scroll space-y-1.5 pr-0.5"
          >
            {mailboxes.map((mb) => {
              const isSelected = mb.id === selectedMailboxId;
              const isCopied = copiedValue === mb.address;
              return (
                <li
                  key={mb.id}
                  className={`group flex items-center gap-1 rounded-lg border transition-all ${
                    isSelected
                      ? 'bg-white border-[#007AFF]/35 shadow-[0_1px_2px_rgba(0,122,255,0.08)]'
                      : 'bg-transparent border-transparent hover:bg-white/70 hover:border-[#E2E7F0]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectMailbox(mb.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className="flex-1 min-w-0 text-left px-2.5 py-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF] rounded-l-lg"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`font-mono text-[12.5px] truncate ${
                          isSelected ? 'font-semibold text-[#005FCC]' : 'font-medium text-[#1D1D1F]'
                        }`}
                      >
                        {mb.address}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-[#7D8696] tabular-nums">
                      <span>{mb.messageCount} thư</span>
                      {mb.unreadCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-[#007AFF]">
                            {mb.unreadCount} mới
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{mb.isLive ? 'Trực tuyến' : 'Cục bộ'}</span>
                    </div>
                  </button>

                  <div className="flex items-center gap-0.5 pr-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onCopyText(mb.address, 'Đã chép địa chỉ email')}
                      aria-label={`Sao chép ${mb.address}`}
                      title="Sao chép địa chỉ"
                      className="p-1.5 rounded-md text-[#6B7280] hover:text-[#007AFF] hover:bg-[#007AFF]/10 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF]"
                    >
                      {isCopied ? (
                        <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteMailbox(mb.id)}
                      aria-label={`Xóa hộp thư ${mb.address}`}
                      title="Xóa hộp thư"
                      className="p-1.5 rounded-md text-[#8B94A3] hover:text-[#DC2626] hover:bg-[#FEE2E2]/70 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#DC2626]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
