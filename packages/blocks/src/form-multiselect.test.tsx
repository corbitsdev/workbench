/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type } from "arktype";
import React from "react";

import { UIBlockView } from "./UIBlockView";
import { isUIBlock, type UIBlock, type UIResponse } from "./ui-block";

afterEach(() => {
  cleanup();
});

// A workflow-OWNED resume schema (CL-2715). The shared @workbench/blocks package
// never hardcodes a per-workflow payload shape; a workflow registers its own
// arktype schema at the /resume boundary (resume-payload-registry). This stands
// in for that schema to prove the emitted payload round-trips through a real
// boundary validator.
const IntakeConfigSchema = type({
  campaign: "string",
  audience: "'smb' | 'enterprise'",
  "budget?": "number",
  variants: type({ providerName: "string", model: "string" })
    .array()
    .atLeastLength(1),
});

const SelectionSchema = type("string[]").atLeastLength(1);

describe("form block", () => {
  const block: UIBlock = {
    kind: "form",
    prompt: "Configure the campaign.",
    signalName: "intake-config",
    fields: [
      { kind: "text", name: "campaign", label: "Campaign", required: true },
      {
        kind: "select",
        name: "audience",
        label: "Audience",
        required: true,
        options: [
          { value: "smb", label: "SMB" },
          { value: "enterprise", label: "Enterprise" },
        ],
      },
      { kind: "number", name: "budget", label: "Budget" },
      {
        kind: "group",
        name: "variants",
        label: "Variants",
        addLabel: "Add variant",
        min: 1,
        fields: [
          {
            kind: "text",
            name: "providerName",
            label: "Provider",
            required: true,
          },
          { kind: "text", name: "model", label: "Model", required: true },
        ],
      },
    ],
  };

  it("renders each typed field's label", () => {
    render(<UIBlockView block={block} />);
    // getByText throws if the label is absent, so the call IS the assertion.
    screen.getByText("Campaign");
    screen.getByText("Audience");
    screen.getByText("Budget");
    screen.getByText("Variants");
  });

  it("holds submit until required fields are filled, then emits a structured payload", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);

    const submit = screen.getByRole("button", { name: "Submit" });
    // Required campaign + audience + the group's provider/model are empty.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(received).toBeUndefined();

    fireEvent.change(screen.getByRole("textbox", { name: /Campaign/ }), {
      target: { value: "Q3 push" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Audience/ }), {
      target: { value: "enterprise" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Budget" }), {
      target: { value: "5000" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Provider/ }), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Model/ }), {
      target: { value: "gpt-4o" },
    });

    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(received).toEqual({
      blockKind: "form",
      value: "",
      signalName: "intake-config",
      payload: {
        campaign: "Q3 push",
        audience: "enterprise",
        budget: 5000,
        variants: [{ providerName: "openai", model: "gpt-4o" }],
      },
    });
  });

  it("emits a payload the workflow-owned boundary schema accepts", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Campaign/ }), {
      target: { value: "Q3 push" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Audience/ }), {
      target: { value: "smb" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Provider/ }), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Model/ }), {
      target: { value: "gpt-4o" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    const out = IntakeConfigSchema(received?.payload);
    expect(out instanceof type.errors).toBe(false);
  });

  it("emits a payload the boundary schema REJECTS when a required variant field is malformed", () => {
    // A malformed payload — audience outside the enum — is caught by the
    // workflow-owned schema, proving the boundary check can actually fail.
    const bad = {
      campaign: "Q3 push",
      audience: "consumers",
      variants: [{ providerName: "openai", model: "gpt-4o" }],
    };
    const out = IntakeConfigSchema(bad);
    expect(out instanceof type.errors).toBe(true);
  });

  it('drops empty optional fields from the payload instead of emitting "" (CL-2684)', () => {
    let received: UIResponse | undefined;
    const dropBlock: UIBlock = {
      kind: "form",
      signalName: "intake",
      fields: [
        { kind: "text", name: "deckTitle", label: "Title", required: true },
        { kind: "text", name: "audience", label: "Audience" },
        { kind: "textarea", name: "source", label: "Source" },
      ],
    };
    render(
      <UIBlockView
        block={dropBlock}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), {
      target: { value: "My deck" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    // Only the touched required field is present — the untouched optionals are
    // absent, not blank strings that would fire wasted downstream field-reads.
    expect(received?.payload).toEqual({ deckTitle: "My deck" });
  });

  it("supports a repeatable group — adding a row yields a two-row array payload", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Campaign/ }), {
      target: { value: "Q3 push" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Audience/ }), {
      target: { value: "smb" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));

    const providers = screen.getAllByRole("textbox", { name: /Provider/ });
    const models = screen.getAllByRole("textbox", { name: /Model/ });
    expect(providers.length).toBe(2);
    fireEvent.change(providers[0]!, { target: { value: "openai" } });
    fireEvent.change(models[0]!, { target: { value: "gpt-4o" } });
    fireEvent.change(providers[1]!, { target: { value: "anthropic" } });
    fireEvent.change(models[1]!, { target: { value: "claude-3.5" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(received?.payload).toEqual({
      campaign: "Q3 push",
      audience: "smb",
      variants: [
        { providerName: "openai", model: "gpt-4o" },
        { providerName: "anthropic", model: "claude-3.5" },
      ],
    });
  });

  it("holds submit until a required group row is fully filled", () => {
    render(<UIBlockView block={block} />);
    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.change(screen.getByRole("textbox", { name: /Campaign/ }), {
      target: { value: "Q3 push" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Audience/ }), {
      target: { value: "smb" },
    });
    // Provider filled but Model still empty → still held.
    fireEvent.change(screen.getByRole("textbox", { name: /Provider/ }), {
      target: { value: "openai" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("form block — multiSelect field", () => {
  const block: UIBlock = {
    kind: "form",
    signalName: "pick-channels",
    fields: [
      {
        kind: "multiSelect",
        name: "channels",
        label: "Channels",
        required: true,
        min: 2,
        options: [
          { value: "reddit", label: "Reddit" },
          { value: "seo", label: "SEO" },
          { value: "email", label: "Email" },
        ],
      },
    ],
  };

  it("holds submit until the field's min is met and emits a string[] value", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Reddit/ }));
    expect((submit as HTMLButtonElement).disabled).toBe(true); // 1 of min 2
    fireEvent.click(screen.getByRole("checkbox", { name: /SEO/ }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(received?.payload).toEqual({ channels: ["reddit", "seo"] });
  });
});

describe("multiSelect block", () => {
  const block: UIBlock = {
    kind: "multiSelect",
    prompt: "Pick the pain points to pursue.",
    signalName: "pain-points",
    min: 1,
    max: 2,
    options: [
      { id: "a", label: "Agent degradation", value: "agent-degradation" },
      { id: "b", label: "Slow onboarding", value: "slow-onboarding" },
      { id: "c", label: "Cost overruns", value: "cost-overruns" },
    ],
  };

  it("holds submit below min, enforces max, and emits an array payload", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    const submit = screen.getByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true); // 0 of min 1

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Agent degradation/ }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Slow onboarding/ }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    // At max (2) a third, unchecked option is disabled.
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Cost overruns/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(submit);
    expect(received).toEqual({
      blockKind: "multiSelect",
      value: "agent-degradation, slow-onboarding",
      signalName: "pain-points",
      payload: ["agent-degradation", "slow-onboarding"],
    });
  });

  it("emits an array the workflow-owned selection schema accepts", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Agent degradation/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    const out = SelectionSchema(received?.payload);
    expect(out instanceof type.errors).toBe(false);
    // An empty selection would be rejected by the same boundary schema.
    expect(SelectionSchema([]) instanceof type.errors).toBe(true);
  });
});

describe("number field NaN guard (CL-2684)", () => {
  const numberBlock: UIBlock = {
    kind: "form",
    signalName: "n",
    fields: [
      { kind: "text", name: "title", label: "Title", required: true },
      { kind: "number", name: "budget", label: "Budget" },
    ],
  };

  it("omits a non-numeric optional number from the payload instead of emitting NaN", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={numberBlock}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), {
      target: { value: "Deck" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Budget" }), {
      target: { value: "not a number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    // The garbage number never reaches the payload — no NaN key at all.
    expect(received?.payload).toEqual({ title: "Deck" });
  });

  it("holds submit when a REQUIRED number field is non-numeric", () => {
    const requiredNumber: UIBlock = {
      kind: "form",
      signalName: "n",
      fields: [
        { kind: "number", name: "budget", label: "Budget", required: true },
      ],
    };
    render(<UIBlockView block={requiredNumber} />);
    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Budget/ }), {
      target: { value: "abc" },
    });
    // NaN must not satisfy a required number — submit stays disabled.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("spinbutton", { name: /Budget/ }), {
      target: { value: "42" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("optimistic-submit failure keeps input (CL-2684)", () => {
  const block: UIBlock = {
    kind: "form",
    signalName: "intake",
    fields: [{ kind: "text", name: "title", label: "Title", required: true }],
  };

  it("shows a live 'Submitting…' state while the host resume is in flight", async () => {
    let resolve: (() => void) | undefined;
    const onRespond = () =>
      new Promise<void>((res) => {
        resolve = res;
      });
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), {
      target: { value: "Deck" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    // While awaiting, the button shows the pending label (not frozen on "Submit").
    await screen.findByText("Submitting…");
    resolve?.();
    // On success the form collapses to its submitted note.
    await screen.findByText("Submitted.");
  });

  it("keeps the form populated and surfaces an inline error when the resume fails", async () => {
    const onRespond = () =>
      Promise.reject(new Error("This run is no longer waiting for input."));
    render(<UIBlockView block={block} onRespond={onRespond} />);
    const input = screen.getByRole("textbox", {
      name: /Title/,
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Deck" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    // The failure is surfaced inline and the typed value is NOT lost.
    await screen.findByText("This run is no longer waiting for input.");
    expect(
      (screen.getByRole("textbox", { name: /Title/ }) as HTMLInputElement)
        .value,
    ).toBe("Deck");
    // The form did not collapse — it can be resubmitted.
    expect(screen.queryByText("Submitted.")).toBeNull();
  });

  it("keeps a choice block's buttons live after a failed resume", async () => {
    const onRespond = () => Promise.reject(new Error("stale gate"));
    const choice: UIBlock = {
      kind: "choice",
      prompt: "Approve?",
      signalName: "approve",
      options: [{ id: "yes", label: "Approve", value: "yes" }],
    };
    render(<UIBlockView block={choice} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("stale gate");
    // Not locked into "You chose:" — the button is still there to retry.
    expect(screen.queryByText(/You chose/)).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});

describe("isUIBlock guard — form + multiSelect", () => {
  it("accepts a well-formed form and multiSelect block", () => {
    expect(
      isUIBlock({
        kind: "form",
        fields: [{ kind: "text", name: "a" }],
      }),
    ).toBe(true);
    expect(
      isUIBlock({
        kind: "multiSelect",
        options: [{ id: "a", label: "A" }],
      }),
    ).toBe(true);
  });

  it("rejects a form with a field missing its name and a nested group", () => {
    expect(isUIBlock({ kind: "form", fields: [{ kind: "text" }] })).toBe(false);
    expect(
      isUIBlock({
        kind: "form",
        fields: [
          {
            kind: "group",
            name: "g",
            fields: [{ kind: "group", name: "inner", fields: [] }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a select field with no options and an empty multiSelect", () => {
    expect(
      isUIBlock({ kind: "form", fields: [{ kind: "select", name: "s" }] }),
    ).toBe(false);
    expect(isUIBlock({ kind: "multiSelect", options: [] })).toBe(false);
  });
});
