import { Clock, RefreshCw } from 'lucide-react';

interface TitleBarProps {
  isRefreshing: boolean;
  autoRefresh: boolean;
  onRefresh: () => void;
  onToggleAutoRefresh: () => void;
}

export function TitleBar({
  isRefreshing,
  autoRefresh,
  onRefresh,
  onToggleAutoRefresh,
}: TitleBarProps) {
  return (
    <header className="h-[46px] shrink-0 bg-[#F7F8FA]/95 border-b border-[#E3E6EC] px-4 flex items-center justify-between gap-4 select-none">
      <div className="flex items-center gap-3 min-w-0">
        <div className="hidden sm:flex items-center gap-2 shrink-0" aria-hidden="true">
          <span className="w-3 h-3 rounded-full bg-[#FF5F56] ring-1 ring-black/10" />
          <span className="w-3 h-3 rounded-full bg-[#FFBD2E] ring-1 ring-black/10" />
          <span className="w-3 h-3 rounded-full bg-[#27C93F] ring-1 ring-black/10" />
        </div>
        <h1 className="text-[14px] tracking-[-0.01em] truncate whitespace-nowrap">
          <span className="font-semibold text-[#1D1D1F]">TempMail</span>
          <span className="text-[#78808D] font-normal"> — Email nhận mã OTP</span>
        </h1>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium text-[#374151] hover:bg-black/[0.04] active:bg-black/[0.07] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[#007AFF]"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-[#525866] ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>Làm mới</span>
        </button>

        <button
          type="button"
          onClick={onToggleAutoRefresh}
          aria-pressed={autoRefresh}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#007AFF] ${
            autoRefresh
              ? 'text-[#007AFF] hover:bg-[#007AFF]/[0.08]'
              : 'text-[#6B7280] hover:bg-black/[0.04]'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>{autoRefresh ? 'Tự động: BẬT' : 'Tự động: TẮT'}</span>
        </button>
      </div>
    </header>
  );
}
