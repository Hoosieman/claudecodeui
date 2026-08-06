/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { createDeferred, PromptQueue } from '@/modules/providers/list/claude/claude-prompt-queue.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// PERSISTENT SESSIONS
// One `claude` process per session instead of one per turn. Without this, every
// message pays process start + MCP handshake for every configured server +
// transcript replay before the model sees a token — a fixed floor of seconds
// that the Claude CLI does not have, because it keeps one process resident.
// Set CLOUDCLI_CLAUDE_PERSISTENT_SESSIONS=0 to fall back to per-turn spawning.
const PERSISTENT_SESSIONS_ENABLED = process.env.CLOUDCLI_CLAUDE_PERSISTENT_SESSIONS !== '0';
const SESSION_IDLE_TIMEOUT_MS =
  parseInt(process.env.CLOUDCLI_CLAUDE_SESSION_IDLE_MS, 10) || 30 * 60 * 1000;
const SESSION_REAP_INTERVAL_MS = 60 * 1000;

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  if (providerSessionId) {
    sdkOptions.resume = providerSessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Identity of the spawn-time options a live process cannot change. Model,
 * permission mode and tool rules all switch in-process (setModel /
 * setPermissionMode / the live option arrays — verified against the real SDK
 * in scripts/probe-sdk-persistence.mjs), but effort, cwd and the MCP server
 * set are fixed when the SDK spawns, so a turn that changes one of those needs
 * a fresh process.
 * @param {Object} sdkOptions - Mapped SDK options
 * @returns {string} Comparable fingerprint
 */
function optionsFingerprint(sdkOptions = {}) {
  return JSON.stringify({
    effort: sdkOptions.effort ?? null,
    cwd: sdkOptions.cwd ?? null,
    mcpServers: Object.keys(sdkOptions.mcpServers || {}).sort()
  });
}

/**
 * Registers a session that owns a live process and its prompt queue.
 * @param {string} sessionId - App session identifier
 * @param {Object} fields - Session record fields
 * @returns {Object} The stored session record
 */
function addPersistentSession(sessionId, { instance, writer, queue, fingerprint, sdkOptions, sessionSummary }) {
  const record = {
    instance,
    writer,
    queue,
    fingerprint,
    // The exact object the spawn's canUseTool closure reads on every call —
    // later turns mutate it in place to refresh model/permission/tool rules.
    sdkOptions,
    sessionSummary,
    // Session-scoped "remember" approvals, re-applied when a later turn
    // replaces the allowed-tools list with its own settings.
    rememberedTools: [],
    // Results the run loop should swallow: aborted turns whose terminal
    // `complete` the gateway already sent.
    discardResults: 0,
    startTime: Date.now(),
    lastActivity: Date.now(),
    status: 'active',
    // FIFO of callers awaiting a turn. The chat layer can start the next run
    // before the previous promise settles, and streaming input accepts those
    // messages while a turn is still going, so results are matched in order
    // rather than against a single slot.
    turnWaiters: [],

    get hasOpenTurn() {
      return this.turnWaiters.length > 0;
    },

    /**
     * Opens a turn. The returned promise settles when the SDK reports a result
     * for it, which is what the caller awaits while the run loop keeps going.
     * @returns {Promise<void>}
     */
    beginTurn() {
      const turn = createDeferred();
      this.turnWaiters.push(turn);
      this.lastActivity = Date.now();
      return turn.promise;
    },

    /**
     * Settles the oldest open turn, if any.
     * @param {Error} [error] - Rejects the turn instead of resolving it
     */
    finishTurn(error) {
      const turn = this.turnWaiters.shift();
      this.lastActivity = Date.now();
      if (!turn) {
        return;
      }
      if (error) {
        turn.reject(error);
      } else {
        turn.resolve();
      }
    },

    /**
     * Settles every open turn. Used on teardown, where no further results are
     * coming and callers would otherwise wait forever.
     * @param {Error} [error] - Rejects the turns instead of resolving them
     */
    finishAllTurns(error) {
      while (this.turnWaiters.length > 0) {
        this.finishTurn(error);
      }
    }
  };

  activeSessions.set(sessionId, record);
  return record;
}

/**
 * Ends a persistent session's prompt stream, which lets the SDK shut its child
 * process down. The run loop performs the actual map cleanup as it unwinds.
 * @param {string} sessionId - App session identifier
 * @param {string} reason - Logged cause
 * @returns {boolean} True when a live session was closed
 */
function closePersistentSession(sessionId, reason = 'closed') {
  const session = getSession(sessionId);
  if (!session?.queue || session.queue.isClosed) {
    return false;
  }
  console.log(`[Claude SDK] Closing persistent session ${sessionId} (${reason})`);
  session.status = 'closing';
  session.queue.close();
  return true;
}

// Reap sessions parked with no turn in flight. Without this, every session a
// user opens holds a `claude` process plus its MCP children until the server
// restarts.
const persistentSessionReaper = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (!session.queue || session.queue.isClosed || session.hasOpenTurn) {
      continue;
    }
    if (now - (session.lastActivity || 0) >= SESSION_IDLE_TIMEOUT_MS) {
      closePersistentSession(sessionId, 'idle');
    }
  }
}, SESSION_REAP_INTERVAL_MS);
persistentSessionReaper.unref?.();

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  if (normalizeImageDescriptors(images).length === 0) {
    return promptWithFiles;
  }

  const content = await buildClaudeUserContent(promptWithFiles, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Builds one SDKUserMessage for the persistent path, which is always in
 * streaming-input mode and so cannot take the plain-string prompt form.
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Object>} SDKUserMessage
 */
async function buildUserMessage(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length > 0
    ? await buildClaudeUserContent(promptWithFiles, images, cwd)
    : promptWithFiles;

  return {
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;
  // Only sessions the caller can name are kept resident; legacy callers that
  // rely on the id being captured mid-stream keep the per-turn behaviour.
  const persistentKey = PERSISTENT_SESSIONS_ENABLED && sessionId ? sessionId : null;
  // The record this invocation owns, if it spawned a resident process. Held by
  // reference rather than looked up by key: a later turn can replace the map
  // entry (option change), and this loop must not touch its successor's turns.
  let sessionRecord = null;
  // A resident run loop outlives the socket that started it, so every send goes
  // through the session's current writer rather than this turn's `ws`.
  const currentWriter = () => sessionRecord?.writer || ws;

  const emitNotification = (event) => {
    const writer = currentWriter();
    notifyUserIfEnabled({
      userId: writer?.userId || null,
      writer,
      event
    });
  };

  /**
   * Reports a failed run and settles whatever turn was open. Shared because a
   * persistent run loop outlives the try/catch of the turn that started it, and
   * a caller awaiting that turn would otherwise hang forever.
   * @param {Error} error - Failure from the SDK or the run loop
   */
  const handleRunFailure = async (error) => {
    console.error('SDK query error:', error);

    const record = sessionRecord;
    // Resolved before the session record goes away, so a client that
    // reconnected mid-run still receives the error on its current socket.
    const writer = currentWriter();
    record?.queue?.close();

    // Clean up session on error, unless a newer run already owns the key.
    if (sessionKey() && (!record || getSession(sessionKey()) === record)) {
      removeSession(sessionKey());
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      record?.finishAllTurns();
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete
    writer.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    writer.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: writer?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });

    record?.finishAllTurns();
  };

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Hand this turn to the session's live process when one is parked on
    // compatible spawn-time options, instead of starting another.
    const fingerprint = optionsFingerprint(sdkOptions);
    if (persistentKey) {
      const live = getSession(persistentKey);
      if (live?.queue && live.status === 'active' && !live.queue.isClosed) {
        if (live.fingerprint === fingerprint) {
          live.writer = ws;
          live.sessionSummary = sessionSummary;

          // Model and permission mode switch in-process, the way the CLI's
          // /model and /permissions do (verified in
          // scripts/probe-sdk-persistence.mjs).
          if (sdkOptions.model !== live.sdkOptions.model) {
            await live.instance.setModel(sdkOptions.model);
            live.sdkOptions.model = sdkOptions.model;
          }
          const incomingMode = sdkOptions.permissionMode || 'default';
          if (incomingMode !== (live.sdkOptions.permissionMode || 'default')) {
            await live.instance.setPermissionMode(incomingMode);
            live.sdkOptions.permissionMode = sdkOptions.permissionMode;
          }

          // Tool rules are read per call by the live canUseTool closure, so a
          // refresh here applies to this turn. Caveat: the CLI-level allow
          // flags were fixed at spawn, so a rule REMOVED mid-session still
          // auto-allows in this process — the same softness the CLI has for
          // session-scoped approvals.
          live.sdkOptions.allowedTools = [
            ...sdkOptions.allowedTools,
            ...live.rememberedTools.filter((entry) => !sdkOptions.allowedTools.includes(entry))
          ];
          live.sdkOptions.disallowedTools = sdkOptions.disallowedTools;

          const userMessage = await buildUserMessage(command, options.images, options.files, options.cwd);
          if (live.queue.push(userMessage)) {
            await live.beginTurn();
            return;
          }
          // The queue closed while this turn was being prepared (idle reap or
          // process exit racing the push) — fall through and spawn fresh.
        } else {
          // Effort, cwd or the MCP server set changed — fixed at spawn, so the
          // parked process cannot serve this turn.
          closePersistentSession(persistentKey, 'options-changed');
        }
      }
    }

    // Persistent runs always stream input (the queue IS the prompt iterable).
    // The per-turn path keeps the original behaviour: a plain string unless
    // image attachments force streaming input. Built per query attempt because
    // an async generator cannot be replayed once consumed.
    const promptQueue = persistentKey ? new PromptQueue() : null;
    if (promptQueue) {
      promptQueue.push(await buildUserMessage(command, options.images, options.files, options.cwd));
    }
    const createPrompt = () => (
      promptQueue
        ? promptQueue.stream()
        : buildPromptPayload(command, options.images, options.files, options.cwd)
    );

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      currentWriter().send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          currentWriter().send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          // Survives later turns replacing the allowed-tools list wholesale.
          if (sessionRecord && !sessionRecord.rememberedTools.includes(decision.rememberEntry)) {
            sessionRecord.rememberedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Query constructor reads this synchronously.
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability. A persistent session also
    // owns its prompt queue and the turn that is currently open.
    let turnPromise = null;
    if (persistentKey) {
      sessionRecord = addPersistentSession(persistentKey, {
        instance: queryInstance,
        writer: ws,
        queue: promptQueue,
        fingerprint,
        sdkOptions,
        sessionSummary
      });
      turnPromise = sessionRecord.beginTurn();
    } else if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws);
    }

    // Terminal event for ONE turn. The per-turn path calls this once its
    // generator has wound down; the persistent path calls it on every SDK
    // `result`, because its generator is not meant to wind down at all.
    const finalizeTurn = () => {
      // Skipped for aborted runs, whose terminal `complete` (aborted: true) was
      // already sent by abort-session.
      const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
      const writer = currentWriter();
      if (!wasAborted) {
        writer.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: writer?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        // The record's summary tracks renames across turns; this closure's
        // `sessionSummary` is frozen at the spawning turn.
        sessionName: sessionRecord?.sessionSummary ?? sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    };

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    const runLoop = async () => {
      for await (const message of queryInstance) {
        // Capture session ID from first message
        if (message.session_id && !capturedSessionId) {

          capturedSessionId = message.session_id;
          if (!persistentKey) {
            addSession(sessionKey(), queryInstance, ws);
          }

          // Set session ID on writer
          const writer = currentWriter();
          if (writer.setSessionId && typeof writer.setSessionId === 'function') {
            writer.setSessionId(capturedSessionId);
          }

          // Send session-created event only once for sessions with nothing to resume
          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
          }
        } else {
          // session_id already captured
        }

        // Tail of an aborted turn: the gateway already sent its terminal
        // `complete`, so its trailing messages don't reach the client and its
        // result is swallowed rather than finalized as a fresh completion.
        if (sessionRecord && sessionRecord.discardResults > 0) {
          if (message.type === 'result') {
            sessionRecord.discardResults -= 1;
            sessionRecord.lastActivity = Date.now();
          }
          continue;
        }

        // Transform and normalize message via adapter
        const transformedMessage = transformMessage(message);
        const sid = capturedSessionId || sessionId || null;

        // Use adapter to normalize SDK events into NormalizedMessage[]
        const normalized = context.normalizeMessage(transformedMessage, sid);
        for (const msg of normalized) {
          // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
          if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
            msg.parentToolUseId = transformedMessage.parentToolUseId;
          }
          currentWriter().send(msg);
        }

        // Extract and send token budget updates from assistant/result usage payloads
        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          currentWriter().send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }

        // A `result` ends the turn, not the process: report it and park for the
        // next message rather than letting the loop fall through.
        if (sessionRecord && message.type === 'result') {
          finalizeTurn();
          sessionRecord.finishTurn();
        }
      }

      // Generator wound down: idle reap, abort, option change, or the child
      // process exiting on its own.
      if (sessionRecord) {
        // Leave a newer session in place — this loop no longer owns the key.
        if (getSession(persistentKey) === sessionRecord) {
          removeSession(persistentKey);
        }
        // A stale abort marker must not leak into the session's next process,
        // where it would suppress a legitimate turn's terminal complete.
        abortedSessionIds.delete(persistentKey);
        sessionRecord.finishAllTurns();
        return;
      }

      // Clean up session on completion
      if (sessionKey()) {
        removeSession(sessionKey());
      }
      finalizeTurn();
      // Complete
    };

    if (!persistentKey) {
      await runLoop();
      return;
    }

    // Resident run: the loop stays up to serve later turns, so hand the caller
    // back this turn's completion rather than the loop's.
    runLoop().catch((error) => handleRunFailure(error));
    await turnPromise;

  } catch (error) {
    await handleRunFailure(error);
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    // A persistent session interrupts in place and keeps its process — the
    // CLI's Esc behaviour. The SDK stops the current turn and stays live
    // (verified in scripts/probe-sdk-persistence.mjs: interrupt() yields an
    // error_during_execution result and the stream keeps serving). The gateway
    // sends the aborted run's terminal complete; the turn's late result is
    // swallowed by the run loop via discardResults.
    if (session.queue && !session.queue.isClosed) {
      console.log(`Interrupting persistent session (process kept): ${sessionId}`);
      const openTurns = session.turnWaiters.length;
      session.discardResults += openTurns;
      try {
        await session.instance.interrupt();
      } catch (error) {
        session.discardResults -= openTurns;
        throw error;
      }
      session.finishAllTurns();
      return true;
    }

    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return false;
  }
  // A persistent session holds its process between turns, so "active" has to
  // mean a turn is actually in flight — otherwise a parked session reads as a
  // run in progress forever.
  if (session.queue) {
    return session.status === 'active' && session.hasOpenTurn;
  }
  return session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  closePersistentSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
