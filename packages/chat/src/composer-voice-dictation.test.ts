/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import {
  SPEECH_SERVICE_UNAVAILABLE_MESSAGE,
  VOICE_AUTO_SEND_DELAY_SEC,
  VOICE_COUNTDOWN_TICK_MS,
  messageForSpeechRecognitionError,
  nextCountdownSecond,
  transcriptsFromResultEvent,
  useComposerVoiceDictation,
  type SpeechRecognitionErrorCode,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from "./composer-voice-dictation";
import { installFakeTimers, type FakeTimers } from "./test-support/fake-timers";

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

  it("maps speech recognition errors to user-facing copy", () => {
    expect(messageForSpeechRecognitionError("aborted")).toBeNull();
    expect(messageForSpeechRecognitionError("no-speech")).toBeNull();
    expect(messageForSpeechRecognitionError("not-allowed")).toBe(
      "Microphone access was denied.",
    );
    expect(messageForSpeechRecognitionError("audio-capture")).toBe(
      "No microphone was found.",
    );
    expect(messageForSpeechRecognitionError("network")).toBe(
      SPEECH_SERVICE_UNAVAILABLE_MESSAGE,
    );
    expect(messageForSpeechRecognitionError("service-not-allowed")).toBe(
      SPEECH_SERVICE_UNAVAILABLE_MESSAGE,
    );
    expect(messageForSpeechRecognitionError("language-not-supported")).toBe(
      "Speech recognition does not support this language.",
    );
    expect(messageForSpeechRecognitionError("unknown-code")).toBe(
      "Voice input failed. Try again.",
    );
  });
});

class MockSpeechRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "en-US";
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onspeechend: (() => void) | null = null;
  onerror: ((event: { error: SpeechRecognitionErrorCode }) => void) | null =
    null;
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

  emitError(error: SpeechRecognitionErrorCode) {
    this.onerror?.({ error });
  }

  emitEnd() {
    this.onend?.();
  }
}

function setupVoiceHook(
  sendBlocked = false,
  createRecognition?: () => SpeechRecognitionLike | null,
) {
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
        createRecognition:
          createRecognition ??
          (() => {
            recognition = new MockSpeechRecognition();
            return recognition;
          }),
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
    const { hook, getRecognition, onSend } = setupVoiceHook(true);

    act(() => {
      hook.result.current.toggleListening();
    });

    act(() => {
      getRecognition()!.emitResult("later", true);
      getRecognition()!.emitSpeechEnd();
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

  it("disarms and explains when speech recognition is network-blocked", () => {
    const { hook, getRecognition } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    expect(hook.result.current.phase).toBe("listening");
    const rec = getRecognition()!;
    // Capture the live onend before stopRecognition nulls handlers, so we
    // exercise the armedRef / recognitionRef guards — not just handler teardown.
    const onend = rec.onend;
    expect(onend).not.toBeNull();

    act(() => {
      rec.emitError("network");
    });

    expect(hook.result.current.phase).toBe("off");
    expect(hook.result.current.error).toBe(SPEECH_SERVICE_UNAVAILABLE_MESSAGE);

    act(() => {
      onend!();
    });
    expect(hook.result.current.phase).toBe("off");
    expect(rec.start).toHaveBeenCalledTimes(1);
  });

  it("disarms on service-not-allowed with the same unavailable message", () => {
    const { hook, getRecognition } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    act(() => {
      getRecognition()!.emitError("service-not-allowed");
    });

    expect(hook.result.current.phase).toBe("off");
    expect(hook.result.current.error).toBe(SPEECH_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("disarms on mic denial with a specific message", () => {
    const { hook, getRecognition } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    act(() => {
      getRecognition()!.emitError("not-allowed");
    });

    expect(hook.result.current.phase).toBe("off");
    expect(hook.result.current.error).toBe("Microphone access was denied.");
  });

  it("ignores benign no-speech without leaving listening", () => {
    const { hook, getRecognition } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    act(() => {
      getRecognition()!.emitError("no-speech");
    });

    expect(hook.result.current.phase).toBe("listening");
    expect(hook.result.current.error).toBeNull();
  });

  it("cancels countdown and auto-send on fatal error mid-countdown", () => {
    const { hook, getRecognition, onSend } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    const rec = getRecognition()!;
    act(() => {
      rec.emitResult("partial", true);
      rec.emitSpeechEnd();
    });
    expect(hook.result.current.phase).toBe("countdown");

    act(() => {
      rec.emitError("network");
    });

    expect(hook.result.current.phase).toBe("off");
    expect(hook.result.current.countdownSec).toBeNull();
    advanceVoiceCountdown(timers);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not flush a deferred auto-send after a fatal error", () => {
    const { hook, getRecognition, onSend } = setupVoiceHook(true);

    act(() => {
      hook.result.current.toggleListening();
    });

    const rec = getRecognition()!;
    act(() => {
      rec.emitResult("later", true);
      rec.emitSpeechEnd();
    });
    advanceVoiceCountdown(timers);
    expect(hook.result.current.phase).toBe("sending");
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      rec.emitError("network");
    });
    expect(hook.result.current.phase).toBe("off");

    act(() => {
      hook.rerender({ sendBlocked: false });
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("re-arms and clears the error after a fatal failure", () => {
    const { hook, getRecognition } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });
    act(() => {
      getRecognition()!.emitError("network");
    });
    expect(hook.result.current.phase).toBe("off");
    expect(hook.result.current.error).toBe(SPEECH_SERVICE_UNAVAILABLE_MESSAGE);

    act(() => {
      hook.result.current.toggleListening();
    });
    expect(hook.result.current.phase).toBe("listening");
    expect(hook.result.current.error).toBeNull();
    expect(getRecognition()!.start).toHaveBeenCalledTimes(1);
  });

  it("disarms when the recognition factory returns null", () => {
    const { hook } = setupVoiceHook(false, () => null);

    act(() => {
      hook.result.current.toggleListening();
    });

    expect(hook.result.current.phase).toBe("off");
    expect(hook.result.current.error).toBe(
      "Voice input is not available in this browser.",
    );

    // Re-toggle must not stick in an armed listening state either
    act(() => {
      hook.result.current.toggleListening();
    });
    expect(hook.result.current.phase).toBe("off");
  });

  it("keeps countdown running through a benign no-speech error", () => {
    const { hook, getRecognition, onSend } = setupVoiceHook();

    act(() => {
      hook.result.current.toggleListening();
    });

    const rec = getRecognition()!;
    act(() => {
      rec.emitResult("keep going", true);
      rec.emitSpeechEnd();
    });
    expect(hook.result.current.phase).toBe("countdown");

    act(() => {
      rec.emitError("no-speech");
    });
    expect(hook.result.current.phase).toBe("countdown");
    expect(hook.result.current.error).toBeNull();

    advanceVoiceCountdown(timers);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
