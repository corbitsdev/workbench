import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@workbench/ui";
import type {
  NowItem,
  NowMailItem,
  NowTaskItem,
  Task,
} from "@workbench/shared";
import { formatRelativeTime } from "../lib/relative-time";

interface NowSectionProps {
  items: NowItem[];
  ready: boolean;
  reduceMotion: boolean;
}

// The inbox-as-dashboard "Now" feed: one prioritized list of everything that
// needs the user right now — approvals first, then unread mail, then open
// tasks — each row deep-linking to where it gets handled.
export function NowSection({ items, ready, reduceMotion }: NowSectionProps) {
  if (!ready) {
    return (
      <div className="mx-auto max-w-[720px] px-8 py-8" role="status">
        <p className="text-xs text-text-3">Loading your day…</p>
        <div className="mt-5 flex flex-col gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-[10px] bg-surface"
            />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-surface text-green">
            <CheckCircle2 size={22} aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium text-text">
              You're all caught up
            </p>
            <p className="mt-1 text-xs text-text-3">
              Approvals, new mail, and open tasks will show up here as they
              arrive.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] px-8 py-8">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">
        Now
      </h2>
      <p className="mt-1 text-xs text-text-3">
        What's waiting on you, most urgent first.
      </p>
      <ul aria-label="Now" className="mt-5 flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {items.map((item, index) => (
            <motion.li
              key={nowItemKey(item)}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: 12 }}
              transition={{
                duration: 0.18,
                ease: "easeOut",
                delay: reduceMotion ? 0 : Math.min(index * 0.03, 0.24),
              }}
            >
              <NowRow item={item} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

function nowItemKey(item: NowItem): string {
  if (item.type === "gate") return `gate:${item.run.runId}`;
  if (item.type === "mail") return `mail:${item.message.id}`;
  return `task:${item.task.id}`;
}

function NowRow({ item }: { item: NowItem }) {
  if (item.type === "gate") {
    return (
      <RowShell
        href={`/workflows/${item.run.runId}`}
        accent="bg-orange"
        title={item.run.kind}
        note="Waiting for your response"
        source="Workflow"
        at={item.run.createdAt}
      />
    );
  }
  if (item.type === "mail") {
    return <MailRow item={item} />;
  }
  return <TaskRow item={item} />;
}

function MailRow({ item }: { item: NowMailItem }) {
  const collapsedNote = collapsedLabel(item);
  return (
    <RowShell
      href={`/inbox/${item.message.id}`}
      accent="bg-border-strong"
      title={item.message.subject ?? "(no subject)"}
      note={collapsedNote ?? item.message.snippet}
      source={item.message.from}
      at={item.message.date}
    />
  );
}

function collapsedLabel(item: NowMailItem): string | undefined {
  if (item.collapsed.length === 0) return undefined;
  if (item.collapsed.length === 1) return "1 earlier item handled by Myra";
  return `${item.collapsed.length} earlier items handled by Myra`;
}

function TaskRow({ item }: { item: NowTaskItem }) {
  const href = taskHref(item.task);
  return (
    <RowShell
      href={href}
      accent="bg-border-strong"
      title={item.task.title}
      note={item.task.body}
      source="Task"
      at={item.task.updatedAt}
    />
  );
}

// Minimal deep-link affordance until a task detail surface exists: follow the
// task's first internal link; a linkless task renders as a static row.
function taskHref(task: Task): string | null {
  const link = task.links[0];
  if (!link) return null;
  if (link.kind === "workflow_run") return `/workflows/${link.ref}`;
  if (link.kind === "mail") return `/inbox/${link.ref}`;
  if (link.kind === "artifact") return `/artifacts/${link.ref}`;
  return null;
}

interface RowShellProps {
  href: string | null;
  accent: string;
  title: string;
  note?: string | undefined;
  source: string;
  at: string;
}

function RowShell({ href, accent, title, note, source, at }: RowShellProps) {
  const body = (
    <>
      <span
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", accent)}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">
          {title}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-text-3">
          <span className="truncate">{source}</span>
          <span aria-hidden="true">·</span>
          <time className="shrink-0">{formatRelativeTime(at)}</time>
        </span>
        {note && (
          <span className="mt-0.5 block truncate text-xs text-text-3">
            {note}
          </span>
        )}
      </span>
    </>
  );

  const rowClass =
    "flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-150";

  if (href === null) {
    return <div className={rowClass}>{body}</div>;
  }
  return (
    <Link to={href} className={cn(rowClass, "hover:bg-row-hover")}>
      {body}
    </Link>
  );
}
