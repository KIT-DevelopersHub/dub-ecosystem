// useBffHome (design 2-3, theme10 A7). BFF home tolerates partial upstream
// failure: a 200 with partialErrors[]. Each FE widget renders its own in-frame
// fallback via errorFor(source); the shell shows NO toast for partials.
import { useQuery } from "@tanstack/react-query";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";

type BffHomeResponse = gateway.BffHomeResponse;
type UpstreamPartialError = gateway.UpstreamPartialError;

export interface UseBffHomeResult {
  data: BffHomeResponse | undefined;
  isPending: boolean;
  errorFor(source: string): UpstreamPartialError | undefined;
  refetch(): void;
}

export function useBffHome(api: ApiClient): UseBffHomeResult {
  const query = useQuery({
    queryKey: queryKeys.bffHome,
    queryFn: () => api.bff.home(),
  });

  const errorFor = (source: string): UpstreamPartialError | undefined =>
    query.data?.partialErrors.find((e) => e.source === source);

  return {
    data: query.data,
    isPending: query.isPending,
    errorFor,
    refetch: () => {
      void query.refetch();
    },
  };
}
