// Static-markup rendering of block parts through the timeline: every known
// block type routes through the registry to its read-only card, and unknown
// or malformed blocks land on the labeled fallback — never raw JSON.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { MessageItem } from "../src/api";
import { WorkbenchTimeline } from "../src/timeline";

function messageWithBlock(type: string, data: unknown): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "block", block: { type, data } }],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

describe("block rendering", () => {
  test("approve block renders framing with fixed disabled Approve/Not now", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("approve", {
          approvalId: "apv_fixture1",
          title: "Deploy staging",
          body: "Rolls out the ingest worker.",
        })}
      />,
    );
    expect(markup).toContain("Deploy staging");
    expect(markup).toContain("Rolls out the ingest worker.");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Not now");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("apv_fixture1");
  });

  test("steps block renders each step with its state", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("steps", {
          title: "Migration",
          steps: [
            { label: "Snapshot", state: "done", note: "2s" },
            { label: "Apply", state: "running" },
            { label: "Verify", state: "queued" },
          ],
        })}
      />,
    );
    expect(markup).toContain("Migration");
    expect(markup).toContain("Snapshot");
    expect(markup).toContain('data-state="done"');
    expect(markup).toContain('data-state="running"');
    expect(markup).toContain('data-state="queued"');
    expect(markup).toContain("2s");
  });

  test("metrics block renders tiles and proportional bars", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("metrics", {
          title: "Ingest health",
          metrics: [
            { label: "P95", value: "412ms", detail: "-8%", trend: "up" },
            { label: "Retries", value: "12", detail: "flat" },
          ],
          bars: [{ label: "us-east", percent: 64 }],
        })}
      />,
    );
    expect(markup).toContain("Ingest health");
    expect(markup).toContain("P95");
    expect(markup).toContain("412ms");
    expect(markup).toContain("-8%");
    expect(markup).toContain('data-trend="up"');
    expect(markup).not.toContain('data-trend="down"');
    expect(markup).toContain("us-east");
    expect(markup).toContain("width:64%");
    expect(markup).toContain("64%");
  });

  test("poll block renders disabled choice rows without tallies", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("poll", {
          pollId: "blk_poll1",
          title: "Ship day?",
          choices: [
            { id: "tue", label: "Tuesday" },
            { id: "thu", label: "Thursday" },
          ],
        })}
      />,
    );
    expect(markup).toContain("Ship day?");
    expect(markup).toContain("Tuesday");
    expect(markup).toContain("Thursday");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("%");
  });

  test("form block renders labeled disabled fields and a submit button", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("form", {
          formId: "blk_form1",
          title: "Release notes",
          fields: [
            { id: "name", label: "Name", input: "text", value: "v1.4" },
            { id: "notes", label: "Notes", input: "textarea", required: true },
            {
              id: "workbench",
              label: "Workbench",
              input: "select",
              options: ["stable", "beta"],
              value: "beta",
            },
            { id: "notify", label: "Notify", input: "checkbox", value: "true" },
          ],
          submitLabel: "Save",
        })}
      />,
    );
    expect(markup).toContain("Release notes");
    expect(markup).toContain("Name");
    expect(markup).toContain("v1.4");
    expect(markup).toContain("<textarea");
    expect(markup).toContain("<select");
    expect(markup).toContain("stable");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("Save");
    expect(markup).toContain("disabled");
  });

  test("form block falls back to the default submit label", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("form", {
          formId: "blk_form1",
          title: "T",
          fields: [{ id: "x", label: "X", input: "text" }],
        })}
      />,
    );
    expect(markup).toContain("Submit");
  });

  test("stream block shows a cursor while streaming and none when done", () => {
    const streaming = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("stream", {
          title: "Build log",
          text: "compiling modules",
          done: false,
        })}
      />,
    );
    expect(streaming).toContain("compiling modules");
    expect(streaming).toContain("chat-block-cursor");

    const done = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("stream", {
          title: "Build log",
          text: "build complete",
          done: true,
        })}
      />,
    );
    expect(done).toContain("build complete");
    expect(done).not.toContain("chat-block-cursor");
  });

  test("unknown block type renders the labeled fallback, not raw JSON", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("carousel", { secret: "payload" })}
      />,
    );
    expect(markup).toContain("Unsupported block");
    expect(markup).toContain("carousel");
    expect(markup).not.toContain("payload");
  });

  test("malformed data for a known type renders the fallback", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={messageWithBlock("metrics", { title: 42, metrics: "nope" })}
      />,
    );
    expect(markup).toContain("Unsupported block");
    expect(markup).not.toContain("nope");
  });
});
