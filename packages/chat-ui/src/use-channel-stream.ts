// Live updates for a channel: subscribe over SSE, reconnecting with
// exponential backoff + jitter on drop, polling `onPoll` on an interval the
// whole time the stream is down so the timeline keeps advancing, and
// forcing an immediate reconnect attempt when the tab refocuses or the
// network comes back. `onEvent` fires for every SSE message the platform's
// stream emits (chat.settings, chat.typing, and the platform's own run
// events); the caller decides what to do with each — this hook only owns
// the transport, and connection state is never something the caller should
// render as chrome.

import { useEffect, useRef, useState } from "react";

export type ChannelStreamState = "connecting" | "live" | "polling";

/**
 * The S3 fix, isolated as a pure rule: with no active channel there is
 * nothing to stream, so the hook must not open an `EventSource` or start a
 * poll timer at all — an empty url is the caller's signal for that.
 */
export function shouldConnect(url: string): boolean {
  return url !== "";
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const POLL_INTERVAL_MS = 5000;

/**
 * Exponential backoff capped at `maxDelayMs`, with up to 30% jitter layered
 * on top so a bench of clients that all dropped together don't all retry in
 * lockstep. `random` is injectable so the schedule is testable without
 * flakiness.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
  baseDelayMs = BASE_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const withJitter = exponential + exponential * 0.3 * random();
  return Math.round(Math.min(maxDelayMs, withJitter));
}

export interface ChannelStreamIntervals {
  readonly pollMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export function useChannelStream(
  url: string,
  onEvent: (eventType: string, data: unknown) => void,
  onPoll: () => void,
  intervals?: ChannelStreamIntervals,
): ChannelStreamState {
  const [state, setState] = useState<ChannelStreamState>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;
  const pollMs = intervals?.pollMs ?? POLL_INTERVAL_MS;
  const baseDelayMs = intervals?.baseDelayMs ?? BASE_DELAY_MS;
  const maxDelayMs = intervals?.maxDelayMs ?? MAX_DELAY_MS;

  useEffect(() => {
    if (!shouldConnect(url)) return;

    let cancelled = false;
    let attempts = 0;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      if (pollTimer === undefined) return;
      clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const startPolling = () => {
      if (cancelled || pollTimer !== undefined) return;
      setState("polling");
      onPollRef.current();
      pollTimer = setInterval(() => onPollRef.current(), pollMs);
    };

    const connect = () => {
      if (cancelled) return;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      source?.close();
      setState((current) => (current === "polling" ? current : "connecting"));
      source = new EventSource(url);

      source.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        stopPolling();
        setState("live");
        // One silent refresh on reopen to catch anything missed while down.
        onPollRef.current();
      };

      source.onerror = () => {
        source?.close();
        if (cancelled) return;
        startPolling();
        attempts += 1;
        const delay = backoffDelayMs(
          attempts,
          Math.random,
          baseDelayMs,
          maxDelayMs,
        );
        reconnectTimer = setTimeout(connect, delay);
      };

      const forward = (eventType: string) => (message: MessageEvent) => {
        if (cancelled) return;
        try {
          onEventRef.current(
            eventType,
            message.data === undefined ? undefined : JSON.parse(message.data),
          );
        } catch {
          onEventRef.current(eventType, message.data);
        }
      };

      // "chat.agent" is the event name the server's channel stream
      // actually emits for every agent-run event (mail delivered,
      // inference progress, replies) — it is what makes a connected
      // stream refresh the timeline at all.
      for (const eventType of [
        "chat.agent",
        "chat.settings",
        "chat.typing",
        "chat.reaction",
        "chat.pin",
        "message",
      ]) {
        source.addEventListener(eventType, forward(eventType));
      }
    };

    // A reconnect kick from the browser noticing the tab refocused or the
    // network came back — skip it if the stream is already open so it
    // never interrupts a healthy connection.
    const reconnectNow = () => {
      if (cancelled || source?.readyState === EventSource.OPEN) return;
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", reconnectNow);

    connect();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", reconnectNow);
      source?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      stopPolling();
    };
  }, [url, pollMs, baseDelayMs, maxDelayMs]);

  return state;
}
