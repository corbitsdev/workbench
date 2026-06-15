/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import React from 'react';
import { ChatLauncherProvider, useChatLauncher } from './chat-launcher-context';

afterEach(cleanup);

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(ChatLauncherProvider, null, children);
}

describe('useChatLauncher', () => {
  it('defaults to not hidden and toggles hidden via setHidden', () => {
    const { result } = renderHook(() => useChatLauncher(), { wrapper });

    expect(result.current.hidden).toBe(false);

    act(() => result.current.setHidden(true));
    expect(result.current.hidden).toBe(true);

    act(() => result.current.setHidden(false));
    expect(result.current.hidden).toBe(false);
  });

  it('invokes the registered reconnect callback when notifyProvisioned is called', () => {
    const { result } = renderHook(() => useChatLauncher(), { wrapper });
    let reconnectCount = 0;

    act(() => result.current.registerReconnect(() => (reconnectCount += 1)));
    act(() => result.current.notifyProvisioned());

    expect(reconnectCount).toBe(1);
  });

  it('does nothing when notifyProvisioned is called before a reconnect is registered', () => {
    const { result } = renderHook(() => useChatLauncher(), { wrapper });

    expect(() => act(() => result.current.notifyProvisioned())).not.toThrow();
  });

  it('uses the most recently registered reconnect callback', () => {
    const { result } = renderHook(() => useChatLauncher(), { wrapper });
    const fired: string[] = [];

    act(() => result.current.registerReconnect(() => fired.push('first')));
    act(() => result.current.registerReconnect(() => fired.push('second')));
    act(() => result.current.notifyProvisioned());

    expect(fired).toEqual(['second']);
  });
});
