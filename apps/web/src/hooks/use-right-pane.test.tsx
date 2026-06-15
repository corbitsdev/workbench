/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { useRightPane } from './use-right-pane';

let api: ReturnType<typeof useRightPane>;

function Harness({ onShow, onClose }: { onShow?: () => void; onClose?: () => void }) {
  api = useRightPane({ onShow, onClose });
  return React.createElement('span', null, api.rightPane.view);
}

afterEach(cleanup);

describe('useRightPane', () => {
  it('starts on the gallery pane', () => {
    render(React.createElement(Harness, {}));
    expect(api.rightPane.view).toBe('gallery');
  });

  it('routes to the agent pane and calls onShow', () => {
    const onShow = mock(() => {});
    render(React.createElement(Harness, { onShow }));
    act(() =>
      api.showAgent({
        instanceId: 'inst-1',
        tenantId: 'tn-1',
        agentName: 'Loop',
      })
    );
    expect(api.rightPane).toEqual({
      view: 'agent',
      instanceId: 'inst-1',
      tenantId: 'tn-1',
      agentName: 'Loop',
    });
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('promotes a created workflow only while the wizard is the active pane', () => {
    render(React.createElement(Harness, {}));
    act(() => api.promoteCreatedWorkflow('wf-9'));
    expect(api.rightPane.view).toBe('gallery');

    act(() => api.showNewWorkflow('presentation-generation'));
    act(() => api.promoteCreatedWorkflow('wf-9'));
    expect(api.rightPane).toEqual({ view: 'workflow', workflowId: 'wf-9' });
  });

  it('closes the workflow pane only when the matching workflow is deleted', () => {
    const onClose = mock(() => {});
    render(React.createElement(Harness, { onClose }));
    act(() => api.showWorkflow('wf-1'));
    act(() => api.closeWorkflow('wf-other'));
    expect(api.rightPane).toEqual({ view: 'workflow', workflowId: 'wf-1' });
    act(() => api.closeWorkflow('wf-1'));
    expect(api.rightPane.view).toBe('gallery');
    expect(onClose).toHaveBeenCalled();
  });
});
