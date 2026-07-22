import { useCallback, useEffect, useRef, useState } from "react";

/** Seconds between detected end-of-speech and auto-send. */
export const VOICE_AUTO_SEND_DELAY_SEC = 3;

/** Countdown tick interval (ms). Kept in lockstep with the auto-send timer. */
export const VOICE_COUNTDOWN_TICK_MS = 1000;

export type ComposerVoicePhase = "off" | "listening" | "countdown" | "sending";

/** Well-known Web Speech API `SpeechRecognitionErrorEvent.error` codes. */
export type SpeechRecognitionErrorCode =
  | "aborted"
  | "no-speech"
  | "not-allowed"
  | "audio-capture"
  | "network"
  | "service-not-allowed"
  | "language-not-supported"
  | "bad-grammar"
  | (string & {});

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onspeechend: (() => void) | null;
  onerror: ((event: { error: SpeechRecognitionErrorCode }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      0: { transcript: string };
    };
  };
};

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Shared copy for network / service blocks (offline, Brave, corporate firewall). */
export const SPEECH_SERVICE_UNAVAILABLE_MESSAGE =
  "Speech recognition is unavailable. Check your network connection, or try Chrome or Edge — privacy browsers like Brave often block the built-in speech service.";

export function resolveSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function nextCountdownSecond(current: number): number | null {
  if (current <= 1) return null;
  return current - 1;
}

export function transcriptsFromResultEvent(event: SpeechRecognitionEventLike): {
  finalChunk: string;
  interim: string;
} {
  let finalChunk = "";
  let interim = "";
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    if (result === undefined) continue;
    const text = result[0]?.transcript ?? "";
    if (result.isFinal) finalChunk += text;
    else interim += text;
  }
  return { finalChunk, interim };
}

/**
 * Map Web Speech API error codes to user-facing copy.
 * Returns null for benign codes that should not surface as hard failures
 * (session abort, quiet pause with no speech).
 *
 * Chromium Web Speech uses Google's cloud endpoint. Privacy browsers often
 * expose the constructor but fail at start with `network` / `service-not-allowed`.
 * The same `network` code also fires when the device is offline.
 */
export function messageForSpeechRecognitionError(
  error: SpeechRecognitionErrorCode,
): string | null {
  if (error === "aborted" || error === "no-speech") return null;
  switch (error) {
    case "not-allowed":
      return "Microphone access was denied.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
    case "service-not-allowed":
      return SPEECH_SERVICE_UNAVAILABLE_MESSAGE;
    case "language-not-supported":
      return "Speech recognition does not support this language.";
    default:
      return "Voice input failed. Try again.";
  }
}

export interface UseComposerVoiceDictationOptions {
  enabled: boolean;
  disabled: boolean;
  /** True when the composer cannot accept a send (busy, sending, disabled). */
  sendBlocked: boolean;
  getDraft: () => string;
  setDraft: (value: string) => void;
  /** Commits the current draft the same way as the send button. */
  triggerSend: () => void;
  createRecognition?: () => SpeechRecognitionLike | null;
}

export interface ComposerVoiceDictation {
  supported: boolean;
  phase: ComposerVoicePhase;
  countdownSec: number | null;
  error: string | null;
  toggleListening: () => void;
  cancelVoice: () => void;
  onManualDraftEdit: (value: string) => void;
}

export function useComposerVoiceDictation(
  options: UseComposerVoiceDictationOptions,
): ComposerVoiceDictation {
  const {
    enabled,
    disabled,
    sendBlocked,
    getDraft,
    setDraft,
    triggerSend,
    createRecognition,
  } = options;

  const recognitionCtor = resolveSpeechRecognitionCtor();
  const supported =
    enabled && (recognitionCtor !== null || createRecognition !== undefined);

  const [phase, setPhase] = useState<ComposerVoicePhase>("off");
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const armedRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const utteranceAnchorRef = useRef("");
  const spokenFinalRef = useRef("");
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingAutoSendRef = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownSec(null);
  }, []);

  const applyTranscriptToDraft = useCallback(() => {
    const combined = `${utteranceAnchorRef.current}${spokenFinalRef.current}`;
    setDraft(combined);
  }, [setDraft]);

  const stopRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec === null) return;
    rec.onresult = null;
    rec.onspeechend = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const startRecognition = useCallback(() => {
    if (!supported || disabled) return;
    const factory =
      createRecognition ??
      (() => {
        if (recognitionCtor === null) return null;
        return new recognitionCtor();
      });
    const rec = factory();
    if (rec === null) {
      setError("Voice input is not available in this browser.");
      armedRef.current = false;
      setPhase("off");
      return;
    }

    stopRecognition();
    recognitionRef.current = rec;
    spokenFinalRef.current = "";
    utteranceAnchorRef.current = getDraft();
    setError(null);
    setPhase("listening");

    rec.continuous = true;
    rec.interimResults = true;
    rec.lang =
      typeof navigator !== "undefined" && navigator.language.length > 0
        ? navigator.language
        : "en-US";

    rec.onresult = (event) => {
      const { finalChunk, interim } = transcriptsFromResultEvent(event);
      if (finalChunk.length > 0) {
        spokenFinalRef.current += finalChunk;
      }
      const combined = `${utteranceAnchorRef.current}${spokenFinalRef.current}${interim}`;
      setDraft(combined);
      clearCountdownTimer();
      pendingAutoSendRef.current = false;
      if (phaseRef.current === "countdown") {
        setPhase("listening");
      }
    };

    rec.onspeechend = () => {
      if (!armedRef.current) return;
      spokenFinalRef.current = getDraft().slice(
        utteranceAnchorRef.current.length,
      );
      applyTranscriptToDraft();
      const trimmed =
        `${utteranceAnchorRef.current}${spokenFinalRef.current}`.trim();
      if (trimmed.length === 0) return;
      clearCountdownTimer();
      setPhase("countdown");
      setCountdownSec(VOICE_AUTO_SEND_DELAY_SEC);
      countdownTimerRef.current = setInterval(() => {
        setCountdownSec((prev) => {
          if (prev === null) return null;
          const next = nextCountdownSecond(prev);
          if (next === null) {
            if (countdownTimerRef.current !== null) {
              clearInterval(countdownTimerRef.current);
              countdownTimerRef.current = null;
            }
            pendingAutoSendRef.current = true;
            setPhase("sending");
            return null;
          }
          return next;
        });
      }, VOICE_COUNTDOWN_TICK_MS);
    };

    rec.onerror = (event) => {
      const message = messageForSpeechRecognitionError(event.error);
      if (message === null) return;
      // Fatal: clear armed so onend cannot restart a broken session, and
      // leave the phase off so the UI does not stick on "Listening…".
      armedRef.current = false;
      pendingAutoSendRef.current = false;
      clearCountdownTimer();
      stopRecognition();
      setError(message);
      setPhase("off");
    };

    rec.onend = () => {
      if (!armedRef.current || recognitionRef.current !== rec) return;
      try {
        rec.start();
      } catch {
        /* restart may fail if already starting */
      }
    };

    try {
      rec.start();
    } catch {
      setError("Could not start the microphone.");
      setPhase("off");
      armedRef.current = false;
    }
  }, [
    applyTranscriptToDraft,
    clearCountdownTimer,
    createRecognition,
    recognitionCtor,
    disabled,
    getDraft,
    setDraft,
    stopRecognition,
    supported,
  ]);

  const disarm = useCallback(() => {
    armedRef.current = false;
    pendingAutoSendRef.current = false;
    clearCountdownTimer();
    stopRecognition();
    setPhase("off");
  }, [clearCountdownTimer, stopRecognition]);

  const toggleListening = useCallback(() => {
    if (!supported || disabled) return;
    if (armedRef.current) {
      disarm();
      return;
    }
    armedRef.current = true;
    startRecognition();
  }, [disabled, disarm, startRecognition, supported]);

  const cancelVoice = useCallback(() => {
    if (!armedRef.current) return;
    pendingAutoSendRef.current = false;
    clearCountdownTimer();
    if (phaseRef.current === "countdown" || phaseRef.current === "sending") {
      setPhase("listening");
      spokenFinalRef.current = getDraft().slice(
        utteranceAnchorRef.current.length,
      );
      if (recognitionRef.current === null) {
        startRecognition();
      }
      return;
    }
    disarm();
  }, [clearCountdownTimer, disarm, getDraft, startRecognition]);

  const onManualDraftEdit = useCallback(
    (value: string) => {
      if (!armedRef.current) return;
      utteranceAnchorRef.current = value;
      spokenFinalRef.current = "";
      clearCountdownTimer();
      pendingAutoSendRef.current = false;
      if (phaseRef.current === "countdown" || phaseRef.current === "sending") {
        setPhase("listening");
      }
    },
    [clearCountdownTimer],
  );

  useEffect(() => {
    if (!enabled) disarm();
  }, [disarm, enabled]);

  useEffect(() => {
    if (phase !== "sending" || !pendingAutoSendRef.current) return;
    if (sendBlocked) return;
    const trimmed = getDraft().trim();
    pendingAutoSendRef.current = false;
    if (trimmed.length === 0) {
      setPhase(armedRef.current ? "listening" : "off");
      return;
    }
    triggerSend();
    utteranceAnchorRef.current = "";
    spokenFinalRef.current = "";
    setPhase(armedRef.current ? "listening" : "off");
    if (armedRef.current && recognitionRef.current === null) {
      startRecognition();
    }
  }, [getDraft, phase, sendBlocked, startRecognition, triggerSend]);

  useEffect(() => {
    return () => {
      disarm();
    };
  }, [disarm]);

  return {
    supported,
    phase,
    countdownSec,
    error,
    toggleListening,
    cancelVoice,
    onManualDraftEdit,
  };
}
