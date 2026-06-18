import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type } from 'arktype';
import { api, uploadForm } from '../lib/api';

const skillSchema = type({
  id: 'string',
  name: 'string',
  displayName: 'string|null',
  createdAt: 'string',
  updatedAt: 'string',
});

const skillsResponseSchema = type({ skills: skillSchema.array() });
const skillResponseSchema = type({ skill: skillSchema });

export type SkillLibraryItem = typeof skillSchema.infer;

const skillDetailFileSchema = type({
  path: 'string',
  'content?': 'string',
});

const skillDetailResponseSchema = type({
  skill: skillSchema,
  files: skillDetailFileSchema.array(),
});

export type SkillDetail = typeof skillDetailResponseSchema.infer;

export function useSkillLibrary(tenantId?: string | null) {
  return useQuery<SkillLibraryItem[]>({
    queryKey: ['skills', tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        'GET',
        `/skills${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`
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

export function useSkillDetail(assetId: string | null, tenantId?: string | null) {
  return useQuery<SkillDetail>({
    queryKey: ['skill', assetId, tenantId ?? null],
    queryFn: async () => {
      if (!assetId) throw new Error('Skill asset id is required');
      const raw = await api<unknown>(
        'GET',
        `/skills/${assetId}${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`
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
      files?: Array<{ file: File; path?: string }>;
    }) => {
      let raw: unknown;
      if (body.files && body.files.length > 0) {
        const form = new FormData();
        form.set('name', body.name);
        if (body.description) form.set('description', body.description);
        for (const item of body.files) {
          form.append('files', item.file);
          form.append('paths', item.path || item.file.webkitRelativePath || item.file.name);
        }
        raw = await uploadForm<unknown>('/skills', form, { tenantId: body.tenantId });
      } else {
        raw = await api<unknown>(
          'POST',
          `/skills${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ''}`,
          {
            name: body.name,
            description: body.description,
            text: body.text,
          }
        );
      }
      const parsed = skillResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected skill response: ${parsed.summary}`);
      }
      return parsed.skill;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['skills', variables.tenantId ?? null] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { assetId: string; tenantId?: string | null }) => {
      await api<unknown>(
        'DELETE',
        `/skills/${body.assetId}${body.tenantId ? `?tenantId=${encodeURIComponent(body.tenantId)}` : ''}`
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['skills', variables.tenantId ?? null] });
      queryClient.removeQueries({
        queryKey: ['skill', variables.assetId, variables.tenantId ?? null],
      });
    },
  });
}
