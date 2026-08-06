/**
 * Proves the property the persistent path exists for: a second turn on the same
 * session reuses the live process instead of spawning another.
 *
 * Run with module mocking enabled:
 *   node --experimental-test-module-mocks --import tsx/esm --test \
 *     server/modules/providers/list/claude/claude-runtime.persistence.test.js
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Records every query() the provider makes, and drives each one from the prompt
// stream it was handed — one `result` per user message, like the real SDK.
const spawns = [];

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: ({ prompt, options }) => {
      const spawn = { options, turns: 0, interrupts: 0, modelSwitches: [], modeSwitches: [] };
      spawns.push(spawn);

      return {
        async *[Symbol.asyncIterator]() {
          for await (const userMessage of prompt) {
            spawn.turns += 1;
            yield {
              type: 'assistant',
              session_id: 'provider-session',
              message: { role: 'assistant', content: [{ type: 'text', text: `echo ${spawn.turns}` }] },
              _prompt: userMessage
            };
            yield {
              type: 'result',
              session_id: 'provider-session',
              subtype: 'success',
              usage: { input_tokens: 1, output_tokens: 1 }
            };
          }
        },
        // Matches probed SDK behaviour: interrupt stops the turn but the
        // stream keeps serving (scripts/probe-sdk-persistence.mjs).
        interrupt: async () => { spawn.interrupts += 1; },
        setModel: async (model) => { spawn.modelSwitches.push(model); },
        setPermissionMode: async (mode) => { spawn.modeSwitches.push(mode); }
      };
    }
  }
});

const { queryClaudeSDK, closePersistentSession, isClaudeSDKSessionActive, abortClaudeSDKSession } =
  await import('@/modules/providers/list/claude/claude-runtime.provider.js');

const createWriter = () => {
  const sent = [];
  return {
    sent,
    // Numeric: notification preferences are keyed by the users table's integer id.
    userId: 1,
    send: (message) => sent.push(message),
    setSessionId: () => {}
  };
};

const createContext = () => ({
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, model) => model,
  getProviderModels: async () => ({ OPTIONS: [] }),
  normalizeMessage: (message) => (message.type === 'assistant' ? [{ kind: 'assistant', message }] : []),
  isProviderInstalled: async () => true
});

const baseOptions = (sessionId) => ({
  sessionId,
  cwd: process.cwd(),
  model: 'claude-sonnet-5',
  toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true }
});

test('a second turn reuses the live process', async (t) => {
  spawns.length = 0;
  const sessionId = 'session-reuse';
  t.after(() => closePersistentSession(sessionId, 'test-cleanup'));

  const first = createWriter();
  await queryClaudeSDK('first message', baseOptions(sessionId), first, createContext());

  assert.equal(spawns.length, 1, 'first turn should spawn exactly one process');
  assert.equal(spawns[0].turns, 1);
  assert.ok(
    first.sent.some((message) => message.type === 'claude-complete' || message.kind === 'complete'),
    'first turn should end with a terminal complete'
  );

  const second = createWriter();
  await queryClaudeSDK('second message', baseOptions(sessionId), second, createContext());

  assert.equal(spawns.length, 1, 'second turn spawned another process instead of reusing the live one');
  assert.equal(spawns[0].turns, 2, 'second turn should have been fed to the existing process');
  assert.ok(
    second.sent.some((message) => message.type === 'claude-complete' || message.kind === 'complete'),
    'second turn should end with its own terminal complete'
  );
});

test('the session parks between turns rather than reading as a live run', async (t) => {
  spawns.length = 0;
  const sessionId = 'session-parked';
  t.after(() => closePersistentSession(sessionId, 'test-cleanup'));

  await queryClaudeSDK('only message', baseOptions(sessionId), createWriter(), createContext());

  assert.equal(isClaudeSDKSessionActive(sessionId), false, 'a parked session must not read as an active run');
});

test('changing the model switches in-process instead of respawning', async (t) => {
  spawns.length = 0;
  const sessionId = 'session-model-change';
  t.after(() => closePersistentSession(sessionId, 'test-cleanup'));

  await queryClaudeSDK('first', baseOptions(sessionId), createWriter(), createContext());
  const second = createWriter();
  await queryClaudeSDK(
    'second',
    { ...baseOptions(sessionId), model: 'claude-opus-5' },
    second,
    createContext()
  );

  assert.equal(spawns.length, 1, 'a model change must reuse the live process via setModel, like the CLI /model');
  assert.deepEqual(spawns[0].modelSwitches, ['claude-opus-5']);
  assert.equal(spawns[0].turns, 2, 'the switched turn should still be served by the same process');
  assert.ok(
    second.sent.some((message) => message.type === 'claude-complete' || message.kind === 'complete'),
    'the switched turn should end with its own terminal complete'
  );
});

test('abort interrupts in place and keeps the process for the next turn', async (t) => {
  spawns.length = 0;
  const sessionId = 'session-abort-keeps-process';
  t.after(() => closePersistentSession(sessionId, 'test-cleanup'));

  await queryClaudeSDK('first', baseOptions(sessionId), createWriter(), createContext());
  assert.equal(await abortClaudeSDKSession(sessionId), true);
  assert.equal(spawns[0].interrupts, 1, 'abort should interrupt the live process');

  const after = createWriter();
  await queryClaudeSDK('after abort', baseOptions(sessionId), after, createContext());

  assert.equal(spawns.length, 1, 'the turn after an abort must reuse the interrupted process, like the CLI after Esc');
  assert.equal(spawns[0].turns, 2);
  assert.ok(
    after.sent.some((message) => message.type === 'claude-complete' || message.kind === 'complete'),
    'the turn after an abort must still end with a terminal complete (stale abort flags would suppress it)'
  );
});

test('closing a session releases its process', async () => {
  spawns.length = 0;
  const sessionId = 'session-close';

  await queryClaudeSDK('first', baseOptions(sessionId), createWriter(), createContext());
  assert.equal(closePersistentSession(sessionId, 'test'), true);

  // Closing ends the prompt stream, so the next turn has to spawn again.
  await queryClaudeSDK('second', baseOptions(sessionId), createWriter(), createContext());
  assert.equal(spawns.length, 2);
  closePersistentSession(sessionId, 'test-cleanup');
});
