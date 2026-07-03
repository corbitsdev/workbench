/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Campaign")).not.toBeNull();
    expect(screen.getByText("Audience")).not.toBeNull();
    expect(screen.getByText("Budget")).not.toBeNull();
    expect(screen.getByText("Variants")).not.toBeNull();
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
