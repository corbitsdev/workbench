import {
  Home,
  Settings,
  BookOpen,
  BarChart2,
  Workflow,
  Plus,
  Files,
  Search,
  FileText,
  FlaskConical,
  ChevronDown,
  ShieldCheck,
  KeyRound,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { NavLink, Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@workbench/ui";
import { useAuth } from "../AuthProvider";
import { getMe } from "../../lib/hub-api";
import {
  useCreateMyraThread,
  writeLastActiveThreadId,
} from "../../hooks/use-myra-threads";
import { ThreadList } from "./ThreadList";
import { WorkbenchSelector } from "./WorkbenchSelector";
import { branding } from "../../lib/app-env";

const NAV_ITEMS = [
  { to: "/chats", label: "Chats", icon: Home, end: false },
  { to: "/artifacts", label: "Artifacts", icon: Files, end: false },
  { to: "/workflows", label: "Workflows", icon: Workflow, end: false },
  { to: "/skills", label: "Skills", icon: BookOpen, end: false },
  { to: "/insights", label: "Insights", icon: BarChart2, end: false },
] as const;

// Footer icon only, shown to admins (Tools moved under Admin — CL-2719). The
// hub re-checks the admin grant on every admin route, so this is visibility only.
const ADMIN_NAV_ITEM = {
  to: "/admin",
  label: "Admin",
  icon: ShieldCheck,
  end: false,
} as const;

// Shown only to owners (ABK Labs staff — the `owner` role's `*`/`*`). The hub
// re-checks the owner grant on every /owner route; this is nav visibility only.
// Owner ⊃ admin, so an owner sees both this and the Admin item.
const OWNER_NAV_ITEM = {
  to: "/owner",
  label: "Owner",
  icon: KeyRound,
  end: false,
} as const;

// The demo links themselves come from /me (server-gated, hidden by default).
// The payload carries a stable string `icon` key; map it to a lucide component
// here, falling back to a generic icon for an unknown key.
const DEMO_ICONS: Record<string, LucideIcon> = {
  search: Search,
  "file-text": FileText,
  flask: FlaskConical,
};

function demoIcon(key: string): LucideIcon {
  return DEMO_ICONS[key] ?? ExternalLink;
}

interface AppSidebarProps {
  /** Whether the mobile drawer is open. Ignored at desktop widths, where the
   * sidebar is always a static column. */
  mobileOpen?: boolean;
  /** Called when a navigation action is taken, so the host can close the
   * mobile drawer. No-op on desktop. */
  onNavigate?: () => void;
}

export function AppSidebar({
  mobileOpen = false,
  onNavigate,
}: AppSidebarProps) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const createThread = useCreateMyraThread();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const isAdmin = meQuery.data?.isAdmin === true;
  const name = session.status === "authenticated" ? session.user.name : "";
  const initials =
    name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "··";

  const navItemClass = (isActive: boolean) =>
    `flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-sm transition-colors duration-150 ${
      isActive
        ? "bg-orange/10 font-medium text-orange"
        : "text-text-2 hover:bg-page hover:text-text"
    }`;

  const newChat = () => {
    createThread.mutate(undefined, {
      onSuccess: (thread) => {
        writeLastActiveThreadId(thread.id);
        navigate(`/chats/${thread.id}`);
        onNavigate?.();
      },
    });
  };

  return (
    <aside
      className={cn(
        "flex h-full w-[240px] shrink-0 flex-col border-r border-border bg-surface",
        // Mobile: take the rail out of flow and slide it in as a drawer. The
        // desktop layout (a static flex column) is untouched above the md
        // breakpoint, so the open/closed state only matters on small screens.
        "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-xl max-md:transition-transform max-md:duration-200 max-md:ease-out",
        mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-4">
        <Link
          to="/"
          onClick={onNavigate}
          className="group grid h-[34px] w-[34px] place-items-center"
          aria-label="Home"
        >
          {/* ring (not shadow) on purpose: the favicon is a black mark on a
              near-black sidebar surface in dark themes, where a drop shadow adds
              no separation — the border ring is what keeps the mark legible. */}
          <img
            src="/corbits-favicon-mono.svg"
            alt="Corbits"
            width={30}
            height={30}
            className="h-[30px] w-[30px] rounded-[10px] ring-1 ring-border will-change-transform transition-transform duration-200 ease-spring motion-safe:hover-hover:group-hover:rotate-[-8deg] motion-safe:hover-hover:group-hover:scale-[1.08]"
          />
        </Link>
        <span className="text-sm font-semibold text-text">Workbench</span>
        {branding.label && (
          <span className="rounded-full bg-orange/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-orange">
            {branding.label}
          </span>
        )}
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={newChat}
          disabled={createThread.isPending}
          className="flex w-full items-center gap-2 rounded-[10px] border border-border px-2.5 py-2 text-sm font-medium text-text transition-colors hover:bg-page disabled:opacity-50"
        >
          <Plus size={16} className="text-orange" />
          {createThread.isPending ? "Creating…" : "New Chat"}
        </button>
      </div>

      <nav
        className="mt-3 flex flex-col gap-0.5 px-3"
        aria-label="Main navigation"
      >
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) => navItemClass(isActive)}
          >
            <Icon size={17} />
            {label}
          </NavLink>
        ))}
        {meQuery.data?.isOwner && (
          <NavLink
            to={OWNER_NAV_ITEM.to}
            end={OWNER_NAV_ITEM.end}
            onClick={onNavigate}
            className={({ isActive }) => navItemClass(isActive)}
          >
            <OWNER_NAV_ITEM.icon size={17} />
            {OWNER_NAV_ITEM.label}
          </NavLink>
        )}
      </nav>

      {(meQuery.data?.demoLinks?.length ?? 0) > 0 && (
        <details open className="group/demos mt-3 px-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-3 hover:text-text-2 [&::-webkit-details-marker]:hidden">
            <ChevronDown
              size={12}
              className="shrink-0 -rotate-90 transition-transform duration-150 group-open/demos:rotate-0"
            />
            Demos
          </summary>
          <div className="flex flex-col gap-0.5">
            {meQuery.data?.demoLinks?.map(({ label, href, icon }) => {
              const Icon = demoIcon(icon);
              return (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onNavigate}
                  className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-sm text-text-2 transition-colors duration-150 hover:bg-page hover:text-text"
                >
                  <Icon size={17} className="shrink-0" />
                  <span className="flex-1 truncate">{label}</span>
                </a>
              );
            })}
          </div>
        </details>
      )}

      <div className="mt-4 min-h-0 flex-1 overflow-auto px-3">
        <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-3">
          Chats
        </div>
        <ThreadList />
      </div>

      <div className="border-t border-border px-3 py-2">
        <WorkbenchSelector />
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className="grid h-[30px] w-[30px] place-items-center rounded-full bg-blue text-[10px] font-bold text-white"
            title={name}
          >
            {initials}
          </div>
          <span className="max-w-[110px] truncate text-xs text-text-2">
            {name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isAdmin ? (
            <Link
              to={ADMIN_NAV_ITEM.to}
              title={ADMIN_NAV_ITEM.label}
              aria-label={ADMIN_NAV_ITEM.label}
              onClick={onNavigate}
              className="grid h-[34px] w-[34px] place-items-center rounded-[10px] text-text-2 transition-colors hover:text-text"
            >
              <ADMIN_NAV_ITEM.icon size={17} />
            </Link>
          ) : null}
          <Link
            to="/settings"
            title="Settings"
            aria-label="Settings"
            onClick={onNavigate}
            className="grid h-[34px] w-[34px] place-items-center rounded-[10px] text-text-2 transition-colors hover:text-text"
          >
            <Settings size={17} />
          </Link>
        </div>
      </div>
    </aside>
  );
}
