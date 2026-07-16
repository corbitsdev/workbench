import { Outlet } from "react-router";
import { SettingsSectionNav } from "./SettingsSectionNav";

/**
 * Parent layout for the whole /settings area. Keeps the section rail mounted
 * across the personal sections page (the index child) AND the relocated
 * management areas (/settings/admin/*, /settings/owner/*), so the management
 * links in the rail have a reachable active state instead of unmounting the
 * nav when followed.
 */
export default function SettingsLayout() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-8">
          <div className="lg:sticky lg:top-4 lg:self-start">
            <SettingsSectionNav />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
