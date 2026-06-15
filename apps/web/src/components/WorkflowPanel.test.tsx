/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkflowPanel } from './WorkflowPanel';

// Drive the real use-workflow hooks through the fetch boundary + a pre-seeded
// query cache instead of module-mocking ../hooks/use-workflow. The local-module
// mock leaked process-wide under bun and replaced the real hooks in
// use-workflow.test. Seeding the cache makes the real useWorkflow return data
// synchronously, so the existing synchronous assertions keep working.
const originalFetch = globalThis.fetch;

type WorkflowData = Record<string, unknown>;

let workflowMode: 'data' | 'loading' | 'error' = 'data';
let currentWorkflow: WorkflowData | null = null;
let approveOk = true;
let artifactPatches: unknown[] = [];

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function routeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (method === 'PATCH' && url.includes('/artifacts/') && url.includes('/status')) {
    artifactPatches.push({ url, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(jsonResponse(approveOk, approveOk ? {} : { error: 'nope' }));
  }
  if (method === 'PATCH' && url.includes('/company')) {
    return Promise.resolve(jsonResponse(true, { id: 'wf-1', companyName: 'Acme Corp' }));
  }
  if (method === 'PATCH' && url.includes('/step-config')) {
    return Promise.resolve(jsonResponse(true, { id: 'wf-1', stepConfig: {} }));
  }
  if (method === 'POST' && url.includes('/steps')) {
    return Promise.resolve(jsonResponse(true, {}));
  }
  if (url.includes('/me/principals')) {
    return Promise.resolve(jsonResponse(true, { data: [] }));
  }
  if (url.includes('/api/v1/me')) {
    return Promise.resolve(jsonResponse(true, { rootTenantIds: [], personalTenantId: null }));
  }
  if (url.includes('/agents?tenantId=')) {
    return Promise.resolve(jsonResponse(true, { data: [] }));
  }
  // GET /workflows/wf-1
  if (url.includes('/workflows/wf-1')) {
    if (workflowMode === 'loading') return new Promise<Response>(() => undefined);
    // 404 so useWorkflow's custom retry (retries everything except 404) stops
    // immediately and the query surfaces its error state within the test window.
    if (workflowMode === 'error')
      return Promise.resolve(jsonResponse(false, { error: 'boom' }, 404));
    return Promise.resolve(jsonResponse(true, currentWorkflow));
  }
  return Promise.resolve(jsonResponse(true, {}));
}

function makeWorkflow(overrides: WorkflowData = {}): WorkflowData {
  return {
    id: 'wf-1',
    kind: 'collateral-generation',
    status: 'pending',
    currentStep: 'analyze',
    companyName: 'Acme Corp',
    stepConfig: {},
    steps: {
      intake: { completed: true, transcriptId: 'tx-1' },
      analyze: { completed: false, painPoints: [] },
      generate: { completed: false, artifacts: [] },
    },
    ...overrides,
  };
}

const onClose = mock(() => {});

beforeEach(() => {
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
  workflowMode = 'data';
  currentWorkflow = makeWorkflow();
  approveOk = true;
  artifactPatches = [];
  onClose.mockClear();
  globalThis.fetch = mock((url: string, init?: RequestInit) =>
    routeFetch(String(url), init)
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPanel(close: () => void = onClose) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the cache so the real useWorkflow returns data synchronously on first
  // render; the background refetch returns the same data and is a no-op.
  if (workflowMode === 'data' && currentWorkflow) {
    client.setQueryData(['workflow', 'wf-1'], currentWorkflow);
  }
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(WorkflowPanel, { workflowId: 'wf-1', onClose: close })
    )
  );
}

describe('WorkflowPanel loading state', () => {
  it('shows loading text while data is being fetched', () => {
    workflowMode = 'loading';
    renderPanel();
    screen.getByText(/loading workflow/i);
  });
});

describe('WorkflowPanel error state', () => {
  it('shows error text when workflow fetch fails', async () => {
    workflowMode = 'error';
    renderPanel();
    await screen.findByText(/could not load workflow/i);
  });
});

describe('WorkflowPanel analyze step', () => {
  beforeEach(() => {
    currentWorkflow = makeWorkflow({ currentStep: 'analyze', status: 'pending' });
  });

  it('shows the workflow title', () => {
    renderPanel();
    screen.getByText('Acme Corp');
  });

  it('shows the horizontal stepper', () => {
    renderPanel();
    screen.getByText('Analyze');
    screen.getByText('Generate');
  });

  it('shows Run analysis button before pain points are extracted', () => {
    renderPanel();
    screen.getByRole('button', { name: /run analysis/i });
  });
});

describe('WorkflowPanel generate step', () => {
  const painPoints = [
    {
      id: 'pp-1',
      context: 'Slow onboarding',
      quote: 'Takes weeks',
      severity: 'high',
      selected: false,
    },
    {
      id: 'pp-2',
      context: 'No integrations',
      quote: 'Cannot connect',
      severity: 'medium',
      selected: false,
    },
  ];

  beforeEach(() => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'ready',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: { completed: true, painPoints },
        generate: { completed: false, artifacts: [] },
      },
    });
  });

  it('shows the extracted pain points', () => {
    renderPanel();
    screen.getByText('Slow onboarding');
    screen.getByText('No integrations');
  });

  it('shows collateral type options', () => {
    renderPanel();
    screen.getByText('Follow-up Email');
    screen.getByText('Battlecard');
  });

  it('shows a Generate button after analyze completes', () => {
    renderPanel();
    screen.getByRole('button', { name: /generate collateral/i });
  });
});

describe('WorkflowPanel presentation-generation workflow', () => {
  beforeEach(() => {
    currentWorkflow = makeWorkflow({
      kind: 'presentation-generation',
      currentStep: 'analyze',
      status: 'pending',
    });
  });

  it('does not show pain points section', () => {
    renderPanel();
    expect(screen.queryByText(/pain points/i)).toBeNull();
  });

  it('does not show collateral type options', () => {
    renderPanel();
    expect(screen.queryByText('Battlecard')).toBeNull();
    expect(screen.queryByText('Follow-up Email')).toBeNull();
  });

  it('does not show the Run analysis button', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /run analysis/i })).toBeNull();
  });

  it('does not show collateral type picker or Generate button in ready state', () => {
    currentWorkflow = makeWorkflow({
      kind: 'presentation-generation',
      currentStep: 'generate',
      status: 'ready',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: {
          completed: true,
          painPoints: [
            {
              id: 'pp-1',
              context: 'Slow onboarding',
              quote: 'Takes weeks',
              severity: 'high',
              selected: false,
            },
          ],
        },
        generate: { completed: false, artifacts: [] },
      },
    });
    renderPanel();
    expect(screen.queryByText('Battlecard')).toBeNull();
    expect(screen.queryByRole('button', { name: /generate collateral/i })).toBeNull();
  });

  it('does not show Generating button in generating state', () => {
    currentWorkflow = makeWorkflow({
      kind: 'presentation-generation',
      currentStep: 'generate',
      status: 'generating',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: {
          completed: true,
          painPoints: [
            {
              id: 'pp-1',
              context: 'Slow onboarding',
              quote: 'Takes weeks',
              severity: 'high',
              selected: true,
            },
          ],
        },
        generate: { completed: false, artifacts: [] },
      },
    });
    renderPanel();
    expect(screen.queryByRole('button', { name: /generating/i })).toBeNull();
  });
});

describe('WorkflowPanel generating state', () => {
  const painPoints = [
    {
      id: 'pp-1',
      context: 'Slow onboarding',
      quote: 'Takes weeks',
      severity: 'high',
      selected: true,
    },
  ];

  beforeEach(() => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'generating',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: { completed: true, painPoints },
        generate: { completed: false, artifacts: [] },
      },
    });
  });

  it('collapses the form to a disabled Generating button', () => {
    renderPanel();
    const button = screen.getByRole('button', { name: /generating/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /generate collateral/i })).toBeNull();
  });

  it('hides the collateral type toggles while generating', () => {
    renderPanel();
    expect(screen.queryByText('Battlecard')).toBeNull();
  });

  it('shows the submitted pain point as a read-only summary', () => {
    renderPanel();
    screen.getByText('Slow onboarding');
  });
});

describe('WorkflowPanel done step', () => {
  const artifacts = [
    {
      id: 'art-1',
      kind: 'email',
      title: 'Email draft',
      content: 'Dear prospect…',
      status: 'approved',
      version: 1,
    },
  ];

  beforeEach(() => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'done',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: { completed: true, painPoints: [] },
        generate: { completed: true, artifacts },
      },
    });
  });

  it('shows the completion state when all artifacts are reviewed', () => {
    renderPanel();
    screen.getByText(/all artifacts reviewed/i);
  });

  it('lists approved artifact titles in the completion state', () => {
    renderPanel();
    screen.getByText('Email draft');
  });

  it('shows the artifacts-saved note in the completion state', () => {
    renderPanel();
    screen.getByText(/your approved pieces have been saved to artifacts/i);
  });

  it('shows all stepper steps as completed or current', () => {
    renderPanel();
    screen.getByText('Generate');
  });

  it('does not show improve or export steps', () => {
    renderPanel();
    expect(screen.queryByText('Improve')).toBeNull();
    expect(screen.queryByText('Export')).toBeNull();
  });

  it('calls onClose when the completion CTA is pressed', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /close workflow/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowPanel done step — all denied', () => {
  beforeEach(() => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'done',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: { completed: true, painPoints: [] },
        generate: {
          completed: true,
          artifacts: [
            {
              id: 'art-1',
              kind: 'email',
              title: 'Email draft',
              content: 'Dear prospect…',
              status: 'rejected',
              version: 1,
            },
          ],
        },
      },
    });
  });

  it('shows the all-denied message when no artifacts were approved', () => {
    renderPanel();
    screen.getByText(/all pieces were denied/i);
  });

  it('does not show the saved-to-artifacts note when nothing was approved', () => {
    renderPanel();
    expect(screen.queryByText(/your approved pieces have been saved/i)).toBeNull();
  });
});

describe('WorkflowPanel artifact review (CL-1905)', () => {
  beforeEach(() => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'reviewing',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: { completed: true, painPoints: [] },
        generate: {
          completed: true,
          artifacts: [
            {
              id: 'art-1',
              kind: 'email',
              title: 'Email draft',
              content: 'Dear prospect…',
              status: 'draft',
              version: 1,
            },
          ],
        },
      },
    });
  });

  it('submits the review through the approval mutation with the right payload', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => {
      expect(artifactPatches).toHaveLength(1);
    });
    const patch = artifactPatches[0] as { url: string; body: { status: string } };
    expect(patch.url).toContain('/artifacts/art-1/status');
    expect(patch.body).toEqual({ status: 'approved' });
    // Success path surfaces no error alert.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces an error message when the approval mutation fails', async () => {
    approveOk = false;
    const user = userEvent.setup();
    renderPanel();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not save/i);
    });
  });
});

describe('WorkflowPanel malformed server data (CL-1912)', () => {
  it('renders only the valid pain points when the payload contains malformed items', () => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'ready',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: {
          completed: true,
          painPoints: [
            {
              id: 'pp-1',
              context: 'Slow onboarding',
              quote: 'Takes weeks',
              severity: 'high',
              selected: false,
            },
            null,
            { id: 42, context: 'wrong shape' },
            { context: 'missing id', quote: 'x' },
          ],
        },
        generate: { completed: false, artifacts: [] },
      },
    });
    renderPanel();
    screen.getByText('Slow onboarding');
    expect(screen.queryByText('wrong shape')).toBeNull();
    expect(screen.queryByText('missing id')).toBeNull();
  });

  it('renders only the valid artifacts and does not crash on malformed ones', () => {
    currentWorkflow = makeWorkflow({
      currentStep: 'generate',
      status: 'done',
      steps: {
        intake: { completed: true, transcriptId: 'tx-1' },
        analyze: { completed: true, painPoints: [] },
        generate: {
          completed: true,
          artifacts: [
            {
              id: 'art-1',
              kind: 'email',
              title: 'Valid email',
              content: 'Dear prospect',
              status: 'approved',
            },
            // A legacy/variant kind the renderer still handles via its default
            // branch — it must be KEPT, not dropped (the boundary parser must
            // not be stricter than ArtifactBody).
            {
              id: 'art-2',
              kind: 'follow-up-email',
              title: 'Variant kind',
              content: 'Body',
              status: 'draft',
            },
            null,
            { id: 'art-3', title: 'missing fields' },
          ],
        },
      },
    });
    renderPanel();
    // The variant-kind artifact (art-2, status 'draft') must survive parsing —
    // its presence is what makes the review action bar render. The genuinely
    // malformed items (null, missing fields) drop.
    screen.getByRole('button', { name: /approve/i });
    expect(screen.queryByText('missing fields')).toBeNull();
  });
});
