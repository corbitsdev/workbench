import { FileText, GitBranch, MessagesSquare, User } from "lucide-react";
import { Link } from "react-router";
import { deepLinkPath, type ActiveContext } from "@workbench/shared";
import { useActiveContext } from "../lib/active-context-store";

const KIND_META: Record<
  ActiveContext["kind"],
  {
    label: string;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
    href: (ctx: ActiveContext) => string;
  }
> = {
  artifact: {
    label: "Artifact",
    Icon: FileText,
    href: (ctx) => deepLinkPath("artifact", ctx.id),
  },
  "workflow-run": {
    label: "Workflow",
    Icon: GitBranch,
    href: (ctx) => deepLinkPath("workflow_run", ctx.id),
  },
  thread: {
    label: "Thread",
    Icon: MessagesSquare,
    href: (ctx) => deepLinkPath("conversation", ctx.id),
  },
  principal: {
    label: "Person",
    Icon: User,
    href: (ctx) => `/admin/principals/${encodeURIComponent(ctx.id)}`,
  },
};

export function AppContextStrip() {
  const ctx = useActiveContext();
  if (ctx === null) return null;

  const meta = KIND_META[ctx.kind];
  const title = ctx.label.trim() || "Untitled";
  const { Icon } = meta;

  return (
    <Link
      to={meta.href(ctx)}
      className="flex min-w-0 max-w-[min(420px,50vw)] items-center gap-2 rounded-[8px] px-2 py-1 text-left text-sm text-text-2 transition-colors hover:bg-page hover:text-text"
      title={title}
    >
      <Icon size={14} className="shrink-0 text-text-3" aria-hidden />
      <span className="shrink-0 text-xs text-text-3">{meta.label}</span>
      <span className="min-w-0 truncate font-medium text-text">{title}</span>
    </Link>
  );
}