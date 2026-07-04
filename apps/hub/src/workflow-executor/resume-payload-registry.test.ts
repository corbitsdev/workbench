import { describe, expect, test } from "bun:test";
import { validateResumePayload } from "./resume-payload-registry";

describe("validateResumePayload", () => {
  test("passes through an unregistered workflow kind", () => {
    expect(
      validateResumePayload("some-other-workflow", "sync-approval", {
        anything: 1,
      }),
    ).toEqual({ ok: true });
  });

  test("passes through an unregistered signal on a registered kind", () => {
    // The review gate carries a multi-field draft-approval FORM the dock can't
    // collect — it is deferred to the run page (CL-2731), so its payload is not
    // boundary-validated here and passes through.
    expect(
      validateResumePayload("attio-task-agent", "review", {
        approvedPieces: [{ type: "cold-email", title: "x", content: "y" }],
      }),
    ).toEqual({ ok: true });
  });

  test("accepts a member-selection payload with an assignee", () => {
    expect(
      validateResumePayload("attio-task-agent", "member-selection", {
        assignee: "sawyer@abklabs.com",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a member-selection payload with no assignee", () => {
    // The dock choice block and the panel both POST `{ assignee }`; a hollow pick
    // must not reach the listTasks tool step (it would query with no assignee).
    const result = validateResumePayload(
      "attio-task-agent",
      "member-selection",
      {},
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a member-selection payload with an empty-string assignee", () => {
    // An empty string is a hollow pick — it passes a bare `string` type but must
    // not reach listTasks (which would query with no assignee). The `string > 0`
    // constraint rejects it at the boundary.
    const result = validateResumePayload(
      "attio-task-agent",
      "member-selection",
      { assignee: "" },
    );
    expect(result.ok).toBe(false);
  });

  test("accepts a task-selection payload with a taskId", () => {
    expect(
      validateResumePayload("attio-task-agent", "task-selection", {
        taskId: "task_1",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a task-selection payload with no taskId", () => {
    const result = validateResumePayload(
      "attio-task-agent",
      "task-selection",
      {},
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a task-selection payload with an empty-string taskId", () => {
    const result = validateResumePayload("attio-task-agent", "task-selection", {
      taskId: "",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a clarification payload with answers or an empty continue", () => {
    // `answers` is optional — an empty continue is a valid best-effort proceed.
    expect(
      validateResumePayload("attio-task-agent", "clarification", {}),
    ).toEqual({ ok: true });
    expect(
      validateResumePayload("attio-task-agent", "clarification", {
        answers: "The prospect is a Series B fintech.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a clarification payload with a non-string answers", () => {
    const result = validateResumePayload("attio-task-agent", "clarification", {
      answers: 42,
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a bare attio sync-approval skip payload", () => {
    expect(
      validateResumePayload("attio-task-agent", "sync-approval", {
        confirm: false,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects an attio sync-approval payload with a non-boolean confirm", () => {
    const result = validateResumePayload("attio-task-agent", "sync-approval", {
      confirm: "yes",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a fully-specified sync-approval confirm (locators + note)", () => {
    expect(
      validateResumePayload("attio-task-agent", "sync-approval", {
        confirm: true,
        taskId: "task_1",
        parentObject: "companies",
        parentRecordId: "rec_1",
        note: "Pilot kicked off.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a sync-approval confirm that is missing the write locators (CL-2684)", () => {
    // A confirm=true with no locators would fire attio_create_note against
    // nothing — the destructive write must not proceed on a hollow confirm.
    expect(
      validateResumePayload("attio-task-agent", "sync-approval", {
        confirm: true,
      }).ok,
    ).toBe(false);
  });

  test("rejects a sync-approval confirm with an empty note (CL-2684)", () => {
    expect(
      validateResumePayload("attio-task-agent", "sync-approval", {
        confirm: true,
        taskId: "task_1",
        parentObject: "companies",
        parentRecordId: "rec_1",
        note: "",
      }).ok,
    ).toBe(false);
  });

  test("rejects a free-text-only ab-compare-hitl decision (no ranking)", () => {
    // A blind winner-pick cannot be free text — it must carry a ranking.
    const result = validateResumePayload("ab-compare-hitl", "ab-decision", {
      instruction: "Variant 1 reads better to me.",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an ab-compare-hitl decision with an empty ranking", () => {
    const result = validateResumePayload("ab-compare-hitl", "ab-decision", {
      ranking: [],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a structured ab-compare-hitl decision with a ranked winner", () => {
    expect(
      validateResumePayload("ab-compare-hitl", "ab-decision", {
        ranking: [{ rank: 1, label: "Variant 2", rationale: "Punchier." }],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects an empty ab-compare-hitl config payload", () => {
    // The generic "Continue" affordance would POST `{ instruction: "" }`; the
    // config gate needs fully-specified variants + input.
    const result = validateResumePayload("ab-compare-hitl", "ab-config", {
      instruction: "",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts an ab-compare-hitl config payload with variants and input", () => {
    expect(
      validateResumePayload("ab-compare-hitl", "ab-config", {
        variants: [
          {
            label: "Variant 1",
            providerName: "openai",
            model: "gpt-4o",
            input: "Write a tagline.",
          },
          {
            label: "Variant 2",
            providerName: "anthropic",
            model: "claude-opus-4-8",
            input: "Write a tagline.",
          },
        ],
        input: "Write a tagline.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a degenerate 1-variant ab-config comparison (CL-2684)", () => {
    expect(
      validateResumePayload("ab-compare-hitl", "ab-config", {
        variants: [{ providerName: "openai", model: "gpt-4o" }],
        input: "Write a tagline.",
      }).ok,
    ).toBe(false);
  });

  test("accepts a dock config payload with no per-variant input (CL-2684)", () => {
    // The block-driven form omits the redundant per-variant input; the shared
    // top-level input is authoritative, so the per-variant copy is optional.
    expect(
      validateResumePayload("ab-compare-hitl", "ab-config", {
        variants: [
          { providerName: "openai-compatible", model: "kimi-k2.6" },
          { providerName: "anthropic", model: "claude-opus-4-8" },
        ],
        input: "Write a tagline for a GTM workbench.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects an ab-config variant missing its provider or model (CL-2684)", () => {
    expect(
      validateResumePayload("ab-compare-hitl", "ab-config", {
        variants: [{ providerName: "", model: "" }],
        input: "Write a tagline.",
      }).ok,
    ).toBe(false);
  });

  test("accepts a gamma intake with a title and template", () => {
    expect(
      validateResumePayload("gamma-presentation-creator", "intake", {
        deckTitle: "Security review deck",
        gammaId: "tmpl_1",
        text: "The brief.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a gamma intake with no title or no template (CL-2684)", () => {
    // The render step reads deckTitle + gammaId; a hollow intake would render a
    // titleless deck off no template, so the boundary rejects it.
    expect(
      validateResumePayload("gamma-presentation-creator", "intake", {
        deckTitle: "",
        gammaId: "tmpl_1",
      }).ok,
    ).toBe(false);
    expect(
      validateResumePayload("gamma-presentation-creator", "intake", {
        deckTitle: "A deck",
        gammaId: "",
      }).ok,
    ).toBe(false);
  });

  test("accepts a gamma preview approval on any round's gate", () => {
    for (const signal of ["preview-1", "preview-2", "preview-3"]) {
      expect(
        validateResumePayload("gamma-presentation-creator", signal, {
          approved: true,
        }),
      ).toEqual({ ok: true });
    }
  });

  test("accepts a gamma preview refine with feedback", () => {
    expect(
      validateResumePayload("gamma-presentation-creator", "preview-1", {
        approved: false,
        feedback: "Tighten the opening slide.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a gamma refine with no feedback (guidance-less re-roll)", () => {
    // A refine (`approved: false`) drives the next `generate-N` step; without a
    // note it would blind re-roll, so the boundary rejects it (CL-2730).
    expect(
      validateResumePayload("gamma-presentation-creator", "preview-1", {
        approved: false,
      }).ok,
    ).toBe(false);
  });

  test("rejects a gamma refine with an empty-string feedback", () => {
    expect(
      validateResumePayload("gamma-presentation-creator", "preview-2", {
        approved: false,
        feedback: "",
      }).ok,
    ).toBe(false);
  });

  test("rejects a hollow gamma preview payload with no decision", () => {
    // The generic free-text path would POST `{ instruction: "..." }`; the check
    // gate branches on `approved`, so a payload without it is not a decision.
    const result = validateResumePayload(
      "gamma-presentation-creator",
      "preview-1",
      { instruction: "looks fine" },
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a gamma preview payload with a non-boolean approved", () => {
    const result = validateResumePayload(
      "gamma-presentation-creator",
      "preview-2",
      { approved: "yes" },
    );
    expect(result.ok).toBe(false);
  });

  test("accepts a last30days intake payload with a topic (focus optional)", () => {
    // The block form emits `{ topic, focus }` verbatim (CL-2765); topic alone is
    // a valid submit — the server derives the query/window.
    expect(
      validateResumePayload("last30days-research", "intake", {
        topic: "AI coding agents",
        focus: "enterprise procurement risks",
      }),
    ).toEqual({ ok: true });
    expect(
      validateResumePayload("last30days-research", "intake", {
        topic: "AI coding agents",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a last30days intake payload with an empty topic", () => {
    // Every source query and the report title derive from the topic; a blank
    // topic would ground the whole scan on nothing, so it is rejected here.
    const result = validateResumePayload("last30days-research", "intake", {
      topic: "",
      focus: "some angle",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a reddit intake with an http(s) URL and optional hints", () => {
    expect(
      validateResumePayload("reddit-opportunity-scanner", "intake", {
        inputUrl: "https://example.com",
        brandName: "Acme",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a reddit intake with a non-URL inputUrl (CL-2769)", () => {
    // The scrape step fetches inputUrl; the panel enforced the http(s) shape
    // client-side, and the boundary enforces it for the block form too.
    expect(
      validateResumePayload("reddit-opportunity-scanner", "intake", {
        inputUrl: "not a url",
      }).ok,
    ).toBe(false);
  });

  test("accepts a reddit review payload with keywords, subreddits, and searches", () => {
    expect(
      validateResumePayload(
        "reddit-opportunity-scanner",
        "recommendation-review",
        {
          keywords: ["observability"],
          subreddits: ["devops"],
          searches: [{ subreddit: "devops", query: "otel pain" }],
        },
      ),
    ).toEqual({ ok: true });
  });

  test("rejects a reddit review payload with no searches (nothing to collect)", () => {
    expect(
      validateResumePayload(
        "reddit-opportunity-scanner",
        "recommendation-review",
        {
          keywords: ["observability"],
          subreddits: ["devops"],
          searches: [],
        },
      ).ok,
    ).toBe(false);
  });

  test("accepts a reddit selection payload with a titled, non-empty opportunity", () => {
    expect(
      validateResumePayload(
        "reddit-opportunity-scanner",
        "opportunity-selection",
        {
          selected: [{ title: "Alerting is broken", content: "# Brief" }],
        },
      ),
    ).toEqual({ ok: true });
  });

  test("rejects a reddit selection payload whose opportunity has empty content (CL-2769)", () => {
    // The persist map reads `content` into artifact_create; a blank content
    // would save an empty document, so the boundary rejects it.
    expect(
      validateResumePayload(
        "reddit-opportunity-scanner",
        "opportunity-selection",
        {
          selected: [{ title: "Alerting is broken", content: "" }],
        },
      ).ok,
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // pain-point-collateral (CL-2775) — the four migrated dock gates + the
  // panel-owned format-selection all validate here.
  // -------------------------------------------------------------------------
  test("accepts a pain-point note-selection with a noteId", () => {
    expect(
      validateResumePayload("pain-point-collateral", "note-selection", {
        noteId: "note_1",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a pain-point note-selection with an empty noteId", () => {
    // The fetch step reads steps.select.output into granola_get_note; an empty id
    // would fetch nothing, so the boundary rejects it.
    expect(
      validateResumePayload("pain-point-collateral", "note-selection", {
        noteId: "",
      }).ok,
    ).toBe(false);
  });

  test("accepts a pain-point context payload (optional, empty is valid)", () => {
    expect(
      validateResumePayload("pain-point-collateral", "context", {}),
    ).toEqual({ ok: true });
    expect(
      validateResumePayload("pain-point-collateral", "context", {
        context: "Focus on onboarding.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a pain-point context payload with a non-string context", () => {
    expect(
      validateResumePayload("pain-point-collateral", "context", {
        context: 42,
      }).ok,
    ).toBe(false);
  });

  test("accepts a pain-point selection with an array of ids", () => {
    expect(
      validateResumePayload("pain-point-collateral", "pain-point-selection", {
        selectedIds: ["pp1", "pp2"],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a pain-point selection missing selectedIds", () => {
    expect(
      validateResumePayload("pain-point-collateral", "pain-point-selection", {})
        .ok,
    ).toBe(false);
  });

  test("rejects a pain-point selection with an empty selectedIds (CL-2775)", () => {
    // The dock form's min:1 and the panel both require a pick; an empty selection
    // generates no collateral, so a hand-crafted empty POST is rejected here.
    expect(
      validateResumePayload("pain-point-collateral", "pain-point-selection", {
        selectedIds: [],
      }).ok,
    ).toBe(false);
  });

  test("accepts a pain-point format-selection with generation items", () => {
    expect(
      validateResumePayload("pain-point-collateral", "format-selection", {
        items: [
          {
            format: "email",
            painPointId: "pp1",
            painPointTitle: "Slow onboarding",
            painPointDetail: "Takes weeks.",
            severity: "high",
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a pain-point format item with no pain point id", () => {
    expect(
      validateResumePayload("pain-point-collateral", "format-selection", {
        items: [
          {
            format: "email",
            painPointId: "",
            painPointTitle: "x",
            painPointDetail: "y",
            severity: "high",
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("accepts a pain-point review with full approved pieces", () => {
    expect(
      validateResumePayload("pain-point-collateral", "review", {
        approvedPieces: [
          { format: "email", title: "Follow-up", content: "Hi Acme…" },
        ],
        decisions: [
          {
            format: "email",
            title: "Follow-up",
            content: "Hi Acme…",
            approved: true,
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a pain-point review approved piece with empty content (fidelity guard)", () => {
    // The persist argMap reads title/format/content off each approvedPieces
    // entry; an empty-content piece would persist a hollow artifact, so the
    // boundary rejects a display-fields-only (content-less) approval (CL-2775).
    expect(
      validateResumePayload("pain-point-collateral", "review", {
        approvedPieces: [{ format: "email", title: "Follow-up", content: "" }],
        decisions: [
          {
            format: "email",
            title: "Follow-up",
            content: "",
            approved: true,
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("accepts a pain-point review that approved nothing (empty arrays)", () => {
    expect(
      validateResumePayload("pain-point-collateral", "review", {
        approvedPieces: [],
        decisions: [],
      }),
    ).toEqual({ ok: true });
  });
});
