import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

export type UsageLimitWindow = {
  utilization: number | null;
  resetsAt: string | null;
};

export type ClaudeUsageLimits = {
  available: boolean;
  reason: string | null;
  subscriptionType: string | null;
  session: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
  fetchedAt: string;
};

// The server caches upstream for a minute, so polling faster only costs
// round trips. A finished run is the one moment the numbers reliably moved,
// which is why that path bypasses the cache instead of waiting for the tick.
const POLL_INTERVAL_MS = 60_000;
const POST_RUN_REFRESH_DELAY_MS = 1500;

/**
 * Tracks the Claude subscription rate-limit windows shown in the composer.
 * Polls while the tab is visible, pauses when it is hidden, and refreshes once
 * a run finishes so the bars move without the user waiting out a full tick.
 */
export function useClaudeUsageLimits(isRunActive: boolean): ClaudeUsageLimits | null {
  const [limits, setLimits] = useState<ClaudeUsageLimits | null>(null);
  const activeRef = useRef(true);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async ({ bypassCache = false } = {}) => {
    const requestId = ++requestIdRef.current;
    try {
      const response = await api.claudeUsageLimits({ bypassCache });
      if (!response.ok) {
        throw new Error(`Usage limits request failed (${response.status})`);
      }
      const payload = await response.json();
      if (activeRef.current && requestId === requestIdRef.current) {
        setLimits(payload?.data ?? null);
      }
    } catch {
      // A missing login or an unreachable endpoint simply leaves the bars
      // hidden; it is never worth interrupting the composer over.
      if (activeRef.current && requestId === requestIdRef.current) {
        setLimits(null);
      }
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void refresh();

    const tick = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);

    return () => {
      activeRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  const wasRunActive = useRef(isRunActive);
  useEffect(() => {
    const justFinished = wasRunActive.current && !isRunActive;
    wasRunActive.current = isRunActive;
    if (!justFinished) {
      return undefined;
    }

    // Usage lands upstream slightly after the run completes locally.
    const timer = window.setTimeout(() => {
      void refresh({ bypassCache: true });
    }, POST_RUN_REFRESH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [isRunActive, refresh]);

  return limits;
}
