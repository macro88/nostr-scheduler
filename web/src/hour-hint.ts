import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

function hintText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("hint" in value)) return null;
  const hint = value.hint;
  return typeof hint === "string" && hint.length > 0 ? hint : null;
}

export function useHourHint(profileId: string, enabled = true): string | null {
  const query = useQuery({
    queryKey: ["hour-hint", profileId],
    queryFn: async () => hintText(await api<unknown>(`/api/performance?profileId=${profileId}`)),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? null;
}
