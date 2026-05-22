import { QueryClient } from "@tanstack/react-query";

const isNonRetryableApiError = (error: unknown) => {
  const status = typeof (error as any)?.status === "number" ? (error as any).status : null;
  const code = typeof (error as any)?.code === "string" ? (error as any).code : "";
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    code === "AUTH_REQUIRED" ||
    code === "FORBIDDEN"
  );
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        if (isNonRetryableApiError(error)) {
          return false;
        }
        return failureCount < 2;
      },
      retryDelay: (attemptIndex) => Math.min(30_000, 1000 * 2 ** attemptIndex),
    },
    mutations: {
      retry: false,
    },
  },
});

