import { describe, expect, test } from "bun:test";
import {
  withCodexContentTypeRepair,
  CODEX_RESPONSES_PATH,
  type FetchLike,
} from "./index";

const url = `https://chatgpt.com/backend-api${CODEX_RESPONSES_PATH}`;

function fetchReturning(response: Response): FetchLike {
  return (_input, _init) => Promise.resolve(response);
}

// Guards the exact conditions the repair is allowed to act under: the
// backend's missing-content-type bug only shows up on 2xx SSE responses,
// and guessing wrong on an unrelated response would corrupt it.
describe("Codex content-type repair — missing content-type on 2xx SSE responses", () => {
  test("restores content-type from the accept header when the backend omits it on a 2xx response", async () => {
    const repaired = withCodexContentTypeRepair(
      fetchReturning(new Response("data: {}\n\n", { status: 200 })),
    );
    const response = await repaired(url, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  test("leaves declared content-type, non-2xx, ambiguous accept, and non-Codex URL responses untouched", async () => {
    const declared = withCodexContentTypeRepair(
      fetchReturning(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const declaredResponse = await declared(url, {
      headers: { accept: "text/event-stream" },
    });
    expect(declaredResponse.headers.get("content-type")).toBe(
      "application/json",
    );

    const non2xx = withCodexContentTypeRepair(
      fetchReturning(new Response("bad", { status: 400 })),
    );
    const non2xxResponse = await non2xx(url, {
      headers: { accept: "text/event-stream" },
    });
    expect(non2xxResponse.headers.get("content-type")).toBeNull();

    const ambiguous = withCodexContentTypeRepair(
      fetchReturning(new Response("x", { status: 200 })),
    );
    const ambiguousResponse = await ambiguous(url, {
      headers: { accept: "text/event-stream, application/json" },
    });
    expect(ambiguousResponse.headers.get("content-type")).toBeNull();

    const otherUrl = withCodexContentTypeRepair(
      fetchReturning(new Response("data: {}\n\n", { status: 200 })),
    );
    const otherUrlResponse = await otherUrl(
      "https://chatgpt.com/backend-api/other",
      {
        headers: { accept: "text/event-stream" },
      },
    );
    expect(otherUrlResponse.headers.get("content-type")).toBeNull();
  });
});
