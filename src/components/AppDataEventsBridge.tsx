import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL, resourceVersionsAPI } from "../services/api";
import {
  appDataResources,
  isAppDataResource,
  queryPrefixesForResource,
  type AppDataResource,
} from "../lib/queryKeys";

type ResourceVersionNotice = {
  resource: string;
  version: number;
  updatedAt?: string;
};

const VERSION_CHECK_MS = 10_000;
const SSE_HEALTH_VERSION_CHECK_MS = 15_000;
const ENABLE_APP_DATA_SSE = (() => {
  const raw = String(import.meta.env.VITE_ENABLE_APP_DATA_SSE || "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
})();

const buildEventsUrl = () => {
  const params = new URLSearchParams({ resources: appDataResources.join(",") });
  return `${API_BASE_URL}/events?${params.toString()}`;
};

const dispatchResourceChanged = (notice: ResourceVersionNotice) => {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("trufusion:resource-changed", {
      detail: notice,
    }),
  );
};

export function AppDataEventsBridge({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const versionsRef = useRef<Map<string, number>>(new Map());
  const [sseFailed, setSseFailed] = useState(false);

  const handleNotice = useCallback((notice: ResourceVersionNotice) => {
    const resource = String(notice.resource || "").trim();
    if (!isAppDataResource(resource)) {
      return;
    }
    const nextVersion = Number(notice.version || 0);
    const previousVersion = versionsRef.current.get(resource) || 0;
    if (nextVersion > 0) {
      versionsRef.current.set(resource, Math.max(previousVersion, nextVersion));
    }

    for (const queryKey of queryPrefixesForResource[resource as AppDataResource] || []) {
      void queryClient.invalidateQueries({ queryKey });
    }
    dispatchResourceChanged({
      resource,
      version: nextVersion,
      updatedAt: notice.updatedAt,
    });
  }, [queryClient]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setSseFailed(false);
      return undefined;
    }
    if (!ENABLE_APP_DATA_SSE || typeof EventSource === "undefined") {
      setSseFailed(true);
      return undefined;
    }

    setSseFailed(false);
    const source = new EventSource(buildEventsUrl(), { withCredentials: true });
    source.onopen = () => {
      setSseFailed(false);
    };
    source.onerror = () => {
      setSseFailed(true);
    };

    const listeners = appDataResources.map((resource) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(event.data) as ResourceVersionNotice;
          handleNotice(parsed);
        } catch {
          // Ignore malformed event payloads; the fallback version check will recover.
        }
      };
      source.addEventListener(`${resource}.changed`, listener as EventListener);
      return { resource, listener };
    });

    return () => {
      listeners.forEach(({ resource, listener }) => {
        source.removeEventListener(`${resource}.changed`, listener as EventListener);
      });
      source.close();
    };
  }, [enabled, handleNotice]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;
    const checkVersions = async (options?: { force?: boolean }) => {
      if (
        !options?.force &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      try {
        const payload = (await resourceVersionsAPI.get([...appDataResources])) as any;
        if (cancelled) {
          return;
        }
        const resources = payload && typeof payload === "object" ? payload.resources : null;
        if (!resources || typeof resources !== "object") {
          return;
        }
        const seenResources = new Set<string>();
        Object.values(resources).forEach((row: any) => {
          const resource = String(row?.resource || "").trim();
          if (!isAppDataResource(resource)) {
            return;
          }
          seenResources.add(resource);
          const nextVersion = Number(row?.version || 0);
          const hasBaseline = versionsRef.current.has(resource);
          const previousVersion = versionsRef.current.get(resource) || 0;
          if (!hasBaseline) {
            if (nextVersion > 0) {
              versionsRef.current.set(resource, nextVersion);
            }
            return;
          }
          if (nextVersion > previousVersion) {
            handleNotice({
              resource,
              version: nextVersion,
              updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : undefined,
            });
          }
        });
        appDataResources.forEach((resource) => {
          if (!seenResources.has(resource) && !versionsRef.current.has(resource)) {
            versionsRef.current.set(resource, 0);
          }
        });
      } catch {
        // Stay quiet; ordinary query error states remain responsible for visible feedback.
      }
    };

    void checkVersions({ force: true });
    const intervalMs = sseFailed ? VERSION_CHECK_MS : SSE_HEALTH_VERSION_CHECK_MS;
    const interval = window.setInterval(() => {
      void checkVersions();
    }, intervalMs);
    const handleVisibilityChange = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void checkVersions({ force: true });
      }
    };
    window.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, [enabled, sseFailed, handleNotice]);

  return null;
}
