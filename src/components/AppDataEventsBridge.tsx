import { useEffect, useRef, useState } from "react";
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

const FALLBACK_VERSION_CHECK_MS = 60_000;
const ENABLE_APP_DATA_SSE = (() => {
  const raw = String(import.meta.env.VITE_ENABLE_APP_DATA_SSE || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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

  const handleNotice = (notice: ResourceVersionNotice) => {
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
  };

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
    let closed = false;
    const closeSource = () => {
      if (closed) {
        return;
      }
      closed = true;
      source.close();
    };

    source.onopen = () => {
      if (!closed) {
        setSseFailed(false);
      }
    };
    source.onerror = () => {
      setSseFailed(true);
      closeSource();
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
      closeSource();
    };
  }, [enabled, queryClient]);

  useEffect(() => {
    if (!enabled || !sseFailed || typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;
    const checkVersions = async () => {
      try {
        const payload = (await resourceVersionsAPI.get([...appDataResources])) as any;
        if (cancelled) {
          return;
        }
        const resources = payload && typeof payload === "object" ? payload.resources : null;
        if (!resources || typeof resources !== "object") {
          return;
        }
        Object.values(resources).forEach((row: any) => {
          const resource = String(row?.resource || "").trim();
          if (!isAppDataResource(resource)) {
            return;
          }
          const nextVersion = Number(row?.version || 0);
          const previousVersion = versionsRef.current.get(resource) || 0;
          if (nextVersion > previousVersion) {
            handleNotice({
              resource,
              version: nextVersion,
              updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : undefined,
            });
          } else if (nextVersion > 0 && previousVersion <= 0) {
            versionsRef.current.set(resource, nextVersion);
          }
        });
      } catch {
        // Stay quiet; ordinary query error states remain responsible for visible feedback.
      }
    };

    void checkVersions();
    const interval = window.setInterval(() => {
      void checkVersions();
    }, FALLBACK_VERSION_CHECK_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, sseFailed, queryClient]);

  return null;
}
