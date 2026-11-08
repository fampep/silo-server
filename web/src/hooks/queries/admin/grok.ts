import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  captureProfileRequestContext,
  isCapturedProfileAuthorityActive,
  StaleApiRequestContextError,
} from "@/api/client";
import { adminAuthorityScope } from "@/api/v2/adminAuthority";
import { v2 } from "@/api/v2/request";

const connectionKey = ["admin", "ai", "grok"] as const;

function scopedKey() {
  const context = captureProfileRequestContext();
  return [
    ...connectionKey,
    adminAuthorityScope(context),
    context?.profileTokenGeneration ?? 0,
  ] as const;
}

export function useGrokStatus(enabled = true) {
  const context = captureProfileRequestContext();
  return useQuery({
    queryKey: [...scopedKey(), "status"],
    enabled: enabled && context !== null,
    queryFn: () => {
      if (!context) throw new StaleApiRequestContextError();
      return v2("GET /api/v2/admin/ai/grok", { profileContext: context });
    },
    retry: false,
    staleTime: 0,
  });
}

export function useGrokModels(enabled: boolean) {
  const context = captureProfileRequestContext();
  return useQuery({
    queryKey: [...scopedKey(), "models"],
    enabled: enabled && context !== null,
    queryFn: () => {
      if (!context) throw new StaleApiRequestContextError();
      return v2("GET /api/v2/admin/ai/grok/models", { profileContext: context });
    },
    retry: false,
    staleTime: 60_000,
  });
}

function useGrokWrite<T>(
  request: (context: NonNullable<ReturnType<typeof captureProfileRequestContext>>) => Promise<T>,
) {
  const qc = useQueryClient();
  const context = captureProfileRequestContext();
  return useMutation({
    retry: false,
    mutationFn: async () => {
      if (!context || !isCapturedProfileAuthorityActive(context))
        throw new StaleApiRequestContextError();
      return request(context);
    },
    onSuccess: async () => {
      if (context && isCapturedProfileAuthorityActive(context)) {
        await qc.invalidateQueries({ queryKey: connectionKey });
      }
    },
  });
}

export function useStartGrokLogin() {
  return useGrokWrite((profileContext) =>
    v2("POST /api/v2/admin/ai/grok/login", { profileContext }),
  );
}

export function usePollGrokLogin() {
  return useGrokWrite((profileContext) =>
    v2("POST /api/v2/admin/ai/grok/login/poll", { profileContext }),
  );
}

export function useDisconnectGrok() {
  return useGrokWrite((profileContext) => v2("DELETE /api/v2/admin/ai/grok", { profileContext }));
}
