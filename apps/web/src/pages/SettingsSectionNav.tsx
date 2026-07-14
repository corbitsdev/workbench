import { useLocation } from "react-router";
import { cn } from "@workbench/ui";
import {
  SETTINGS_SECTIONS,
  resolveActiveSectionId,
} from "./settings-section-nav";

/**
 * Sticky in-page nav for the settings sections. Highlights the entry that
 * matches the current URL hash so a link into a specific section (e.g. the
 * inbox deep-linking to `#morning-brief`) reads as active on arrival.
 */
export function SettingsSectionNav() {
  const location = useLocation();
  const activeId = resolveActiveSectionId(location.hash);

  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0"
    >
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
    </nav>
  );
}
