import { NavLink, Outlet, useLocation } from "react-router";
import { cn } from "@workbench/ui";

const LIBRARY_TABS = [
  { to: "/library/artifacts", label: "Artifacts" },
  { to: "/library/skills", label: "Skills" },
  { to: "/library/agents", label: "Agents" },
] as const;

const LIBRARY_LIST_PATHS = new Set(LIBRARY_TABS.map((tab) => tab.to));

/**
 * Shared shell for the Library area (CL-4256): Artifacts, Skills, and Agents
 * are the same shape of surface — a collection of named things you browse,
 * search, and open — so they read as one place with three views rather than
 * three pages that happen to share a URL prefix. The tab strip lives here,
 * outside the page-chrome slots each view already owns (title/search/actions
 * via `useSetPageChrome`, detail breadcrumbs via `useSetPageChromeLeading`),
 * so switching views never fights a detail page's own chrome on unmount.
 *
 * The tab strip only makes sense while browsing a collection — inside a
 * single item (an artifact, a skill, the new-skill form) the three-way
 * choice is noise, and each detail route already publishes its own back
 * affordance via page chrome. So this row renders only on the three exact
 * collection routes; on any deeper path it renders nothing, leaving the
 * detail page's own back link as the single way back.
 */
export default function LibraryLayout() {
  const location = useLocation();
  const isCollectionRoute = LIBRARY_LIST_PATHS.has(location.pathname);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {isCollectionRoute && (
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
      )}
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
