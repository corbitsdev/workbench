import { Menu } from "lucide-react";
import { AppContextStrip } from "./AppContextStrip";
import { NotificationsBell } from "./layout/NotificationsBell";
import { usePageChromeSlot } from "../lib/page-chrome";

export function AppTopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pageChrome = usePageChromeSlot();

  return (
    <header className="flex shrink-0 flex-col border-b border-border">
      <div className="flex min-h-[44px] items-center gap-2 px-3 py-2">
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
        <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
          <AppContextStrip />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 md:hidden">
            <AppContextStrip />
          </div>
          <NotificationsBell />
        </div>
      </div>
      {pageChrome ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          {pageChrome}
        </div>
      ) : null}
    </header>
  );
}
