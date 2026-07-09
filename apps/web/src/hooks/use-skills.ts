import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { api, uploadForm } from "../lib/api";

const skillSchema = type({
  id: "string",
  name: "string",
  displayName: "string|null",
  createdAt: "string",
  updatedAt: "string",
  scope: "'private'|'tenant'",
  accessTenantId: "string",
  ownerUserId: "string|null",
  ownerName: "string|null",
});

const skillsResponseSchema = type({ skills: skillSchema.array() });
const skillResponseSchema = type({ skill: skillSchema });

export type SkillLibraryItem = typeof skillSchema.infer;
export type SkillAccessScope = SkillLibraryItem["scope"];

const shareTargetSchema = type({ tenantId: "string", name: "string" });
const shareTargetsResponseSchema = type({ targets: shareTargetSchema.array() });
export type SkillShareTarget = typeof shareTargetSchema.infer;

const skillVersionSchema = type({
  sha: "string",
  shortSha: "string",
  version: "number",
  message: "string",
  authorName: "string",
  createdAt: "string",
});
const skillVersionsResponseSchema = type({
  versions: skillVersionSchema.array(),
  total: "number",
});
export type SkillVersion = typeof skillVersionSchema.infer;
export type SkillVersionPage = typeof skillVersionsResponseSchema.infer;

export const SKILL_VERSION_PAGE_SIZE = 20;

const skillDetailFileSchema = type({
  path: "string",
  "content?": "string",
});

const skillDetailResponseSchema = type({
  skill: skillSchema,
  files: skillDetailFileSchema.array(),
});

export type SkillDetail = typeof skillDetailResponseSchema.infer;

export function useSkillLibrary(tenantId?: string | null) {
  return useQuery<SkillLibraryItem[]>({
    queryKey: ["skills", tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        `/skills${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`,
      );
      const parsed = skillsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected skills response: ${parsed.summary}`);
      }
      return parsed.skills;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSkillDetail(
  assetId: string | null,
  tenantId?: string | null,
) {
  return useQuery<SkillDetail>({
    queryKey: ["skill", assetId, tenantId ?? null],
    queryFn: async () => {
      if (!assetId) throw new Error("Skill asset id is required");
      const raw = await api<unknown>(
        "GET",
        `/skills/${assetId}${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`,
      );
      const parsed = skillDetailResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected skill response: ${parsed.summary}`);
      }
      return parsed;
    },
    enabled: Boolean(assetId),
    staleTime: 5 * 60_000,
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      tenantId?: string | null;
      name: string;
      description?: string | null;
      text?: string;
      files?: { file: File; path?: string }[];
      scope?: SkillAccessScope;
    }) => {
      let raw: unknown;
      if (body.files && body.files.length > 0) {
        const form = new FormData();
        form.set("name", body.name);
        if (body.description) form.set("description", body.description);
        if (body.scope) form.set("scope", body.scope);
        for (const item of body.files) {
          form.append("files", item.file);
          form.append(
            "paths",
            item.path || item.file.webkitRelativePath || item.file.name,
          );
        }
        raw = await uploadForm<unknown>("/skills", form, {
          tenantId: body.tenantId,
        });
      } else {
        raw = await api<unknown>(
          "POST",
          `/skills${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ""}`,
          {
            name: body.name,
            description: body.description,
            text: body.text,
            scope: body.scope,
          },
        );
      }
      const parsed = skillResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected skill response: ${parsed.summary}`);
      }
      return parsed.skill;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["skills", variables.tenantId ?? null],
      });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { assetId: string; tenantId?: string | null }) => {
      await api<unknown>(
        "DELETE",
        `/skills/${body.assetId}${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ""}`,
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["skills", variables.tenantId ?? null],
      });
      queryClient.removeQueries({
        queryKey: ["skill", variables.assetId, variables.tenantId ?? null],
      });
    },
  });
}

export function useSkillShareTargets(tenantId?: string | null) {
  return useQuery<SkillShareTarget[]>({
    queryKey: ["skill-share-targets", tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        `/skills/share-targets${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`,
      );
      const parsed = shareTargetsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected share targets response: ${parsed.summary}`);
      }
      return parsed.targets;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSkillVersions(
  assetId: string | null,
  tenantId?: string | null,
  limit: number = SKILL_VERSION_PAGE_SIZE,
) {
  return useQuery<SkillVersionPage>({
    queryKey: ["skill-versions", assetId, tenantId ?? null, limit],
    queryFn: async () => {
      if (!assetId) throw new Error("Skill asset id is required");
      const params = new URLSearchParams({ limit: String(limit) });
      if (tenantId) params.set("tenantId", tenantId);
      const raw = await api<unknown>(
        "GET",
        `/skills/${assetId}/versions?${params.toString()}`,
      );
      const parsed = skillVersionsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected skill versions response: ${parsed.summary}`,
        );
      }
      return parsed;
    },
    enabled: Boolean(assetId),
  });
}

export function useRestoreSkillVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      assetId: string;
      sha: string;
      tenantId?: string | null;
    }) => {
      const raw = await api<unknown>(
        "POST",
        `/skills/${body.assetId}/restore${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ""}`,
        { sha: body.sha },
      );
      const parsed = skillResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected skill response: ${parsed.summary}`);
      }
      return parsed.skill;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["skills", variables.tenantId ?? null],
      });
      queryClient.invalidateQueries({
        queryKey: ["skill", variables.assetId, variables.tenantId ?? null],
      });
      queryClient.invalidateQueries({
        queryKey: [
          "skill-versions",
          variables.assetId,
          variables.tenantId ?? null,
        ],
      });
    },
  });
}

const skillDraftSchema = type({
  id: "string",
  title: "string",
  content: "string",
  description: "string|null",
  existingSkillId: "string|null",
  status: "'draft'|'approved'|'rejected'",
  updatedAt: "string",
  createdAt: "string",
});
export type SkillDraftItem = typeof skillDraftSchema.infer;

const skillDraftsResponseSchema = type({ drafts: skillDraftSchema.array() });
const skillDraftResponseSchema = type({ draft: skillDraftSchema });
const approveDraftResponseSchema = type({
  skill: skillSchema,
  draftId: "string",
});

export function useSkillDrafts(tenantId?: string | null) {
  return useQuery<SkillDraftItem[]>({
    queryKey: ["skill-drafts", tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        `/skills/drafts${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`,
      );
      const parsed = skillDraftsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected skill drafts response: ${parsed.summary}`);
      }
      return parsed.drafts;
    },
    staleTime: 30_000,
  });
}

export function useApproveSkillDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      draftId: string;
      scope: SkillAccessScope;
      tenantId?: string | null;
    }) => {
      const raw = await api<unknown>(
        "POST",
        `/skills/drafts/${encodeURIComponent(body.draftId)}/approve${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ""}`,
        { scope: body.scope },
      );
      const parsed = approveDraftResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected approve response: ${parsed.summary}`);
      }
      return parsed;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["skill-drafts", variables.tenantId ?? null],
      });
      queryClient.invalidateQueries({
        queryKey: ["skills", variables.tenantId ?? null],
      });
    },
  });
}

export function useDiscardSkillDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { draftId: string; tenantId?: string | null }) => {
      const raw = await api<unknown>(
        "POST",
        `/skills/drafts/${encodeURIComponent(body.draftId)}/discard${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ""}`,
      );
      const parsed = skillDraftResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected discard response: ${parsed.summary}`);
      }
      return parsed.draft;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["skill-drafts", variables.tenantId ?? null],
      });
    },
  });
}
