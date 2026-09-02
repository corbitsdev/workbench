// The execution half of this package: how a running agent asks what this
// bench can reach for a kind of work. Mounted outside the tenant prefix at
// `/api/workflow-inference-catalog`, authenticated by sidecar bearer token
// and run address like every other workflow-run surface — a workflow child
// has no browser session. The tenant every read is scoped to comes from the
// authenticated run alone; identity never rides in a request body.
//
// Read-only throughout, so no grant gate: there is no write to guard.
//
// Takes ports, not a `db` handle, so the package stays decoupled from the
// catalog schema and the whole surface is testable with literals.
import { Hono } from "hono";
import { type } from "arktype";
import type { ModelPricingRow, ResolvedOffering } from "@intx/db";
import { Capability } from "@intx/types";
import { makeErrorEnvelope } from "@corbits/error-sink";

import { CONCEPTS } from "./concepts";
import { EMPTY_POLICY, type BenchModelPolicy } from "./policy";
import {
  resolveModelChain,
  UnknownConceptError,
  type ChainNeed,
  type ModelChain,
} from "./resolve-chain";

export type WorkflowCatalogRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowCatalogRunScope | null>;
};

export type WorkflowCatalogEnv = {
  Variables: { workflowCatalogScope: WorkflowCatalogRunScope };
};

export type CreateWorkflowCatalogRoutesDeps = {
  readonly authenticator: WorkflowRunAuthenticator;
  readonly listOfferings: (
    tenantId: string,
  ) => Promise<readonly ResolvedOffering[]>;
  readonly listPricing: (
    tenantId: string,
    offeringIds: readonly string[],
  ) => Promise<readonly ModelPricingRow[]>;
  readonly getPolicy: (tenantId: string) => Promise<BenchModelPolicy>;
  /** Overridable so a test pins the as-of instant rather than the clock. */
  readonly now?: () => Date;
};

const NeedBody = type({
  "concept?": "string > 0",
  "capabilities?": Capability.array(),
});

const ChainBody = NeedBody.and({
  "order?": "'cheapest'|'catalog'",
  "limit?": "1 <= number <= 10",
});

const EstimateBody = NeedBody.and({
  expectedInputTokens: "number >= 0",
  expectedOutputTokens: "number >= 0",
});

type NeedFields = { concept?: string; capabilities?: Capability[] };

function needFrom(fields: NeedFields): ChainNeed | Error {
  const hasConcept = fields.concept !== undefined;
  const hasCapabilities = fields.capabilities !== undefined;
  if (hasConcept === hasCapabilities) {
    return new Error(
      "ask for exactly one of `concept` (a kind of work) or `capabilities` (the wire features the work needs)",
    );
  }
  return fields.concept !== undefined
    ? { concept: fields.concept }
    : { capabilities: fields.capabilities ?? [] };
}

export function createWorkflowCatalogRoutes(
  deps: CreateWorkflowCatalogRoutesDeps,
): Hono<WorkflowCatalogEnv> {
  const app = new Hono<WorkflowCatalogEnv>();
  const now = deps.now ?? (() => new Date());

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("workflowCatalogScope", scope);
    await next();
  });

  async function chainFor(
    tenantId: string,
    need: ChainNeed,
    order: "cheapest" | "catalog" | undefined,
    limit: number | undefined,
  ): Promise<ModelChain> {
    const offerings = await deps.listOfferings(tenantId);
    const pricing = await deps.listPricing(
      tenantId,
      offerings.map((resolved) => resolved.offering.id),
    );
    const policy = await deps.getPolicy(tenantId);
    return resolveModelChain({
      need,
      offerings,
      pricing,
      policy,
      asOf: now(),
      order,
      limit,
    });
  }

  app.get("/concepts", async (c) => {
    const scope = c.get("workflowCatalogScope");
    const data = [];
    for (const concept of CONCEPTS) {
      const chain = await chainFor(
        scope.tenantId,
        { concept: concept.id },
        "cheapest",
        10,
      );
      const head = chain.entries[0];
      data.push({
        id: concept.id,
        title: concept.title,
        whenToUse: concept.whenToUse,
        availableModels: chain.entries.length,
        headProvider: head === undefined ? null : head.providerName,
      });
    }
    return c.json({ data }, 200);
  });

  app.post("/chain", async (c) => {
    const scope = c.get("workflowCatalogScope");
    const raw = await c.req.json().catch(() => undefined);
    const body = ChainBody(raw);
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid body: ${body.summary}`,
        }),
        400,
      );
    }
    const need = needFrom(body);
    if (need instanceof Error) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: need.message,
        }),
        400,
      );
    }
    try {
      const chain = await chainFor(
        scope.tenantId,
        need,
        body.order,
        body.limit,
      );
      return c.json(chainResponse(chain), 200);
    } catch (err) {
      if (err instanceof UnknownConceptError) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: err.message,
          }),
          400,
        );
      }
      throw err;
    }
  });

  app.post("/estimate", async (c) => {
    const scope = c.get("workflowCatalogScope");
    const raw = await c.req.json().catch(() => undefined);
    const body = EstimateBody(raw);
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid body: ${body.summary}`,
        }),
        400,
      );
    }
    const need = needFrom(body);
    if (need instanceof Error) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: need.message,
        }),
        400,
      );
    }
    try {
      const chain = await chainFor(scope.tenantId, need, "cheapest", 10);
      return c.json(
        {
          concept: chain.concept,
          estimates: chain.entries.map((entry) => ({
            canonicalName: entry.canonicalName,
            providerName: entry.providerName,
            known: entry.price.known,
            estimatedUsd: estimateUsd(
              entry.price.inputUsdPerMTok,
              entry.price.outputUsdPerMTok,
              body.expectedInputTokens,
              body.expectedOutputTokens,
            ),
          })),
        },
        200,
      );
    } catch (err) {
      if (err instanceof UnknownConceptError) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: err.message,
          }),
          400,
        );
      }
      throw err;
    }
  });

  return app;
}

/** Null whenever either axis is unpriced: half an estimate is not an
 * estimate, and a zero would read as free. */
export function estimateUsd(
  inputUsdPerMTok: number | null,
  outputUsdPerMTok: number | null,
  expectedInputTokens: number,
  expectedOutputTokens: number,
): number | null {
  if (inputUsdPerMTok === null || outputUsdPerMTok === null) return null;
  return (
    (inputUsdPerMTok * expectedInputTokens) / 1_000_000 +
    (outputUsdPerMTok * expectedOutputTokens) / 1_000_000
  );
}

function chainNote(chain: ModelChain): string | null {
  if (chain.entries.length === 0) return "nothing on this bench can do that";
  if (chain.entries.every((entry) => !entry.price.known)) {
    return "nothing on this bench is priced yet, so cheapest-first is ordered by catalog priority";
  }
  if (chain.entries.some((entry) => entry.overCeiling)) {
    return "some of these cost more than this bench's ceiling for that kind of work";
  }
  return null;
}

function chainResponse(chain: ModelChain) {
  return {
    concept: chain.concept,
    requiredCapabilities: chain.requiredCapabilities,
    entries: chain.entries.map((entry) => ({
      canonicalName: entry.canonicalName,
      displayName: entry.displayName,
      providerName: entry.providerName,
      plugin: entry.plugin,
      offeringId: entry.offeringId,
      capabilities: entry.capabilities,
      price: entry.price,
      referenceCostUsd: entry.referenceCostUsd,
      overCeiling: entry.overCeiling,
    })),
    note: chainNote(chain),
  };
}

export { EMPTY_POLICY };
