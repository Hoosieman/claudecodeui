import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeferred, PromptQueue } from '@/modules/providers/list/claude/claude-prompt-queue.js';

const collect = async (stream, count) => {
  const seen = [];
  for await (const item of stream) {
    seen.push(item);
    if (seen.length === count) {
      break;
    }
  }
  return seen;
};

test('stream yields messages queued before it starts', async () => {
  const queue = new PromptQueue();
  queue.push('first');
  queue.push('second');

  assert.deepEqual(await collect(queue.stream(), 2), ['first', 'second']);
});

test('stream parks on an empty queue instead of ending', async () => {
  const queue = new PromptQueue();
  const stream = queue.stream();

  const pending = stream.next();
  let settled = false;
  pending.then(() => { settled = true; });

  // A turn's worth of event loop with nothing queued: the stream must still be
  // waiting, because ending it is what kills the child process.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'stream ended while the queue was merely empty');

  queue.push('late');
  assert.deepEqual(await pending, { value: 'late', done: false });
});

test('close ends a parked stream', async () => {
  const queue = new PromptQueue();
  const stream = queue.stream();
  const pending = stream.next();

  queue.close();

  assert.equal((await pending).done, true);
  assert.equal(queue.isClosed, true);
});

test('close ends a stream that has not been read yet', async () => {
  const queue = new PromptQueue();
  queue.close();

  assert.deepEqual(await collect(queue.stream(), 1), []);
});

test('queued messages still drain after close', async () => {
  const queue = new PromptQueue();
  queue.push('first');
  queue.close();

  assert.deepEqual(await collect(queue.stream(), 1), ['first']);
});

test('push after close is rejected', () => {
  const queue = new PromptQueue();
  queue.close();

  assert.equal(queue.push('too late'), false);
});

test('createDeferred settles from the outside', async () => {
  const resolved = createDeferred();
  resolved.resolve('done');
  assert.equal(await resolved.promise, 'done');

  const rejected = createDeferred();
  rejected.reject(new Error('nope'));
  await assert.rejects(rejected.promise, /nope/);
});
