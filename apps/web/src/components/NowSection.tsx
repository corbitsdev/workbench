import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { cn } from "@workbench/ui";
import {
  deepLinkPath,
  mailboxSenderLabel,
  resolveTaskLinkHref,
  type NowItem,
  type NowMailItem,
  type NowTaskItem,
  type TaskLink,
} from "@workbench/shared";
import { formatRelativeTime } from "../lib/relative-time";
import { createLogger } from "../lib/logger";
import { TaskAssigneePicker } from "./TaskAssigneePicker";
import { TaskSendToAdapter } from "./TaskSendToAdapter";
import {
  isFeatureEnabled,
  useMeFeatures,
} from "../hooks/use-me-features";

const nowSectionLog = createLogger("NowSection");

interface NowSectionProps {
  items: NowItem[];
  ready: boolean;
  reduceMotion: boolean;
  selectedTaskId?: string | null;
  tenantId?: string | null;
  myPrincipalId?: string | null;
}

// The inbox-as-dashboard "Now" feed: one prioritized list of everything that
// needs the user right now — approvals first, then unread mail, then open
// tasks — each row deep-linking to where it gets handled.
export function NowSection({
  items,
  ready,
  reduceMotion,
  selectedTaskId = null,
  tenantId = null,
  myPrincipalId = null,
}: NowSectionProps) {
  const features = useMeFeatures();
  const schedulerEnabled = isFeatureEnabled(features.data, "scheduler");

  if (!ready) {
    return (
      <div className="mx-auto max-w-[720px] px-6 py-5" role="status">
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
            <p className="mt-1 max-w-[420px] text-xs text-text-3">
              {schedulerEnabled
                ? "Your morning brief, workflow approvals, task updates, and mail from your agents will land here as they arrive."
                : "Workflow approvals, task updates, and mail from your agents will land here as they arrive."}
            </p>
            {schedulerEnabled && (
              <Link
                to="/settings#morning-brief"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-orange hover:underline"
              >
                Set up your morning brief
                <ArrowRight size={12} aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] px-6 py-5">
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
              <NowRow
                item={item}
                selectedTaskId={selectedTaskId}
                tenantId={tenantId}
                myPrincipalId={myPrincipalId}
              />
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

function NowRow({
  item,
  selectedTaskId,
  tenantId,
  myPrincipalId,
}: {
  item: NowItem;
  selectedTaskId: string | null;
  tenantId: string | null;
  myPrincipalId: string | null;
}) {
  if (item.type === "gate") {
    return (
      <RowShell
        href={deepLinkPath("workflow_run", item.run.runId)}
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
  return (
    <TaskRow
      item={item}
      selected={item.task.id === selectedTaskId}
      tenantId={tenantId}
      myPrincipalId={myPrincipalId}
    />
  );
}

function MailRow({ item }: { item: NowMailItem }) {
  const collapsedNote = collapsedLabel(item);
  return (
    <RowShell
      href={`/inbox/${item.message.id}`}
      accent="bg-border-strong"
      title={item.message.subject ?? "(no subject)"}
      note={collapsedNote ?? item.message.snippet}
      source={mailboxSenderLabel(item.message)}
      at={item.message.date}
    />
  );
}

function collapsedLabel(item: NowMailItem): string | undefined {
  if (item.collapsed.length === 0) return undefined;
  if (item.collapsed.length === 1) return "1 earlier item handled by Myra";
  return `${item.collapsed.length} earlier items handled by Myra`;
}

function TaskRow({
  item,
  selected,
  tenantId,
  myPrincipalId,
}: {
  item: NowTaskItem;
  selected: boolean;
  tenantId: string | null;
  myPrincipalId: string | null;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: "center" });
    }
  }, [selected]);

  const resolvedLinks = item.task.links
    .map((link) => {
      const href = resolveTaskLinkHref(link);
      if (href === null) {
        nowSectionLog.warn("dropped stored task link at render", {
          kind: link.kind,
        });
      }
      return { link, href };
    })
    .filter(
      (entry): entry is { link: TaskLink; href: string } => entry.href !== null,
    );
  const [primary, ...extraLinks] = resolvedLinks;
  const href = primary?.href ?? null;
  return (
    <div
      ref={rowRef}
      id={`task-${item.task.id}`}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "rounded-[10px] transition-colors duration-300",
        selected &&
          "bg-row-hover ring-1 ring-inset ring-border-strong hover:ring-2",
      )}
    >
      <RowShell
        href={href}
        accent="bg-border-strong"
        title={item.task.title}
        note={item.task.body}
        source="Task"
        at={item.task.updatedAt}
      />
      <div className="flex flex-wrap items-center gap-1.5 pl-5">
        <TaskAssigneePicker
          task={item.task}
          tenantId={tenantId}
          myPrincipalId={myPrincipalId}
        />
        <TaskSendToAdapter task={item.task} />
        {extraLinks.map(({ link }, index) => (
          <TaskExtraLink
            key={`${link.kind}-${link.ref}-${index}`}
            link={link}
          />
        ))}
      </div>
    </div>
  );
}

// Task rows with a link deep-link to that surface. A task with no resolvable
// link has nowhere to go — its row renders as a non-interactive shell (see
// RowShell) rather than a dead-end link to its own URL; the bell's `?task=`
// deep-link still highlights it via the row's `id`, not a href. Every
// `TaskLink` kind resolves to an href so an open task with at least one
// resolvable link is never a dead end; extra links beyond the first are
// surfaced as `TaskExtraLink` chips rather than silently dropped.
//
function isExternalHref(href: string): boolean {
  return /^https?:\/\//.test(href);
}

function TaskExtraLink({ link }: { link: TaskLink }) {
  const href = resolveTaskLinkHref(link);
  if (href === null) return null;
  const label = link.label ?? taskLinkFallbackLabel(link.kind);
  const className =
    "text-xs text-text-3 underline decoration-dotted hover:text-text";

  if (isExternalHref(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {label}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {label}
    </Link>
  );
}

function taskLinkFallbackLabel(kind: TaskLink["kind"]): string {
  if (kind === "workflow_run") return "Workflow";
  if (kind === "mail") return "Mail";
  if (kind === "artifact") return "Artifact";
  if (kind === "conversation") return "Conversation";
  return "Link";
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
    "flex w-full items-start gap-3 border-b border-border/40 px-2 py-2 text-left transition-colors duration-150 last:border-b-0";

  if (href === null) {
    return <div className={rowClass}>{body}</div>;
  }
  if (isExternalHref(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(rowClass, "hover:bg-row-hover")}
      >
        {body}
      </a>
    );
  }
  return (
    <Link to={href} className={cn(rowClass, "hover:bg-row-hover")}>
      {body}
    </Link>
  );
}