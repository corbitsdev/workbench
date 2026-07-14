import { Menu } from "lucide-react";
import { AppContextStrip } from "./AppContextStrip";
import { NotificationsBell } from "./layout/NotificationsBell";
import {
  usePageChromeLeadingSlot,
  usePageChromeSlot,
} from "../lib/page-chrome";

function TopBarLeading() {
  const leading = usePageChromeLeadingSlot();
  if (leading) return <>{leading}</>;
  return <AppContextStrip />;
}

export function AppTopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pageChrome = usePageChromeSlot();

  return (
    <header className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-text-2 transition-colors hover:bg-page hover:text-text md:hidden"
      >
        <Menu size={20} />
      </button>
      <span className="shrink-0 text-sm font-semibold text-text md:hidden">
        Workbench
      </span>
      <div className="hidden min-w-0 shrink-0 items-center gap-3 md:flex">
        <TopBarLeading />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 md:hidden">
        <TopBarLeading />
      </div>
      {pageChrome ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
          {pageChrome}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <NotificationsBell />
    </header>
  );
}
