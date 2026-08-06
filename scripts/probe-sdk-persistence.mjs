// Probe: what does the real SDK do on interrupt() and setModel() in streaming
// input mode? Determines whether CloudCLI's persistent sessions can keep the
// child process across aborts and model switches, like the Claude CLI does.
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

let notify = null;
let closed = false;
const backlog = [];
const stream = (async function* () {
  while (true) {
    if (backlog.length) { yield backlog.shift(); continue; }
    if (closed) return;
    await new Promise((r) => { notify = r; });
  }
})();
const say = (text) => {
  log('>> user:', JSON.stringify(text));
  backlog.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  notify?.();
};

say('Use the Bash tool to run exactly this command: sleep 15. After it finishes, say "slept".');

const q = query({
  prompt: stream,
  options: {
    env: { ...process.env },
    pathToClaudeCodeExecutable: 'C:/Users/cosmith/.local/bin/claude.exe',
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'bypassPermissions',
    allowedTools: ['Bash'],
    cwd: process.cwd()
  }
});

let phase = 'turn1';
let results = 0;

setTimeout(() => { log('GLOBAL TIMEOUT'); process.exit(1); }, 150000);

for await (const m of q) {
  if (m.type === 'system') { log('system:', m.subtype, m.subtype === 'init' ? `model=${m.model} session=${m.session_id}` : ''); continue; }
  if (m.type === 'assistant') {
    const kinds = (m.message?.content || []).map((b) => b.type).join(',');
    log('assistant:', kinds, `model=${m.message?.model}`);
    if (phase === 'turn1' && kinds.includes('tool_use')) {
      phase = 'interrupting';
      log('** calling interrupt() mid-tool-execution');
      q.interrupt()
        .then(() => log('** interrupt() resolved'))
        .catch((e) => log('** interrupt() REJECTED:', e.message));
    }
    continue;
  }
  if (m.type === 'result') {
    results += 1;
    log(`RESULT #${results}: subtype=${m.subtype} is_error=${m.is_error} models=${Object.keys(m.modelUsage || {}).join('|')}`);
    if (results === 1) {
      log('** generator survived the interrupt — trying setModel(sonnet)');
      try {
        await q.setModel('claude-sonnet-5');
        log('** setModel resolved');
      } catch (e) {
        log('** setModel REJECTED:', e.message);
      }
      say('Reply with exactly: second turn alive');
    } else if (results === 2) {
      log('** second turn served by same process. closing stream.');
      closed = true;
      notify?.();
    }
    continue;
  }
  log('other:', m.type);
}

log(`generator ended cleanly. results=${results}`);
process.exit(0);
