/**
 * Prompt plumbing for persistent Claude SDK sessions.
 *
 * The SDK keeps its `claude` child process alive for exactly as long as the
 * async iterable passed to `query({ prompt })` keeps yielding. A generator that
 * yields one user message and returns therefore costs a full process start,
 * MCP handshake, and transcript replay on every turn.
 *
 * `PromptQueue` inverts that: `stream()` parks on an empty queue instead of
 * returning, so one process serves every turn of a session until the queue is
 * explicitly closed (idle reap, abort, or spawn-time option change).
 */

export class PromptQueue {
  constructor() {
    this.pending = [];
    this.resolveNext = null;
    this.closed = false;
  }

  get isClosed() {
    return this.closed;
  }

  /**
   * Hands a user message to the live stream, or parks it until the stream asks.
   * @param {Object} message - SDKUserMessage
   * @returns {boolean} False when the queue is already closed
   */
  push(message) {
    if (this.closed) {
      return false;
    }
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: message, done: false });
      return true;
    }
    this.pending.push(message);
    return true;
  }

  /**
   * Ends the stream, which lets the SDK wind the child process down.
   */
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined, done: true });
    }
  }

  /**
   * Long-lived prompt iterable handed to the SDK.
   * @returns {AsyncGenerator<Object>}
   */
  async *stream() {
    while (true) {
      if (this.pending.length > 0) {
        yield this.pending.shift();
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise((resolve) => {
        this.resolveNext = resolve;
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

/**
 * Externally settled promise, used to hand a single turn's completion back to
 * the caller while the run loop keeps going.
 * @returns {{promise: Promise<void>, resolve: Function, reject: Function}}
 */
export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
