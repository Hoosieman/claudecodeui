import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeUsageLimitsService } from '@/modules/providers/services/claude-usage-limits.service.js';

// The live response Claude Code's /usage screen reads: every window sits at the
// top level, and unused windows come back as explicit nulls.
const LIVE_RESPONSE = {
  five_hour: { utilization: 28.4, resets_at: '2026-08-07T00:50:00.011024+00:00' },
  seven_day: { utilization: 13, resets_at: '2026-08-12T22:00:00.011053+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
};

const credentials = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  claudeAiOauth: { accessToken: 'test-access-token', ...overrides },
});

const buildService = (
  overrides: Parameters<typeof createClaudeUsageLimitsService>[0] = {},
) => createClaudeUsageLimitsService({
  getEnvironment: () => ({}),
  readTextFile: async () => credentials(),
  readKeychainCredentials: () => null,
  fetchUsage: async () => LIVE_RESPONSE,
  ...overrides,
});

test('reads the session and weekly windows from a top-level usage response', async () => {
  const limits = await buildService().getUsageLimits();

  assert.equal(limits.available, true);
  assert.equal(limits.reason, null);
  assert.deepEqual(limits.session, {
    utilization: 28.4,
    resetsAt: '2026-08-07T00:50:00.011Z',
  });
  assert.deepEqual(limits.weekly, {
    utilization: 13,
    resetsAt: '2026-08-12T22:00:00.011Z',
  });
});

test('reads the same windows when they arrive wrapped in rate_limits', async () => {
  const limits = await buildService({
    fetchUsage: async () => ({ rate_limits: LIVE_RESPONSE, subscription_type: 'max' }),
  }).getUsageLimits();

  assert.equal(limits.available, true);
  assert.equal(limits.subscriptionType, 'max');
  assert.equal(limits.session?.utilization, 28.4);
});

test('accepts epoch-seconds reset times without inventing a date', async () => {
  const limits = await buildService({
    fetchUsage: async () => ({
      five_hour: { utilization: 5, resets_at: 1_785_000_000 },
      seven_day: { utilization: 5, resets_at: 'not-a-date' },
    }),
  }).getUsageLimits();

  assert.equal(limits.session?.resetsAt, new Date(1_785_000_000 * 1000).toISOString());
  assert.equal(limits.weekly?.resetsAt, null);
});

test('clamps a utilization that overshoots the window', async () => {
  const limits = await buildService({
    fetchUsage: async () => ({ five_hour: { utilization: 140 }, seven_day: { utilization: -3 } }),
  }).getUsageLimits();

  assert.equal(limits.session?.utilization, 100);
  assert.equal(limits.weekly?.utilization, 0);
});

test('prefers the environment OAuth token over the credentials file', async () => {
  let seenToken: string | null = null;
  const limits = await buildService({
    getEnvironment: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }),
    readTextFile: async () => {
      throw new Error('credentials file should not be read');
    },
    fetchUsage: async (token) => {
      seenToken = token;
      return LIVE_RESPONSE;
    },
  }).getUsageLimits();

  assert.equal(seenToken, 'env-token');
  assert.equal(limits.available, true);
});

test('falls back to the keychain when no credentials file exists', async () => {
  let seenToken: string | null = null;
  await buildService({
    readTextFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readKeychainCredentials: () => credentials({ accessToken: 'keychain-token' }),
    fetchUsage: async (token) => {
      seenToken = token;
      return LIVE_RESPONSE;
    },
  }).getUsageLimits();

  assert.equal(seenToken, 'keychain-token');
});

test('reports an expired login instead of spending a doomed request', async () => {
  let fetched = false;
  const limits = await buildService({
    readTextFile: async () => credentials({ expiresAt: 1_000 }),
    now: () => 2_000,
    fetchUsage: async () => {
      fetched = true;
      return LIVE_RESPONSE;
    },
  }).getUsageLimits();

  assert.equal(fetched, false);
  assert.equal(limits.available, false);
  assert.equal(limits.reason, 'login-expired');
});

test('reports an unauthenticated state when no OAuth login is present', async () => {
  const limits = await buildService({
    readTextFile: async () => JSON.stringify({ somethingElse: true }),
  }).getUsageLimits();

  assert.equal(limits.available, false);
  assert.equal(limits.reason, 'not-authenticated');
});

test('reports an unavailable upstream rather than throwing', async () => {
  const limits = await buildService({
    fetchUsage: async () => {
      throw new Error('usage request failed with 401');
    },
  }).getUsageLimits();

  assert.equal(limits.available, false);
  assert.equal(limits.reason, 'usage-unavailable');
});

test('rejects a 200 response that carries no recognizable window', async () => {
  const limits = await buildService({
    fetchUsage: async () => ({ extra_usage: { is_enabled: false } }),
  }).getUsageLimits();

  assert.equal(limits.available, false);
  assert.equal(limits.reason, 'usage-unavailable');
});

test('serves the cached snapshot until it expires, and bypassCache skips it', async () => {
  let calls = 0;
  let clock = 0;
  const service = buildService({
    now: () => clock,
    fetchUsage: async () => {
      calls += 1;
      return LIVE_RESPONSE;
    },
  });

  await service.getUsageLimits();
  await service.getUsageLimits();
  assert.equal(calls, 1);

  await service.getUsageLimits({ bypassCache: true });
  assert.equal(calls, 2);

  clock = 120_000;
  await service.getUsageLimits();
  assert.equal(calls, 3);
});
