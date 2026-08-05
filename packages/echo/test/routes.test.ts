import { expect, test } from "bun:test";
import { createEchoRoutes } from "../src/index";

test("POST echoes the request body back verbatim", async () => {
  const routes = createEchoRoutes();
  const body = "hello, echo\nline two, unchanged";
  const response = await routes.request("/", { method: "POST", body });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(await response.text()).toBe(body);
});

test("POST with an empty body echoes an empty body", async () => {
  const routes = createEchoRoutes();
  const response = await routes.request("/", { method: "POST", body: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
});

test("non-POST methods are refused", async () => {
  const routes = createEchoRoutes();
  const response = await routes.request("/", { method: "GET" });
  expect(response.status).toBe(405);
});
