// CL-6495: the create-workbench catch used to discard whatever
// `createWorkbenchFromTemplate` threw behind a fixed "try again" toast —
// honest for a transient failure, a lie for a precondition this bench
// doesn't meet (no setup agent, an unavailable template). These pin the
// wording `describeWorkbenchCreateFailure` picks for each shape of cause.
//
// The check is an allow-list (only `WorkbenchPreconditionError` is shown
// verbatim), not a denylist of `ApiQueryError` — a plain `Error` from
// anywhere else on the path (`listPluginsForTenant`, `instantiateWorkbenchTemplate`,
// or any future throw) must fall to the generic message rather than leak
// a raw request path or schema summary into the toast.

import { describe, expect, test } from "bun:test";
import { ApiQueryError } from "@corbits/api-query";
import { ChatApiError } from "@corbits/chat-ui";

import { describeWorkbenchCreateFailure } from "./new-workbench-picker";
import { WorkbenchPreconditionError } from "../instant-agent-create";

const GENERIC = "Something went wrong creating this workbench. Try again.";

describe("describeWorkbenchCreateFailure", () => {
  test("a WorkbenchPreconditionError (no setup agent, unavailable template) is shown verbatim", () => {
    expect(
      describeWorkbenchCreateFailure(
        new WorkbenchPreconditionError(
          "A code-review workbench isn't available here yet.",
          "template-unavailable",
        ),
      ),
    ).toBe("A code-review workbench isn't available here yet.");
  });

  test("a plain Error carrying internal detail is masked, not shown verbatim", () => {
    // The exact shape `listPluginsForTenant`/`instantiateWorkbenchTemplate`
    // throw: a message embedding a raw status code or schema summary.
    expect(
      describeWorkbenchCreateFailure(
        new Error(
          "Unexpected response shape resolving GitHub: must be an object",
        ),
      ),
    ).toBe(GENERIC);
  });

  test("an ApiQueryError runs through describeApiError so the status drives the wording", () => {
    expect(describeWorkbenchCreateFailure(new ApiQueryError("boom", 404))).toBe(
      "This isn't here anymore.",
    );
    expect(describeWorkbenchCreateFailure(new ApiQueryError("boom", 401))).toBe(
      "You don't have access to this.",
    );
  });

  test("an ApiQueryError never leaks its raw message (path, status text) into the toast", () => {
    expect(
      describeWorkbenchCreateFailure(
        new ApiQueryError(
          "The server answered 500.",
          500,
          "/api/tenants/tnt_1/template-blocks/code-review/deploy",
        ),
      ),
    ).not.toContain("/api/tenants");
  });

  test("a ChatApiError — createWorkbench, patchWorkbenchSettings, and the GitHub-connect steps all throw this — runs through describeChatError", () => {
    expect(describeWorkbenchCreateFailure(new ChatApiError("boom", 401))).toBe(
      "You're signed out. Sign in again to continue.",
    );
    expect(describeWorkbenchCreateFailure(new ChatApiError("boom", 403))).toBe(
      "You don't have access to this.",
    );
    expect(describeWorkbenchCreateFailure(new ChatApiError("boom", 500))).toBe(
      "Something went wrong on our end. Try again in a moment.",
    );
  });

  test("a ChatApiError never leaks its raw message (it always embeds the request path)", () => {
    expect(
      describeWorkbenchCreateFailure(
        new ChatApiError(
          "The server answered 500 for /api/tenants/tnt_1/chat/workbenches.",
          500,
        ),
      ),
    ).not.toContain("/api/tenants");
  });

  test("a non-Error cause falls back to the same generic, honest message", () => {
    expect(describeWorkbenchCreateFailure("boom")).toBe(GENERIC);
  });
});
