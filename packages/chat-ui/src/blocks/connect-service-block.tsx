// The generic service connect card (CL-6393) — `connect-github`'s
// first-run card generalized to every connector and MCP preset, in the
// same `BlockCard` frame. Pure and props-driven like
// `ConnectGithubBlockView`: the disconnected arm renders one of three
// affordances the host resolved (one-click OAuth, one-click keyless,
// key-paste), the connected arm is a plain confirmation, and
// `./connect-service-block-container.tsx` wires the callbacks to a live
// `ConnectServiceActions` port.

import { useState } from "react";
import { Button, Input } from "@corbits/react-ui";
import { Check } from "@corbits/icons";

import { CHAT_STRINGS } from "../strings";
import type {
  ConnectAffordance,
  ConnectServiceResult,
} from "./connect-service-actions";
import { BlockCard } from "./block-card";

export type ConnectServiceCardProps =
  | {
      readonly kind: "disconnected";
      readonly displayName: string;
      /** The agent's consumer-language framing for why connecting helps
       * ("Connect Gmail so I can send this for you."). */
      readonly reason: string;
      readonly affordance: ConnectAffordance;
      readonly docsUrl?: string;
      readonly onConnect: () => void;
      readonly onSubmitKey: (key: string) => Promise<ConnectServiceResult>;
    }
  | {
      readonly kind: "connected";
      readonly displayName: string;
    };

function KeyPasteBody({
  displayName,
  reason,
  docsUrl,
  onSubmitKey,
}: {
  readonly displayName: string;
  readonly reason: string;
  readonly docsUrl?: string;
  readonly onSubmitKey: (key: string) => Promise<ConnectServiceResult>;
}) {
  const [fieldOpen, setFieldOpen] = useState(false);
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit() {
    if (key.trim() === "" || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const result = await onSubmitKey(key.trim());
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setKey("");
    setFieldOpen(false);
  }

  if (!fieldOpen) {
    return (
      <>
        <p className="chat-block-text">{reason}</p>
        <div className="chat-block-actions">
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setFieldOpen(true);
            }}
          >
            {CHAT_STRINGS.blockConnectServiceAction(displayName)}
          </Button>
        </div>
        <p className="chat-block-text chat-block-connect-helper">
          {CHAT_STRINGS.blockConnectServiceKeyHelper(displayName)}
        </p>
      </>
    );
  }

  return (
    <>
      <p className="chat-block-text">{reason}</p>
      <label
        className="chat-block-text chat-block-connect-token-label"
        htmlFor="connect-service-key"
      >
        {CHAT_STRINGS.blockConnectServiceKeyFieldLabel(displayName)}
      </label>
      <Input
        id="connect-service-key"
        type="password"
        value={key}
        placeholder={CHAT_STRINGS.blockConnectServiceKeyFieldPlaceholder}
        onChange={(event) => {
          setKey(event.target.value);
        }}
        disabled={submitting}
      />
      {docsUrl !== undefined ? (
        <p className="chat-block-text chat-block-connect-helper">
          <a href={docsUrl} target="_blank" rel="noreferrer">
            {CHAT_STRINGS.blockConnectServiceKeyWhere(displayName)}
          </a>
        </p>
      ) : null}
      {error !== undefined ? (
        <p className="chat-block-text chat-block-connect-token-error">
          {error}
        </p>
      ) : null}
      <div className="chat-block-actions">
        <Button
          type="button"
          variant="primary"
          onClick={() => void submit()}
          disabled={submitting || key.trim() === ""}
        >
          {submitting
            ? CHAT_STRINGS.blockConnectServiceKeySubmitting
            : CHAT_STRINGS.blockConnectServiceKeySubmit}
        </Button>
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setFieldOpen(false);
            setKey("");
            setError(undefined);
          }}
        >
          {CHAT_STRINGS.blockConnectServiceKeyCancel}
        </Button>
      </div>
    </>
  );
}

function OneClickBody({
  displayName,
  reason,
  affordance,
  onConnect,
}: {
  readonly displayName: string;
  readonly reason: string;
  readonly affordance: "oauth" | "keyless";
  readonly onConnect: () => void;
}) {
  return (
    <>
      <p className="chat-block-text">{reason}</p>
      <div className="chat-block-actions">
        <Button type="button" variant="primary" onClick={onConnect}>
          {CHAT_STRINGS.blockConnectServiceAction(displayName)}
        </Button>
      </div>
      <p className="chat-block-text chat-block-connect-helper">
        {affordance === "oauth"
          ? CHAT_STRINGS.blockConnectServiceOAuthHelper(displayName)
          : CHAT_STRINGS.blockConnectServiceKeylessHelper}
      </p>
    </>
  );
}

export function ConnectServiceBlockView(props: ConnectServiceCardProps) {
  if (props.kind === "connected") {
    return (
      <BlockCard
        title={CHAT_STRINGS.blockConnectServiceHeadline(props.displayName)}
      >
        <p className="chat-block-connect-line">
          <span className="chat-block-connect-tick" aria-hidden="true">
            <Check />
          </span>
          {CHAT_STRINGS.blockConnectServiceConnected(props.displayName)}
        </p>
      </BlockCard>
    );
  }
  return (
    <BlockCard
      title={CHAT_STRINGS.blockConnectServiceHeadline(props.displayName)}
    >
      {props.affordance === "api-key" ? (
        <KeyPasteBody
          displayName={props.displayName}
          reason={props.reason}
          {...(props.docsUrl !== undefined ? { docsUrl: props.docsUrl } : {})}
          onSubmitKey={props.onSubmitKey}
        />
      ) : (
        <OneClickBody
          displayName={props.displayName}
          reason={props.reason}
          affordance={props.affordance}
          onConnect={props.onConnect}
        />
      )}
    </BlockCard>
  );
}
