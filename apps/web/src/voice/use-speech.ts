// Browser-only speech: SpeechRecognition for STT, speechSynthesis for TTS.
// Nothing leaves the browser except what the browser vendor's recognizer does.
import { reportError } from "@corbits/error-sink";
import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechState = "idle" | "listening" | "speaking" | "unsupported" | "denied";

type RecognitionResult = { readonly isFinal: boolean; readonly 0: { readonly transcript: string } };
type RecognitionEvent = {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
};
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function speechSupported(): boolean {
  return (
    typeof window !== "undefined" && recognitionCtor() !== undefined && "speechSynthesis" in window
  );
}

export function useSpeech({ onFinal }: { readonly onFinal: (text: string) => void }) {
  const [state, setState] = useState<SpeechState>(() =>
    speechSupported() ? "idle" : "unsupported",
  );
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [muted, setMutedState] = useState(false);

  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const recognition = useRef<Recognition | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const active = useRef(false);
  const mutedRef = useRef(false);
  const speaking = useRef(false);

  const listen = useCallback(() => {
    const rec = recognition.current;
    if (rec === null || !active.current || mutedRef.current || speaking.current) return;
    try {
      rec.start();
      setState("listening");
    } catch (cause) {
      // start() throws when a session is already running; that is the goal.
      reportError(cause, { operation: "voice_recognition_start" });
    }
  }, []);

  const start = useCallback(async () => {
    const Ctor = recognitionCtor();
    if (Ctor === undefined || !("speechSynthesis" in window)) {
      setState("unsupported");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      reportError(cause, { operation: "voice_microphone_access" });
      setState("denied");
      return;
    }
    active.current = true;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    rec.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result === undefined) continue;
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text !== "") onFinalRef.current(text);
        } else {
          pending += result[0].transcript;
        }
      }
      setInterim(pending);
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        active.current = false;
        setState("denied");
      }
    };
    // Chrome ends a continuous session on silence; keep it going.
    rec.onend = () => {
      setInterim("");
      listen();
    };
    recognition.current = rec;
    listen();
  }, [listen]);

  const stop = useCallback(() => {
    active.current = false;
    const rec = recognition.current;
    recognition.current = null;
    if (rec !== null) {
      rec.onend = null;
      rec.abort();
    }
    window.speechSynthesis.cancel();
    speaking.current = false;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setInterim("");
    setLevel(0);
    setState((prev) => (prev === "unsupported" || prev === "denied" ? prev : "idle"));
  }, []);

  const setMuted = useCallback(
    (next: boolean) => {
      mutedRef.current = next;
      setMutedState(next);
      stream.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      if (next) recognition.current?.abort();
      else listen();
    },
    [listen],
  );

  const speak = useCallback(
    (text: string) => {
      if (!active.current || text.trim() === "") return;
      speaking.current = true;
      recognition.current?.abort();
      setState("speaking");
      const utterance = new SpeechSynthesisUtterance(text);
      const done = () => {
        speaking.current = window.speechSynthesis.speaking;
        if (!speaking.current) listen();
      };
      utterance.onend = done;
      utterance.onerror = done;
      window.speechSynthesis.speak(utterance);
    },
    [listen],
  );

  // Mic level for the orb glow, 0..1.
  useEffect(() => {
    if (state === "idle" || state === "unsupported" || state === "denied") return;
    const current = stream.current;
    if (current === null) return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(current).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let last = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const next = Math.min(1, (peak / 128) * 2);
      if (Math.abs(next - last) > 0.03) {
        last = next;
        setLevel(next);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close();
    };
    // Rebuild only when the stream appears (idle -> active), not on listen/speak flips.
  }, [state === "idle" || state === "unsupported" || state === "denied"]);

  useEffect(() => stop, [stop]);

  return { state, interim, level, muted, start, stop, setMuted, speak };
}
