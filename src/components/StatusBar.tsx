interface StatusBarProps {
  mailboxCount: number;
  autoRefresh: boolean;
  domainCount: number;
  lastSyncedLabel: string | null;
}

export function StatusBar({
  mailboxCount,
  autoRefresh,
  domainCount,
  lastSyncedLabel,
}: StatusBarProps) {
  return (
    <footer className="h-[28px] shrink-0 bg-[#F6F7F9] border-t border-[#E3E6EC] px-4 flex items-center justify-center text-[11.5px] text-[#6E7684] tabular-nums select-none">
      <div className="flex items-center gap-2 truncate">
        <span>{mailboxCount} hộp thư</span>
        <span aria-hidden="true">·</span>
        <span>{autoRefresh ? 'Tự động: BẬT' : 'Tự động: TẮT'}</span>
        <span aria-hidden="true">·</span>
        <span>
          {domainCount > 0 ? `${domainCount} tên miền sẵn sàng` : 'Đang kết nối máy chủ thư'}
        </span>
        {lastSyncedLabel && (
          <>
            <span aria-hidden="true" className="hidden sm:inline">
              ·
            </span>
            <span className="hidden sm:inline">Cập nhật {lastSyncedLabel}</span>
          </>
        )}
      </div>
    </footer>
  );
}
