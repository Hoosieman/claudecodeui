import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Claude Code reports subscription rate limits from `GET /api/oauth/usage`, the
 * same endpoint behind its `/usage` screen. Windows arrive at the top level of
 * the response, keyed by the names Claude Code labels "session limit"
 * (`five_hour`) and "weekly limit" (`seven_day`). Claude Code itself re-nests
 * them under `rate_limits` internally, so the parser accepts either envelope.
 */
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const REQUEST_TIMEOUT_MS = 5000;

// The windows move slowly and the composer polls on a timer, so a short cache
// keeps a busy UI from turning every render into an upstream request.
const SUCCESS_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 15_000;

export type UsageLimitWindow = {
  /** Percentage of the window consumed, 0-100. Null when upstream omits it. */
  utilization: number | null;
  /** ISO timestamp for when the window rolls over, when upstream reports one. */
  resetsAt: string | null;
};

export type ClaudeUsageLimits = {
  available: boolean;
  /** Populated only when `available` is false, to explain the empty bars. */
  reason: string | null;
  subscriptionType: string | null;
  session: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
  fetchedAt: string;
};

type CachedUsageLimits = {
  value: ClaudeUsageLimits;
  expiresAt: number;
};

type ClaudeUsageLimitsServiceDependencies = {
  getHomeDirectory: () => string;
  readTextFile: (filePath: string) => Promise<string>;
  readKeychainCredentials: () => string | null;
  getEnvironment: () => NodeJS.ProcessEnv;
  fetchUsage: (accessToken: string) => Promise<unknown>;
  now: () => number;
};

const unavailable = (reason: string, now: number): ClaudeUsageLimits => ({
  available: false,
  reason,
  subscriptionType: null,
  session: null,
  weekly: null,
  fetchedAt: new Date(now).toISOString(),
});

/**
 * On macOS the OAuth credentials live in the login keychain rather than
 * `~/.claude/.credentials.json`, so the file read alone finds nothing for a
 * perfectly healthy login.
 */
const readMacosKeychainCredentials = (): string | null => {
  if (process.platform !== 'darwin') {
    return null;
  }

  const result = spawn.sync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
    encoding: 'utf8',
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }

  return result.stdout.trim() || null;
};

const requestUsage = async (accessToken: string): Promise<unknown> => {
  const response = await fetch(USAGE_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`usage request failed with ${response.status}`);
  }

  return response.json();
};

const defaultDependencies: ClaudeUsageLimitsServiceDependencies = {
  getHomeDirectory: () => os.homedir(),
  readTextFile: (filePath) => readFile(filePath, 'utf8'),
  readKeychainCredentials: readMacosKeychainCredentials,
  getEnvironment: () => process.env,
  fetchUsage: requestUsage,
  now: () => Date.now(),
};

const readUtilization = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(100, Math.max(0, parsed));
};

/**
 * `resets_at` arrives as an ISO string on this endpoint, but the same field is
 * epoch seconds on the rate-limit response headers. Accept both so a shape
 * change upstream degrades to a missing reset time instead of a broken bar.
 */
const readResetsAt = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  const raw = readOptionalString(value);
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const readWindow = (value: unknown): UsageLimitWindow | null => {
  const record = readObjectRecord(value);
  if (!record) {
    return null;
  }

  return {
    utilization: readUtilization(record.utilization),
    resetsAt: readResetsAt(record.resets_at),
  };
};

/**
 * Builds the Claude usage-limits service. The provider test suite injects its
 * own credential and fetch dependencies so no test touches a real login.
 */
export function createClaudeUsageLimitsService(
  dependencyOverrides: Partial<ClaudeUsageLimitsServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  let cache: CachedUsageLimits | null = null;

  /**
   * Resolves the OAuth access token in the order Claude Code itself uses. An
   * API-key login has no subscription windows to report, so it resolves to no
   * token rather than a failing request.
   */
  const resolveAccessToken = async (): Promise<{ token: string | null; reason: string | null }> => {
    const environment = dependencies.getEnvironment();
    const environmentToken = environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (environmentToken) {
      return { token: environmentToken, reason: null };
    }

    let credentialsRaw: string | null = null;
    try {
      credentialsRaw = await dependencies.readTextFile(
        path.join(dependencies.getHomeDirectory(), '.claude', '.credentials.json'),
      );
    } catch {
      credentialsRaw = dependencies.readKeychainCredentials();
    }

    if (!credentialsRaw) {
      return { token: null, reason: 'not-authenticated' };
    }

    let oauth: Record<string, unknown> | null = null;
    try {
      oauth = readObjectRecord(readObjectRecord(JSON.parse(credentialsRaw))?.claudeAiOauth);
    } catch {
      return { token: null, reason: 'unreadable-credentials' };
    }

    const accessToken = readOptionalString(oauth?.accessToken);
    if (!accessToken) {
      return { token: null, reason: 'not-authenticated' };
    }

    // Claude Code refreshes this on every run; a stale token would only earn a
    // 401, so report the expiry directly instead of spending the request.
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;
    if (expiresAt !== null && dependencies.now() >= expiresAt) {
      return { token: null, reason: 'login-expired' };
    }

    return { token: accessToken, reason: null };
  };

  return {
    /**
     * Returns the current session (5-hour) and weekly (7-day) subscription
     * windows. Never throws: an unauthenticated or unreachable upstream is
     * reported as `available: false` so the composer can hide its bars.
     */
    async getUsageLimits({ bypassCache = false } = {}): Promise<ClaudeUsageLimits> {
      const now = dependencies.now();
      if (!bypassCache && cache && cache.expiresAt > now) {
        return cache.value;
      }

      const cacheResult = (value: ClaudeUsageLimits, ttl: number) => {
        cache = { value, expiresAt: dependencies.now() + ttl };
        return value;
      };

      const { token, reason } = await resolveAccessToken();
      if (!token) {
        return cacheResult(unavailable(reason ?? 'not-authenticated', now), FAILURE_CACHE_MS);
      }

      let payload: unknown;
      try {
        payload = await dependencies.fetchUsage(token);
      } catch {
        return cacheResult(unavailable('usage-unavailable', now), FAILURE_CACHE_MS);
      }

      const body = readObjectRecord(payload);
      const rateLimits = readObjectRecord(body?.rate_limits) ?? body;
      if (!rateLimits || !('five_hour' in rateLimits || 'seven_day' in rateLimits)) {
        return cacheResult(unavailable('usage-unavailable', now), FAILURE_CACHE_MS);
      }

      return cacheResult({
        available: true,
        reason: null,
        subscriptionType: readOptionalString(body?.subscription_type) ?? null,
        session: readWindow(rateLimits.five_hour),
        weekly: readWindow(rateLimits.seven_day),
        fetchedAt: new Date(dependencies.now()).toISOString(),
      }, SUCCESS_CACHE_MS);
    },
  };
}

/**
 * Used by the provider routes to serve the composer's usage bars.
 */
export const claudeUsageLimitsService = createClaudeUsageLimitsService();
