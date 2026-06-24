import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChatPanel } from '@workbench/chat';
import type { ChatMessage } from '@workbench/chat';
import { useStartWorkflow, useWorkflowRecord } from '../hooks/use-workflow';

const WORKFLOW_KIND = 'myra-ephemeral-spike';

type Turn = { role: 'user' | 'assistant'; content: string };

function extractReply(outputs: Record<string, unknown>): string {
  const chat = outputs.chat;
  if (typeof chat !== 'object' || chat === null) {
    return 'Run completed but chat output was missing.';
  }
  const reply = (chat as { reply?: unknown }).reply;
  if (typeof reply === 'string' && reply.length > 0) return reply;
  return JSON.stringify(chat);
}

function turnsToMessages(turns: Turn[]): ChatMessage[] {
  const now = new Date().toISOString();
  return turns.map((turn, index) => ({
    id: `turn-${index}`,
    role: turn.role === 'user' ? 'user' : 'agent',
    content: turn.content,
    createdAt: now,
  }));
}

export function EphemeralMyraSpikePage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const settledRunId = useRef<string | null>(null);

  const start = useStartWorkflow(null);
  const record = useWorkflowRecord(activeRunId, null);

  const waitingOnRun =
    activeRunId !== null &&
    (record.isLoading || record.data?.status === 'running' || record.data?.status === 'awaiting');
  const busy = start.isPending || waitingOnRun;

  useEffect(() => {
    const data = record.data;
    if (!data || !activeRunId || settledRunId.current === activeRunId) return;

    if (data.status === 'completed') {
      settledRunId.current = activeRunId;
      setTurns((prev) => [...prev, { role: 'assistant', content: extractReply(data.outputs) }]);
      setActiveRunId(null);
      return;
    }

    if (data.status === 'failed') {
      settledRunId.current = activeRunId;
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: data.error ?? 'Workflow run failed.' },
      ]);
      setActiveRunId(null);
    }
  }, [record.data, activeRunId]);

  const send = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!message || busy) return;

      const history = turns;
      setTurns((prev) => [...prev, { role: 'user', content: message }]);
      settledRunId.current = null;

      start
        .mutateAsync({ kind: WORKFLOW_KIND, input: { message, history } })
        .then((seeded) => setActiveRunId(seeded.runId))
        .catch((err: unknown) => {
          setTurns((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: err instanceof Error ? err.message : 'Failed to start workflow run.',
            },
          ]);
        });
    },
    [busy, turns, start]
  );

  const messages = useMemo(() => turnsToMessages(turns), [turns]);

  const notice =
    turns.length === 0 ? (
      <p className="text-sm text-text-2">
        Each message starts a workflow run with inline inference (no per-user harness). Deploy{' '}
        <code className="text-text-1">myra-ephemeral-spike</code> on staging if the kind is missing.
      </p>
    ) : null;

  return (
    <div className="flex h-full flex-col bg-page text-text-1">
      <header className="border-b border-border px-6 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-text-3">Myra</p>
        <h1 className="text-xl font-semibold tracking-tight">Workflow chat</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-2">
          Thin loop: system prompt, client history, one model turn per message. Docked Myra (instance
          session) is unchanged.{' '}
          <Link to="/settings" className="text-accent underline-offset-2 hover:underline">
            Settings
          </Link>
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <ChatPanel
          agent={{ name: 'Myra', tagline: 'Workflow (ephemeral)' }}
          messages={messages}
          onSend={send}
          typing={busy}
          inputDisabled={busy}
          dockState="docked"
          className="mx-auto h-full w-full max-w-3xl"
          notice={notice}
        />
      </div>
    </div>
  );
}