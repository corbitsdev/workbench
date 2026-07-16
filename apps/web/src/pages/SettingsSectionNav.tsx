import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router";
import { cn } from "@workbench/ui";
import { getMe } from "../lib/hub-api";
import {
  SETTINGS_SECTIONS,
  resolveActiveSectionId,
  visibleManagementGroups,
} from "./settings-section-nav";

/**
 * Sticky in-page nav for the settings sections. Highlights the entry that
 * matches the current URL hash so a link into a specific section (e.g. the
 * inbox deep-linking to `#morning-brief`) reads as active on arrival.
 *
 * Below the personal sections it also lists the role-gated management
 * groups (the former standalone /admin and /owner areas, now routed under
 * /settings) — a group is omitted entirely for a viewer whose role does not
 * permit it, never shown disabled.
 */
export function SettingsSectionNav() {
  const location = useLocation();
  const activeId = resolveActiveSectionId(location.hash);
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const managementGroups = visibleManagementGroups({
    isAdmin: meQuery.data?.isAdmin === true,
    isOwner: meQuery.data?.isOwner === true,
  });

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-1">
      <div className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
        {SETTINGS_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={cn(
              "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              activeId === section.id
                ? "bg-orange/10 text-orange"
                : "text-text-2 hover:bg-page hover:text-text",
            )}
            aria-current={activeId === section.id ? "location" : undefined}
          >
            {section.label}
          </a>
        ))}
      </div>
      {managementGroups.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
          {managementGroups.map((group) => (
            <NavLink
              key={group.id}
              to={group.to}
              className={({ isActive }) =>
                cn(
                  "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-orange/10 text-orange"
                    : "text-text-2 hover:bg-page hover:text-text",
                )
              }
            >
              {group.label}
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  );
}
