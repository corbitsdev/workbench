import { NavLink, Outlet } from "react-router";
import { cn } from "@workbench/ui";

const LIBRARY_TABS = [
  { to: "/library/artifacts", label: "Artifacts" },
  { to: "/library/skills", label: "Skills" },
  { to: "/library/agents", label: "Agents" },
] as const;

/**
 * Shared shell for the Library area (CL-4256): Artifacts, Skills, and Agents
 * are the same shape of surface — a collection of named things you browse,
 * search, and open — so they read as one place with three views rather than
 * three pages that happen to share a URL prefix. The tab strip lives here,
 * outside the page-chrome slots each view already owns (title/search/actions
 * via `useSetPageChrome`, detail breadcrumbs via `useSetPageChromeLeading`),
 * so switching views never fights a detail page's own chrome on unmount.
 */
export default function LibraryLayout() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <nav
        aria-label="Library sections"
        className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2 sm:px-7"
      >
        {LIBRARY_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                "rounded-[8px] px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-orange/10 text-orange"
                  : "text-text-2 hover:bg-page hover:text-text",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
