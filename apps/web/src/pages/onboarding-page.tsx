// First-run wizard: provision the account's one workbench under a
// default name derived from the account, then add an inference
// credential. There is no naming step — CL-6089 collapsed the
// multi-bench model down to one workbench per account, so nothing is
// left to name. The heavy lifting — storing the key immediately (no
// probe gates this, CL-6123), seeding the bench, and deploying every
// default workflow — happens server-side in `@workbench/onboarding`;
// this page is the guided shell around it. The credential step is
// skipped entirely
// (straight to `navigate("/")`) only once this page has independently
// confirmed (`hasActiveCredential`, a cheap credentials read) that the
// bench actually has a working credential — a hub-owned key (env-key
// auto-plant, CL-6101, or the older ANTHROPIC_API_KEY path) for a fresh
// bench, or a real working credential for a returning member. The
// server's own `seeded: true` is not enough on its own to hard-skip on:
// for an existing member it means every default workflow has an active
// deployment, never that a credential was checked; for a freshly
// provisioned bench it means the seed run's validation trigger started a
// workflow run, never that the run actually succeeded against a real
// credential. Either shape with no confirmed credential falls through to
// the credential step, same as an unseeded bench.
//
// Once a credential is confirmed working, this page's job is done — it
// hands off to `/` (`HomeRoute`), which is where the guided
// first-workbench creation and the drafted agent's greeting actually
// happen (CL-6104): a brand-new account has no workbench yet, so `/`
// itself renders the describe-it screen rather than this wizard growing
// a third step.

import { Button, EmptyState, Input, ProviderMark } from "@corbits/react-ui";
import { Key, WarningCircle } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { OLLAMA_PLACEHOLDER_SECRET } from "@workbench/connections/credential-test";

import { useNavigate } from "../navigation";
import {
  completeSetup,
  CREDENTIAL_PROBE_FAILURE_MESSAGE,
  CREDENTIAL_PROVIDERS,
  hasActiveCredential,
  HUGGINGFACE_CONNECT_START_PATH,
  OPENROUTER_CONNECT_START_PATH,
  PRIMARY_CREDENTIAL_PROVIDERS,
  readHuggingFaceConnectReturn,
  readOpenRouterConnectReturn,
  SECONDARY_CREDENTIAL_PROVIDERS,
  submitCredential,
  triggerFirstLoginProvisioning,
} from "../onboarding";
import type { CredentialProvider, CredentialProviderCard } from "../onboarding";
import { OnboardingLayout } from "../onboarding/onboarding-layout";
import type { SessionUser } from "../session";

/** No naming step means provisioning always needs a name to send — this
 * derives one from the account so `/api/onboarding/provision` never gets
 * called bare. Prefers the account's display name; an account with no
 * usable name falls back to the email's local part. Editable later from
 * Settings, same as any other display name.
 *
 * This names the account's one root tenant — the container real
 * workbenches (each its own child tenant, CL-6089) live under, never a
 * workbench itself (CL-6368). "…'s workbench" mislabeled it as one;
 * every fresh account now mints under its own name instead ("team space"
 * / "workspace" stay off the table too — check:ui-vocabulary bans both as
 * synonyms the CL-6089 product collapse deliberately retired). */
function defaultTeamName(user: SessionUser): string {
  const source =
    user.name.trim().length > 0 ? user.name.trim() : user.email.split("@")[0];
  return `${source || "Your"}'s team`;
}

type WizardState =
  | { readonly phase: "provisioning" }
  | {
      readonly phase: "provisioning-error";
      readonly message: string;
      readonly refId?: string;
    }
  | {
      readonly phase: "credential";
      readonly error: string | null;
      readonly errorRefId?: string;
    }
  | { readonly phase: "submitting" }
  | { readonly phase: "finishing-setup" };

function ProviderCardButton({
  provider,
  selected,
  disabled,
  onSelect,
}: {
  readonly provider: CredentialProviderCard;
  readonly selected: CredentialProvider;
  readonly disabled: boolean;
  readonly onSelect: (provider: CredentialProvider) => void;
}) {
  return (
    <Button
      type="button"
      role="radio"
      title={provider.description}
      aria-checked={provider.id === selected}
      variant={provider.id === selected ? "primary" : "outline"}
      disabled={disabled}
      onClick={() => onSelect(provider.id)}
    >
      <ProviderMark provider={provider.id} size="sm" />
      {provider.label}
    </Button>
  );
}

function ProviderPicker({
  selected,
  onSelect,
  disabled,
}: {
  readonly selected: CredentialProvider;
  readonly onSelect: (provider: CredentialProvider) => void;
  readonly disabled: boolean;
}) {
  // The six providers most people reach for lead the row; the rest stay
  // fully functional but tucked behind "More providers" so the primary
  // choice never has to compete with a wall of cards. A secondary pick
  // (e.g. returning to the flow with Groq already selected) opens the
  // expander automatically rather than hiding the active choice.
  const secondaryHasSelection = SECONDARY_CREDENTIAL_PROVIDERS.some(
    (provider) => provider.id === selected,
  );
  return (
    <div
      role="radiogroup"
      aria-label="Inference provider"
      className="onboarding-provider-picker"
    >
      {PRIMARY_CREDENTIAL_PROVIDERS.map((provider) => (
        <ProviderCardButton
          key={provider.id}
          provider={provider}
          selected={selected}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
      <details
        className="onboarding-provider-more"
        open={secondaryHasSelection}
      >
        <summary className="onboarding-provider-more-trigger">
          More providers
        </summary>
        <div className="onboarding-provider-more-panel">
          {SECONDARY_CREDENTIAL_PROVIDERS.map((provider) => (
            <ProviderCardButton
              key={provider.id}
              provider={provider}
              selected={selected}
              disabled={disabled}
              onSelect={onSelect}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

/** Where the wizard starts: at the top, unless the URL carries a connect
 * round-trip's outcome (OpenRouter or Hugging Face) — a fresh connect
 * lands on the finishing-setup phase (the OAuth callback only stored
 * the key; this page's own follow-up call is what actually deploys the
 * default workflows and their preset routines), and a failed round trip lands on the
 * credential step with the failure spelled out. Either way, the mount
 * effect below re-checks the account's real state before trusting a
 * connect outcome carried in the URL — see its own comment. */
function initialWizardState(): WizardState {
  if (typeof window === "undefined") return { phase: "provisioning" };
  const returned =
    readOpenRouterConnectReturn(window.location.search) ??
    readHuggingFaceConnectReturn(window.location.search);
  if (returned === null) return { phase: "provisioning" };
  if (returned.kind === "connected") return { phase: "finishing-setup" };
  return { phase: "credential", error: returned.message };
}

export function OnboardingPage({ user }: { readonly user: SessionUser }) {
  const navigate = useNavigate();
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [provider, setProvider] = useState<CredentialProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  // Ollama's card collects a URL, not a key — its own field, defaulted
  // to its card's `urlDefaultValue` the moment that card is picked (see
  // `handleSelectProvider` below), so the field is never blank the
  // first time a person lands on it.
  const [urlValue, setUrlValue] = useState("");
  // True for a returning user whose workbench already exists but is
  // still missing a working credential (`existing-member` with
  // `seeded: false`) — the copy below tells them connecting one now
  // finishes setup, instead of the first-run pitch.
  const [resumingUnseeded, setResumingUnseeded] = useState(false);

  const runProvisioning = useCallback(
    (name: string) => {
      setState({ phase: "provisioning" });
      void triggerFirstLoginProvisioning(name).then(async (result) => {
        if (result.kind === "error") {
          setState(
            result.refId === undefined
              ? { phase: "provisioning-error", message: result.message }
              : {
                  phase: "provisioning-error",
                  message: result.message,
                  refId: result.refId,
                },
          );
        } else if (
          result.kind === "existing-member" &&
          result.seeded === true
        ) {
          // `seeded: true` only means every default workflow has an
          // active deployment — never that a credential was checked.
          // Confirm one independently (a cheap credentials read) before
          // handing off; no tenantId (should not happen alongside
          // seeded: true) falls through to the credential step too.
          // A probe that cannot complete stays on this setup step with
          // Retry (CL-6868) — never opens paste-a-key as if none exists.
          if (result.tenantId === undefined) {
            setResumingUnseeded(false);
            setState({ phase: "credential", error: null });
            return;
          }
          const probe = await hasActiveCredential(result.tenantId);
          if (probe.kind === "active") {
            navigate("/");
          } else if (probe.kind === "error") {
            setState({
              phase: "provisioning-error",
              message: CREDENTIAL_PROBE_FAILURE_MESSAGE,
            });
          } else {
            setResumingUnseeded(false);
            setState({ phase: "credential", error: null });
          }
        } else if (result.kind === "existing-member") {
          // `seeded === false` is the bench_unseeded condition: this
          // account's own workbench exists but never got a working
          // credential (no operator key configured, and none connected
          // yet). `undefined` (membership on some other tenant) also lands
          // here rather than handing off — there is nothing to skip ahead to.
          const unseeded = result.seeded === false;
          setResumingUnseeded(unseeded);
          setState({ phase: "credential", error: null });
        } else if (result.kind === "provisioned" && result.seeded) {
          // The seed run's validation trigger only proves a workflow run
          // started, never that it succeeded against a real credential.
          // Confirm one independently before handing off. Probe failure
          // stays here with Retry (CL-6868) — never paste-a-key as none.
          const probe = await hasActiveCredential(result.tenantId);
          if (probe.kind === "active") {
            setResumingUnseeded(false);
            navigate("/");
          } else if (probe.kind === "error") {
            setState({
              phase: "provisioning-error",
              message: CREDENTIAL_PROBE_FAILURE_MESSAGE,
            });
          } else {
            setResumingUnseeded(false);
            setState({ phase: "credential", error: null });
          }
        } else if (result.kind === "provisioned") {
          setResumingUnseeded(false);
          setState({ phase: "credential", error: null });
        } else {
          // needs-onboarding after an explicit name should not happen — a
          // default name is always sent — so this reads as a soft error.
          setState({
            phase: "provisioning-error",
            message: "Setup couldn't create your workbench. Try again.",
          });
        }
      });
    },
    [navigate],
  );

  // A connect round-trip's outcome is consumed into the initial wizard
  // state above; dropping it from the URL keeps a reload or a shared
  // link from replaying a stale ending.
  useEffect(() => {
    if (
      readOpenRouterConnectReturn(window.location.search) !== null ||
      readHuggingFaceConnectReturn(window.location.search) !== null
    ) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Two jobs, split by what landed the wizard here. A fresh connect
  // (`finishing-setup`) actually finishes the job the OAuth callback
  // deferred: `completeSetup` runs the workflow deploy the callback
  // never ran inline. Everything else — the ordinary first-run landing,
  // or a stale connect error from a duplicate callback this page never
  // saw resolved — provisions with a default name derived from the
  // account: there is no naming step to gate this on, so it must always
  // send a name (see `defaultTeamName`). A returning member's
  // already-provisioned workbench is unaffected — the hub route only
  // creates one the first time an account has none.
  useEffect(() => {
    if (state.phase === "finishing-setup") {
      void completeSetup().then((outcome) => {
        if (outcome.kind === "connected") {
          navigate("/");
        } else if (outcome.kind === "unseeded") {
          setResumingUnseeded(true);
          setState({ phase: "credential", error: null });
        } else {
          setState(
            outcome.refId === undefined
              ? { phase: "credential", error: outcome.message }
              : {
                  phase: "credential",
                  error: outcome.message,
                  errorRefId: outcome.refId,
                },
          );
        }
      });
      return;
    }
    runProvisioning(defaultTeamName(user));
    // Mount-only: this reads `state.phase` exactly once, at the value
    // `initialWizardState` produced, to decide which of the two checks
    // above applies to this landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeProvider = CREDENTIAL_PROVIDERS.find((p) => p.id === provider);
  const isUrlProvider = activeProvider?.fieldKind === "url";

  const handleSelectProvider = useCallback(
    (nextId: CredentialProvider) => {
      setProvider(nextId);
      const nextCard = CREDENTIAL_PROVIDERS.find((p) => p.id === nextId);
      if (nextCard?.fieldKind === "url" && urlValue === "") {
        setUrlValue(nextCard.urlDefaultValue ?? "");
      }
    },
    [urlValue],
  );

  // Not every account has a provider ready the moment they land here — an
  // Ollama instance that is not running yet is the exact case this build
  // exists for. Provisioning already treats that as an anticipated state
  // (`bench_unseeded`, not an error), so the wizard should not be the one
  // hard-blocking control: skipping just hands off to `/` the same way a
  // confirmed credential does, and the no-usable-model banner there (CL-6568)
  // is what tells them, honestly, that a connection still needs finishing —
  // this screen does not need to be the only place that can say so.
  const handleSkip = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const handleSubmitCredential = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setState({ phase: "submitting" });
      const submission = isUrlProvider
        ? submitCredential(provider, OLLAMA_PLACEHOLDER_SECRET, urlValue)
        : submitCredential(provider, apiKey);
      void submission.then((outcome) => {
        // Connected is the finish line for this screen (CL-6457):
        // whether or not the agents have finished deploying, the person
        // moves on now, and the warm loading state on the other side
        // covers whatever is still coming online.
        if (outcome.kind === "connected") {
          navigate("/");
        } else {
          setState(
            outcome.refId === undefined
              ? { phase: "credential", error: outcome.message }
              : {
                  phase: "credential",
                  error: outcome.message,
                  errorRefId: outcome.refId,
                },
          );
        }
      });
    },
    [provider, apiKey, urlValue, isUrlProvider, navigate],
  );

  if (state.phase === "provisioning") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase" key="provisioning">
          <h1 className="onboarding-title">Preparing your account</h1>
          <p className="onboarding-subtitle">One moment.</p>
          <div className="onboarding-content">
            <WorkbenchLoadingState
              delayMs={0}
              title="Preparing your account…"
            />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "finishing-setup") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase" key="finishing-setup">
          <h1 className="onboarding-title">Preparing your agent</h1>
          <p className="onboarding-subtitle">
            Hooking up your agents. This takes about ten seconds.
          </p>
          <div className="onboarding-content">
            <WorkbenchLoadingState delayMs={0} title="Preparing your agent…" />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "provisioning-error") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase" key="provisioning-error">
          <div className="onboarding-content">
            <EmptyState
              icon={<WarningCircle />}
              title="Couldn't set up your workbench"
              description={
                state.refId === undefined ? (
                  state.message
                ) : (
                  <>
                    {state.message}
                    <br />
                    <span className="onboarding-error-refid">
                      If you tell us about this, mention {state.refId}.
                    </span>
                  </>
                )
              }
              action={
                <Button
                  variant="outline"
                  onClick={() => runProvisioning(defaultTeamName(user))}
                >
                  Try again
                </Button>
              }
            />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  const submitting = state.phase === "submitting";
  const error = state.phase === "credential" ? state.error : null;
  const errorRefId =
    state.phase === "credential" ? state.errorRefId : undefined;

  return (
    <OnboardingLayout>
      <div
        className="onboarding-phase onboarding-phase--credential"
        key={resumingUnseeded ? "resuming" : "credential"}
      >
        <h1 className="onboarding-title">
          {resumingUnseeded
            ? "Finish setting up your workbench"
            : "Bring your own AI"}
        </h1>
        <p className="onboarding-subtitle">
          {resumingUnseeded
            ? "Connect a provider below to finish setup."
            : "Connect in one click, or paste a key you already have. Your key stays yours — Workbench only uses it to run your agents, and you can pull it any time."}
        </p>
        <div className="onboarding-content">
          <div className="onboarding-connect-row">
            <section
              className="onboarding-connect-card"
              aria-label="Connect with OpenRouter"
            >
              <ProviderMark provider="openrouter" size="sm" />
              <div className="onboarding-connect-card-text">
                <h2>OpenRouter</h2>
                <p>One click, ~50 models, pay-as-you-go.</p>
              </div>
              <Button asChild>
                <a href={OPENROUTER_CONNECT_START_PATH}>Connect</a>
              </Button>
            </section>
            <section
              className="onboarding-connect-card"
              aria-label="Sign in with Hugging Face"
            >
              <ProviderMark provider="huggingface" size="sm" />
              <div className="onboarding-connect-card-text">
                <h2>Hugging Face</h2>
                <p>Groq, Together, Fireworks &amp; more, one sign-in.</p>
              </div>
              <Button asChild>
                <a href={HUGGINGFACE_CONNECT_START_PATH}>Connect</a>
              </Button>
            </section>
          </div>
          <div className="onboarding-connect-divider" role="separator">
            or paste a provider API key
          </div>
          <form
            onSubmit={handleSubmitCredential}
            className="onboarding-credential-form"
          >
            <ProviderPicker
              selected={provider}
              onSelect={handleSelectProvider}
              disabled={submitting}
            />
            {activeProvider !== undefined && (
              <p className="onboarding-provider-description">
                {activeProvider.description}
              </p>
            )}
            {isUrlProvider ? (
              <>
                <label htmlFor="onboarding-provider-url">
                  {activeProvider?.label} URL
                </label>
                <Input
                  id="onboarding-provider-url"
                  type="text"
                  placeholder={activeProvider?.urlDefaultValue}
                  value={urlValue}
                  onChange={(event) => setUrlValue(event.target.value)}
                  required
                  disabled={submitting}
                  aria-describedby="onboarding-provider-url-help"
                />
                <p id="onboarding-provider-url-help">
                  The origin your Ollama instance listens on — local, or reached
                  through a tunnel.
                </p>
              </>
            ) : (
              <>
                <label htmlFor="onboarding-api-key">
                  {activeProvider?.label} API key
                </label>
                <Input
                  id="onboarding-api-key"
                  type="text"
                  placeholder={
                    activeProvider?.keyHint
                      ? `${activeProvider.keyHint}...`
                      : "Paste your key"
                  }
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  required
                  disabled={submitting}
                  aria-describedby="onboarding-api-key-help"
                />
                <p id="onboarding-api-key-help">
                  <a
                    href={activeProvider?.keyConsoleUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get a key from the {activeProvider?.label} console
                  </a>
                  {activeProvider?.keyHint ? (
                    <>
                      {" "}
                      — it starts with <code>{activeProvider.keyHint}</code>.
                    </>
                  ) : (
                    "."
                  )}
                </p>
              </>
            )}
            {error !== null && (
              <EmptyState
                icon={<Key />}
                title="That key didn't work"
                description={
                  errorRefId === undefined ? (
                    error
                  ) : (
                    <>
                      {error}
                      <br />
                      <span className="onboarding-error-refid">
                        Reference: {errorRefId}
                      </span>
                    </>
                  )
                }
              />
            )}
            <Button
              type="submit"
              disabled={
                submitting ||
                (isUrlProvider ? urlValue.length === 0 : apiKey.length === 0)
              }
            >
              {submitting
                ? "Connecting…"
                : isUrlProvider
                  ? "Connect this address"
                  : "Connect this key"}
            </Button>
          </form>
          <div className="onboarding-credential-skip">
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={submitting}
              onClick={handleSkip}
            >
              Skip for now
            </Button>
            <p className="onboarding-credential-skip-hint">
              No provider ready yet? You can connect one anytime from Settings →
              AI providers.
            </p>
          </div>
        </div>
      </div>
    </OnboardingLayout>
  );
}
