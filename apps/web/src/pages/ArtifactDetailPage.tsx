import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Send } from 'lucide-react';
import { useArtifacts } from '@workbench/client/react';
import type { ArtifactWithSession } from '@workbench/artifact';
import { clientOptions } from '../lib/client-options';
import ArtifactBody from '../components/ArtifactBody';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { resolveKindLabel } from '../lib/resolve-kind-label';
import { buildArtifactMessage } from '../components/layout/ArtifactGallery';
import { useActiveWorkbench } from '../lib/active-workbench-context';
import { useCreateMyraThread, writeLastActiveThreadId } from '../hooks/use-myra-threads';
import { setPendingFirstMessage } from '../lib/pending-first-message';

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-text-2">
      {children}
    </div>
  );
}

/**
 * Full-page view of a single artifact: type-adaptive render (ArtifactBody) on
 * the left, a chat composer on the right. Sending starts a NEW Myra thread
 * seeded with this artifact as context — no "open in Myra" button needed.
 */
export function ArtifactDetailPage() {
  const { artifactId } = useParams();
  const navigate = useNavigate();
  const { activeTenantId } = useActiveWorkbench();
  const createThread = useCreateMyraThread();
  const [draft, setDraft] = useState('');

  const {
    data: artifacts,
    isLoading,
    isError,
  } = useArtifacts(clientOptions, {
    tenantId: activeTenantId,
    enabled: !!activeTenantId,
  });

  const artifact: ArtifactWithSession | null =
    (artifacts ?? []).find((a) => a.id === artifactId) ?? null;

  const startThread = () => {
    const text = draft.trim();
    if (!text || !artifact) return;
    createThread.mutate(undefined, {
      onSuccess: (thread) => {
        const seeded = `${buildArtifactMessage(artifact, activeTenantId ?? undefined)}\n\n${text}`;
        setPendingFirstMessage(thread.id, seeded);
        writeLastActiveThreadId(thread.id);
        navigate(`/chats/${thread.id}`);
      },
    });
  };

  if (isLoading) return <CenteredNotice>Loading artifact…</CenteredNotice>;

  if (isError || !artifact) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>This artifact couldn't be found.</span>
          <Link to="/artifacts" className="text-orange underline">
            Back to artifacts
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={() => navigate('/artifacts')}
            aria-label="Back to artifacts"
            className="grid h-8 w-8 place-items-center rounded-[8px] text-text-2 transition-colors hover:bg-page hover:text-text"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-text">{artifact.title}</h1>
            <p className="text-xs text-text-3">{resolveKindLabel(artifact.kind)}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <ErrorBoundary>
            <ArtifactBody artifact={artifact} />
          </ErrorBoundary>
        </div>
      </div>

      <div className="flex shrink-0 flex-col border-t border-border lg:w-[360px] lg:border-l lg:border-t-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text">Ask about this artifact</h2>
          <p className="text-xs text-text-3">
            Sending starts a new chat with this artifact as context.
          </p>
        </div>
        <div className="min-h-0 flex-1" />
        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2 rounded-[10px] border border-border bg-surface p-2 focus-within:border-orange">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  startThread();
                }
              }}
              rows={2}
              placeholder="Ask Myra about this artifact…"
              className="min-h-0 flex-1 resize-none bg-transparent text-sm text-text outline-none placeholder:text-text-3"
            />
            <button
              type="button"
              onClick={startThread}
              disabled={draft.trim() === '' || createThread.isPending}
              aria-label="Start chat"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-orange text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
