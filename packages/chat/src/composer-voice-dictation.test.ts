/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import {
  VOICE_AUTO_SEND_DELAY_SEC,
  nextCountdownSecond,
  transcriptsFromResultEvent,
  useComposerVoiceDictation,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from "./composer-voice-dictation";
import {
  installFakeTimers,
  type FakeTimers,
} from "./test-support/fake-timers";

const VOICE_COUNTDOWN_TICK_MS = 1000;

function advanceVoiceCountdown(timers: FakeTimers) {
  act(() => {
    timers.advance(VOICE_AUTO_SEND_DELAY_SEC * VOICE_COUNTDOWN_TICK_MS);
  });
}

describe("composer-voice-dictation helpers", () => {
  it("ticks countdown down to null at one", () => {
    expect(nextCountdownSecond(3)).toBe(2);
    expect(nextCountdownSecond(1)).toBeNull();
  });

  it("splits final and interim transcripts from a result event", () => {
    const event: SpeechRecognitionEventLike = {
      resultIndex: 0,
      results: {
        length: 2,
        0: { isFinal: true, 0: { transcript: "hello " } },
        1: { isFinal: false, 0: { transcript: "world" } },
      },
    };
    expect(transcriptsFromResultEvent(event)).toEqual({
      finalChunk: "hello ",
      interim: "world",
    });
  });
});

class MockSpeechRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "en-US";
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onspeechend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start = mock(() => {});
  stop = mock(() => {});
  abort = mock(() => {});

  emitResult(text: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal, 0: { transcript: text } },
      },
    });
  }

  emitSpeechEnd() {
    this.onspeechend?.();
  }
}

function setupVoiceHook(sendBlocked = false) {
  let draft = "";
  let recognition: MockSpeechRecognition | null = null;
  const onSend = mock(() => {});

  const hook = renderHook(
    (props: { sendBlocked: boolean }) =>
      useComposerVoiceDictation({
        enabled: true,
        disabled: false,
        sendBlocked: props.sendBlocked,
        getDraft: () => draft,
        setDraft: (value: string) => {
          draft = value;
        },
        triggerSend: onSend,
        createRecognition: () => {
          recognition = new MockSpeechRecognition();
          return recognition;
        },
      }),
    { initialProps: { sendBlocked } },
  );

  return {
    hook,
    getDraft: () => draft,
    getRecognition: () => recognition,
    onSend,
  };
}

afterEach(() => {
  mock.restore();
});

describe("useComposerVoiceDictation", () => {
  let timers: FakeTimers;

  beforeEach(() => {
    timers = installFakeTimers();
  });

  afterEach(() => {
    timers.restore();
  });

  it("transcribes speech into the draft while listening", () => {
    const { hook, getDraft, getRecognition } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    const rec = getRecognition();
    expect(rec).not.toBeNull();
    act(() => {
      rec!.emitResult("hello", true);
    });

    expect(getDraft()).toBe("hello");
    expect(hook.result.current.phase).toBe("listening");
  });

  it("auto-sends after end-of-speech countdown", () => {
    const { hook, getRecognition, onSend } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    const rec = getRecognition()!;
    act(() => {
      rec.emitResult("ship it", true);
      rec.emitSpeechEnd();
    });

    expect(hook.result.current.phase).toBe("countdown");
    expect(hook.result.current.countdownSec).toBe(VOICE_AUTO_SEND_DELAY_SEC);

    advanceVoiceCountdown(timers);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe("listening");
  });

  it("defers auto-send while the composer is blocked", () => {
    let draft = "";
    let recognition: MockSpeechRecognition | null = null;
    const onSend = mock(() => {});

    const hook = renderHook(
      (props: { sendBlocked: boolean }) =>
        useComposerVoiceDictation({
          enabled: true,
          disabled: false,
          sendBlocked: props.sendBlocked,
          getDraft: () => draft,
          setDraft: (value: string) => {
            draft = value;
          },
          triggerSend: onSend,
          createRecognition: () => {
            recognition = new MockSpeechRecognition();
            return recognition;
          },
        }),
      { initialProps: { sendBlocked: true } },
    );

    act(() => {
      hook.result.current.toggleListening();
    });

    act(() => {
      recognition!.emitResult("later", true);
      recognition!.emitSpeechEnd();
    });

    advanceVoiceCountdown(timers);
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      hook.rerender({ sendBlocked: false });
    });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("cancels the countdown without sending", () => {
    const { hook, getRecognition, onSend } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    const rec = getRecognition()!;
    act(() => {
      rec.emitResult("wait", true);
      rec.emitSpeechEnd();
    });

    act(() => {
      hook.result.current.cancelVoice();
    });

    expect(hook.result.current.phase).toBe("listening");
    expect(hook.result.current.countdownSec).toBeNull();

    advanceVoiceCountdown(timers);
    expect(onSend).not.toHaveBeenCalled();
  });
});