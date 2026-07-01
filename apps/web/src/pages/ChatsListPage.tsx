import { useState } from "react";
import { useNavigate } from "react-router";
import {
  Button,
  LibraryPageHeader,
  LibrarySearchInput,
  PagePanel,
  cn,
} from "@workbench/ui";
import { Plus } from "lucide-react";
import { formatRelativeTime } from "../lib/relative-time";
import {
  readLastActiveThreadId,
  useCreateMyraThread,
  useMyraThreads,
  useRelaunchMyraThread,
  writeLastActiveThreadId,
} from "../hooks/use-myra-threads";
import type { MyraThreadListItem } from "../lib/hub-api";

const DAY_MS = 86_400_000;

type Bucket = "today" | "week" | "month" | "older";

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function bucketFor(iso: string, now: number): Bucket {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "older";
  if (isSameLocalDay(t, now)) return "today";
  const diffDays = (now - t) / DAY_MS;
  if (diffDays < 7) return "week";
  if (diffDays < 31) return "month";
  return "older";
}

type ThreadGroup = {
  key: Bucket;
  label: string;
  threads: MyraThreadListItem[];
};

const GROUP_ORDER: { key: Bucket; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "older", label: "Older" },
];

function buildGroups(
  threads: MyraThreadListItem[],
  now: number,
): ThreadGroup[] {
  const sorted = [...threads].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return GROUP_ORDER.map(({ key, label }) => ({
    key,
    label,
    threads: sorted.filter((t) => bucketFor(t.createdAt, now) === key),
  })).filter((group) => group.threads.length > 0);
}

const SKELETON_WIDTHS = [220, 160, 250, 140, 200, 180, 230];

function NewChatButton({
  onClick,
  pending,
}: {
  onClick: () => void;
  pending: boolean;
}) {
  return (
    <Button
      type="button"
      variant="primary"
      onClick={onClick}
      disabled={pending}
      className="flex items-center gap-[7px] px-[14px] py-[7px] text-[12.5px]"
    >
      <Plus size={16} />
      {pending ? "Creating…" : "New chat"}
    </Button>
  );
}

function CenteredState({
  headline,
  subline,
  children,
}: {
  headline: string;
  subline: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
      <p className="text-[14px] font-medium text-text-2">{headline}</p>
      <p className="text-[12.5px] text-text-3">{subline}</p>
      {children}
    </div>
  );
}

/**
 * Full searchable list of the member's Myra chats. The sidebar shows recent
 * threads for quick switching; this is the browse-all surface.
 */
export function ChatsListPage() {
  const { data: threads, isLoading, isError, refetch } = useMyraThreads();
  const createThread = useCreateMyraThread();
  const relaunch = useRelaunchMyraThread();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const open = (thread: MyraThreadListItem) => {
    writeLastActiveThreadId(thread.id);
    navigate(`/chats/${thread.id}`);
  };

  // Opt-in "Update Myra" for one old thread (CL-2518): relaunch it against the
  // latest def so the newest tools load. The list refetches on success, which
  // clears this thread's `updateAvailable` and removes the button.
  const updateMyra = (threadId: string) => {
    setUpdateError(null);
    relaunch.mutate(threadId, {
      onSuccess: (result) => {
        // applied=false means the live session couldn't be torn down in time;
        // the thread is unchanged. Surface it so the user can retry (the badge
        // stays). A successful apply leaves no error and refetches the list.
        if (!result.applied) {
          setUpdateError("Could not update Myra. Try again.");
        }
      },
      onError: () => setUpdateError("Could not update Myra. Try again."),
    });
  };

  const newChat = () => {
    setNewChatError(null);
    createThread.mutate(undefined, {
      onSuccess: (thread) => {
        writeLastActiveThreadId(thread.id);
        navigate(`/chats/${thread.id}`);
      },
      onError: () => {
        setNewChatError("Could not start a new chat. Try again.");
      },
    });
  };

  const now = Date.now();
  const lastActiveId = readLastActiveThreadId();
  const hasThreads = (threads?.length ?? 0) > 0;
  const normalized = query.trim().toLowerCase();
  const filtered = (threads ?? []).filter((t) =>
    t.label.toLowerCase().includes(normalized),
  );
  const groups = buildGroups(filtered, now);

  return (
    <PagePanel>
      <LibraryPageHeader title="Chats" titleSize="sm">
        {hasThreads && (
          <>
            {(newChatError || updateError) && (
              <span className="text-[12px] text-orange-deep">
                {newChatError ?? updateError}
              </span>
            )}
            <LibrarySearchInput
              label="Search chats"
              placeholder="Search chats"
              value={query}
              onChange={setQuery}
              variant="ghost"
            />
            <NewChatButton onClick={newChat} pending={createThread.isPending} />
          </>
        )}
      </LibraryPageHeader>

      <div className="flex-1 pb-10">
        {isLoading && (
          <div>
            {SKELETON_WIDTHS.map((width, i) => (
              <div
                key={i}
                className="flex h-[46px] items-center border-b border-border px-4 last:border-b-0 sm:px-7"
              >
                <div
                  className="h-[14px] rounded bg-row-hover"
                  style={{ width }}
                />
              </div>
            ))}
          </div>
        )}

        {isError && (
          <CenteredState
            headline="Could not load chats."
            subline="Something went wrong while loading your chats."
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() => void refetch()}
              className="mt-1 px-[14px] py-[7px] text-[12.5px]"
            >
              Try again
            </Button>
          </CenteredState>
        )}

        {!isLoading && !isError && !hasThreads && (
          <CenteredState
            headline="No chats yet"
            subline="Start a new chat when you're ready."
          >
            <div className="flex flex-col items-center gap-2 pt-1">
              <NewChatButton
                onClick={newChat}
                pending={createThread.isPending}
              />
              {newChatError && (
                <span className="text-[12px] text-orange-deep">
                  {newChatError}
                </span>
              )}
            </div>
          </CenteredState>
        )}

        {!isLoading && !isError && hasThreads && filtered.length === 0 && (
          <CenteredState
            headline={`No chats match “${query.trim()}”`}
            subline="Try a different search."
          />
        )}

        {!isLoading &&
          !isError &&
          groups.map((group) => (
            <div key={group.key}>
              <div className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3 sm:px-7">
                {group.label}
              </div>
              {group.threads.map((thread) => (
                <div
                  key={thread.id}
                  className={cn(
                    "group relative flex h-[46px] w-full items-center border-b border-border transition-[background-color] duration-150 ease-[var(--ease)] last:border-b-0 hover:bg-row-hover",
                    thread.id === lastActiveId &&
                      "bg-surface-2 before:absolute before:left-0 before:top-0 before:h-full before:w-[2px] before:bg-accent before:content-['']",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => open(thread)}
                    className="flex h-full flex-1 items-center gap-3 px-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange active:bg-surface-2 sm:px-7"
                  >
                    <span className="truncate text-[14px] font-medium text-text">
                      {thread.label}
                    </span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-[12px] tabular-nums text-text-3">
                      {formatRelativeTime(thread.createdAt, now)}
                    </span>
                  </button>
                  {thread.updateAvailable && (
                    <button
                      type="button"
                      onClick={() => updateMyra(thread.id)}
                      disabled={
                        relaunch.isPending && relaunch.variables === thread.id
                      }
                      title="Update this chat to Myra's latest tools"
                      className="mr-4 grid h-[34px] shrink-0 place-items-center rounded-[6px] px-[11px] text-[11.5px] font-medium text-text-3 opacity-0 transition-[opacity,color,background-color,transform] duration-150 ease-out hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97] group-hover:opacity-100 disabled:cursor-default disabled:opacity-100 sm:mr-7"
                    >
                      {relaunch.isPending && relaunch.variables === thread.id
                        ? "Updating…"
                        : "Update Myra"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
      </div>
    </PagePanel>
  );
}
