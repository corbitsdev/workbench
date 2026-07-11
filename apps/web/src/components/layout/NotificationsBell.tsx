import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bell, CheckCheck } from "lucide-react";
import { cn } from "@workbench/ui";
import type { MailboxMessage } from "@workbench/shared";
import {
  MAILBOX_POLL_MS,
  unreadCount,
  useMailbox,
} from "../../hooks/use-mailbox";
import { formatRelativeTime } from "../../lib/relative-time";

const RECENT_LIMIT = 8;
const BADGE_MAX = 9;

/**
 * Ambient notifications surface in the app-frame top bar. Reads the same
 * mailbox query as the /inbox page (shared cache) but on a gentle poll so
 * deliveries that land while the user is elsewhere still light the badge.
 * The dropdown lists the most recent messages, each deep-linking into the
 * durable inbox.
 */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const reduceMotion = useReducedMotion();
  const { data } = useMailbox({ refetchInterval: MAILBOX_POLL_MS });

  const messages = data ?? [];
  const unread = unreadCount(messages);
  const recent = messages.slice(0, RECENT_LIMIT);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const label =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  const badgeText = unread > BADGE_MAX ? `${BADGE_MAX}+` : String(unread);

  return (
    <div
      ref={containerRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          "relative grid h-9 w-9 place-items-center rounded-[10px] text-text-2 transition-colors hover:bg-page hover:text-text",
          open && "bg-page text-text",
        )}
      >
        <Bell size={18} />
        <AnimatePresence initial={false}>
          {unread > 0 && (
            <motion.span
              key={badgeText}
              initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={reduceMotion ? undefined : { scale: 0.4, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 24 }}
              className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-orange px-1 text-[10px] font-bold leading-none text-white"
              aria-hidden="true"
            >
              {badgeText}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-label="Notifications"
            initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="absolute right-0 top-[calc(100%+8px)] z-50 w-80 origin-top-right overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold text-text">
                Notifications
              </span>
              {unread > 0 && (
                <span className="text-[11px] font-medium text-orange">
                  {unread} new
                </span>
              )}
            </div>

            {recent.length === 0 ? (
              <BellEmptyState />
            ) : (
              <ul className="max-h-[22rem] overflow-y-auto py-1">
                {recent.map((message, index) => (
                  <motion.li
                    key={message.id}
                    initial={reduceMotion ? false : { opacity: 0, x: 6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      duration: 0.15,
                      ease: "easeOut",
                      delay: reduceMotion ? 0 : Math.min(index * 0.03, 0.21),
                    }}
                  >
                    <NotificationItem
                      message={message}
                      onSelect={() => setOpen(false)}
                    />
                  </motion.li>
                ))}
              </ul>
            )}

            <div className="border-t border-border">
              <Link
                to="/inbox"
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-center text-sm font-medium text-text-2 transition-colors hover:bg-page hover:text-text"
              >
                View all
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface NotificationItemProps {
  message: MailboxMessage;
  onSelect: () => void;
}

function NotificationItem({ message, onSelect }: NotificationItemProps) {
  return (
    <Link
      to={`/inbox/${message.id}`}
      onClick={onSelect}
      className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-page"
    >
      <span className="mt-1.5 flex h-2 w-2 shrink-0 items-center justify-center">
        {!message.read && (
          <span className="h-2 w-2 rounded-full bg-orange" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-[13px]",
              message.read ? "text-text-2" : "font-semibold text-text",
            )}
          >
            {message.from}
          </span>
          <time className="shrink-0 text-[11px] text-text-3">
            {formatRelativeTime(message.date)}
          </time>
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-text-2">
          {message.subject ?? "(no subject)"}
        </span>
      </span>
    </Link>
  );
}

function BellEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-page text-text-3">
        <CheckCheck size={17} aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-text">You're all caught up</p>
      <p className="text-xs text-text-3">
        New mail and hand-offs will show up here.
      </p>
    </div>
  );
}
