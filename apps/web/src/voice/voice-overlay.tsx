// Voice mode: covers the thread, sends each final utterance as an ordinary
// message, and speaks the worker's replies. Browser speech only.
import "./voice-overlay.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { CorbitAvatar, avatarColorForPrincipal } from "@/chat/avatar";
import { Captions, Microphone, MicrophoneSlash, SpeakerHigh, X } from "@/lib/icons";
import type { WorkbenchMessage } from "@/chat/threads-api";
import { useSpeech } from "./use-speech";

// Replies are markdown; speech should not read the syntax aloud.
function spoken(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function VoiceOverlay({
  worker,
  messages,
  onSend,
  onEnd,
}: {
  readonly worker: { readonly id: string; readonly name: string } | undefined;
  readonly messages: readonly WorkbenchMessage[];
  readonly onSend: (text: string) => void;
  readonly onEnd: () => void;
}) {
  const [captions, setCaptions] = useState(true);
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const speech = useSpeech({
    onFinal: (text) => {
      setHeard(text);
      setReply("");
      onSend(text);
    },
  });
  const { start, speak, setMuted } = speech;

  // Only replies that arrive while voice is open get spoken.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(messages.map((message) => message.id));
  useEffect(() => {
    const fresh = messages.filter((m) => m.author === "other" && !seen.current?.has(m.id));
    for (const message of messages) seen.current?.add(message.id);
    if (fresh.length === 0) return;
    const text = spoken(fresh.map((m) => m.body).join("\n"));
    setReply(text);
    speak(text);
  }, [messages, speak]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onEnd();
      }
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        setMuted(!speech.muted);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onEnd, setMuted, speech.muted]);

  const name = worker?.name ?? "the worker";
  const blocked = speech.state === "unsupported" || speech.state === "denied";
  const stateLine = speech.muted
    ? "Muted"
    : speech.state === "speaking"
      ? `${name} is speaking`
      : "Listening…";
  const caption =
    speech.state === "speaking" ? reply : speech.interim !== "" ? speech.interim : heard;

  return (
    <div className="voice" role="dialog" aria-label="Voice mode">
      <div
        className="voice-orb"
        style={
          { "--lvl": speech.state === "speaking" ? 0.5 : speech.level.toFixed(2) } as CSSProperties
        }
      >
        <CorbitAvatar
          ariaLabel={name}
          size={56}
          color={avatarColorForPrincipal(worker?.id ?? name)}
        />
      </div>
      {blocked ? (
        <p className="voice-cap" role="alert">
          {speech.state === "unsupported"
            ? "Voice needs speech recognition, which this browser doesn't offer. Try Chrome, Edge, or Safari."
            : "Microphone access was blocked. Allow it in your browser's site settings, then try again."}
        </p>
      ) : (
        <>
          <div className="voice-state">
            {speech.muted ? (
              <MicrophoneSlash aria-hidden="true" />
            ) : speech.state === "speaking" ? (
              <SpeakerHigh aria-hidden="true" />
            ) : (
              <span className="voice-pulse" aria-hidden="true" />
            )}
            {stateLine}
          </div>
          <div
            className="voice-cap"
            aria-live="polite"
            style={{ visibility: captions ? "visible" : "hidden" }}
          >
            {caption === "" ? (
              <span className="voice-cap-hint">Say anything to {name}.</span>
            ) : (
              caption
            )}
          </div>
          <div className="voice-hint">Space to mute · Esc to end</div>
        </>
      )}
      <div className="voice-controls">
        <button
          type="button"
          className="voice-btn"
          aria-pressed={captions}
          aria-label="Captions"
          title="Captions"
          onClick={() => setCaptions((on) => !on)}
        >
          <Captions aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`voice-btn voice-mic${speech.muted ? " muted" : ""}`}
          aria-label={speech.muted ? "Unmute microphone" : "Mute microphone"}
          disabled={blocked}
          onClick={() => setMuted(!speech.muted)}
        >
          {speech.muted ? (
            <MicrophoneSlash aria-hidden="true" />
          ) : (
            <Microphone aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="voice-btn voice-end"
          aria-label="End voice"
          onClick={onEnd}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
