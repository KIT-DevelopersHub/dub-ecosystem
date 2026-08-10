// OAuth callback landing (design 2-1). Session cookie is already set by
// auth-service on the 302; confirm via /me then return to the saved path.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";

export function AuthCallbackScreen({
  api,
  returnTo = "/",
  onResolved,
}: {
  api: ApiClient;
  returnTo?: string;
  onResolved?: (path: string) => void;
}): JSX.Element {
  const { data, isError } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.auth.me(),
    retry: false,
  });

  useEffect(() => {
    if (data) onResolved?.(returnTo);
    else if (isError) onResolved?.("/login");
  }, [data, isError, returnTo, onResolved]);

  return (
    <main data-testid="fe2-auth-callback" aria-busy={!data && !isError} className="fe2-center">
      <div className="fe2-center-inner">
        <span className="fe2-spin-row">
          <Spinner />
          サインインを完了しています…
        </span>
      </div>
    </main>
  );
}
