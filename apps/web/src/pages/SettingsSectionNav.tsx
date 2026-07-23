import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation } from "react-router";
import { cn } from "@workbench/ui";
import { getMe } from "../lib/hub-api";
import {
  SETTINGS_SECTIONS,
  resolveActiveSectionId,
  visibleManagementGroups,
} from "./settings-section-nav";

const MANAGEMENT_PATH_PREFIXES = ["/settings/admin", "/settings/owner"];

const GROUP_HEADING_CLASS =
  "px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-3";

/**
 * Sticky rail for the whole /settings area, mounted by SettingsLayout so it
 * stays visible on both the personal sections page and the management
 * sub-pages. Personal entries are in-page anchors (highlighted from the URL
 * hash); management entries are route links with a real router active state.
 * A management group is omitted entirely for a viewer whose role does not
 * permit it, never shown disabled.
 */
export function SettingsSectionNav() {
  const location = useLocation();
  const onManagementPage = MANAGEMENT_PATH_PREFIXES.some((prefix) =>
    location.pathname.startsWith(prefix),
  );
  const activeAnchorId = onManagementPage
    ? null
    : resolveActiveSectionId(location.hash);
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const managementGroups = visibleManagementGroups({
    isAdmin: meQuery.data?.isAdmin === true,
    isOwner: meQuery.data?.isOwner === true,
  });

  const anchorClass = (isActive: boolean) =>
    cn(
      "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
      isActive
        ? "bg-orange/10 text-orange"
        : "text-text-2 hover:bg-page hover:text-text",
    );

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-1">
      <div className={GROUP_HEADING_CLASS}>Personal</div>
      <div className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
        {SETTINGS_SECTIONS.map((section) => {
          const isActive = activeAnchorId === section.id;
          // On the personal page a native same-page anchor keeps the browser's
          // built-in scroll behavior; from a management page the entry must
          // first navigate back to /settings, carrying the anchor in the hash.
          if (onManagementPage) {
            return (
              <Link
                key={section.id}
                to={{ pathname: "/settings", hash: `#${section.id}` }}
                className={anchorClass(false)}
              >
                {section.label}
              </Link>
            );
          }
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={anchorClass(isActive)}
              aria-current={isActive ? "location" : undefined}
            >
              {section.label}
            </a>
          );
        })}
      </div>
      {managementGroups.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border pt-1">
          <div className={GROUP_HEADING_CLASS}>Management</div>
          {managementGroups.map((group) => (
            <NavLink
              key={group.id}
              to={group.to}
              className={({ isActive }) => anchorClass(isActive)}
            >
              {group.label}
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  );
}
