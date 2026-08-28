// The poster decides what gets written to a public room and what counts as already written.
// Both are one-way: a post cannot be withdrawn, and a lost record re-posts everything. These
// cover the paths where getting it wrong is expensive, all of them with fixtures that stop
// before the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, run } from './helpers.mjs';

const withBox = (fn) => () => {
  const box = sandbox();
  try { return fn(box, (...args) => run(box.dir, 'poster.mjs', args)); }
  finally { box.cleanup(); }
};

describe('damaged state must stop the run, not read as a clean start', () => {
  // "Nothing has been posted" is what an unreadable posted.json used to look like, and it
  // means re-posting the whole queue into a public room.
  for (const [name, body] of Object.entries({
    'unparseable': 'not json',
    'not an array': '{"nope":1}',
    'item without an id': '[{"room":"lobby"}]',
    'duplicate ids': '[{"id":"a"},{"id":"a"}]',
  })) {
    test(`refuses posted.json that is ${name}`, withBox((box, poster) => {
      box.write('queue.json', [{ id: 'x', room: 'lobby', text: 'hello' }]);
      box.write('posted.json', body);
      const r = poster();
      assert.notEqual(r.code, 0);
      assert.match(r.stdout + r.stderr, /ABORT/);
    }));
  }

  test('a missing posted.json is a legitimate first run', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'x', room: 'lobby', text: 'hello', example: true }]);
    const r = poster();
    // Stops on the example guard, not on state validation — meaning state parsed fine.
    assert.match(r.stdout + r.stderr, /shipped example/);
  }));
});

describe('the shipped sample must never post', () => {
  test('an item marked example:true is refused', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'e', room: 'lobby', text: 'sample', example: true }]);
    box.write('posted.json', []);
    const r = poster();
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /shipped example/);
  }));
});

describe('a post whose outcome is unknown must not be sent again', () => {
  test('a leftover pending record stops the next run', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'x', room: 'lobby', text: 'hello' }]);
    box.write('posted.json', []);
    box.write('.pending.json', { id: 'x', room: 'lobby', at: '2026-08-28T00:00:00Z' });
    const r = poster();
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /not resending/);
  }));

  // ...but not when the record is merely stale. If the post is already written down as
  // sent, only the delete failed, and stopping to ask about it would halt the automation
  // over a filesystem hiccup that cost nothing.
  test('a pending record for something already posted is cleared, not raised', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'x', room: 'lobby', text: 'hello', example: true }]);
    box.write('posted.json', [{ id: 'x', room: 'lobby', seq: '1', at: 'earlier' }]);
    box.write('.pending.json', { id: 'x', room: 'lobby', at: 'earlier' });
    const r = poster();
    assert.match(r.stdout, /stale/);
    assert.doesNotMatch(r.stdout, /not resending/);
    assert.equal(existsSync(join(box.dir, '.pending.json')), false);
  }));

  // The counterpart, and the bug this pairing was written for: a refusal that happened
  // before any request is not unknown at all. Leaving a pending record for it halted the
  // whole automation on a typo while warning the post might already exist.
  for (const [name, item] of Object.entries({
    'an invalid room name': { id: 'bad', room: 'INVALID', text: 'x' },
    'text that sweeps to nothing': { id: 'blank', room: 'lobby', text: '   ' },
  })) {
    test(`${name} leaves no pending record`, withBox((box, poster) => {
      box.write('queue.json', [item]);
      box.write('posted.json', []);
      const r = poster();
      assert.notEqual(r.code, 0);
      assert.equal(existsSync(join(box.dir, '.pending.json')), false,
        'nothing was sent, so there is nothing to reconcile');
      assert.match(r.stdout + r.stderr, /ABORT/);
    }));
  }
});

describe('clearing the pending marker', () => {
  // Every path that removes it must go through the one function that reports a failure.
  // Three call sites removed it directly and two of them wrote `catch {}`, so a delete that
  // failed left a marker that stopped the next run with nothing on screen saying why. This
  // asserts on the source because the failure it guards against needs a locked file to
  // reproduce, and a test that cannot run is not a guard.
  test('no path deletes it without reporting a failure', () => {
    const src = readFileSync(new URL('../poster.mjs', import.meta.url), 'utf8');
    const swallowed = src.match(/unlinkSync\(PENDING\)[^\n]*catch\s*\{\s*\}/g) ?? [];
    assert.equal(swallowed.length, 0, 'use dropPending() rather than swallowing the error');
    const direct = src.match(/unlinkSync\(PENDING\)/g) ?? [];
    assert.equal(direct.length, 1, 'only dropPending() should call unlinkSync on the marker');
  });
});

describe('oversized and invisible content is caught before signing', () => {
  test('over the cap', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'big', room: 'lobby', text: 'a'.repeat(4097) }]);
    box.write('posted.json', []);
    assert.match(poster().stdout, /ABORT.*4096/);
  }));

  // The cap is codepoints, the same unit the server and the child count in. Measuring
  // UTF-16 units here made an emoji cost two against a limit it costs one against
  // everywhere else, so the poster refused messages the server would have taken.
  test('counts codepoints, not UTF-16 units', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'astral', room: 'lobby', text: '𝄞'.repeat(2049) }]);
    box.write('posted.json', []);
    const out = poster().stdout;
    assert.doesNotMatch(out, /ABORT/, '2049 codepoints is under the cap');
  }));

  test('rejects an item whose text is not a string', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'notext', room: 'lobby' }]);
    box.write('posted.json', []);
    assert.match(poster().stdout, /ABORT.*no text/);
  }));

  test('characters the sweep would rewrite', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'inv', room: 'lobby', text: 'a­b' }]);
    box.write('posted.json', []);
    assert.match(poster().stdout, /ABORT.*sweep would rewrite/);
  }));
});

describe('status reporting', () => {
  test('counts what is left without sending anything', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
    box.write('posted.json', [{ id: 'a' }]);
    const r = poster('status');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /posted 1 \/ queued 2 \/ remaining 1/);
  }));
});

describe('exhaustion', () => {
  test('says so and exits cleanly rather than inventing a message', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'a', text: 'x' }]);
    box.write('posted.json', [{ id: 'a' }]);
    const r = poster();
    // Exactly 0, not merely "not a crash". This exited 127 on Windows until the run stopped
    // calling process.exit() after a fetch, and the scheduled task reads any non-zero code
    // as a failure to retry — so closing the notice opened three more of them.
    assert.equal(r.code, 0, 'a non-zero code here makes the task retry and reopen the notice');
    assert.match(r.stdout, /IDLE queue exhausted/);
    // No console attached under a pipe, so it must print and exit rather than wait forever.
    assert.match(r.stdout, /ネタ切れ/);
  }));
});

describe('exit codes the scheduler acts on', () => {
  // Every path below runs after the openapi fetch, which is where process.exit() went wrong.
  test('a refused item exits 1, not 127', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'bad', room: 'INVALID', text: 'x' }]);
    box.write('posted.json', []);
    assert.equal(poster().code, 1);
  }));

  test('the example guard exits 1, not 127', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'e', room: 'lobby', text: 's', example: true }]);
    box.write('posted.json', []);
    assert.equal(poster().code, 1);
  }));

  test('a pending record exits 1, not 127', withBox((box, poster) => {
    box.write('queue.json', [{ id: 'x', room: 'lobby', text: 'hello' }]);
    box.write('posted.json', []);
    box.write('.pending.json', { id: 'x', room: 'lobby', at: 'earlier' });
    assert.equal(poster().code, 1);
  }));
});

describe('the queue is the only source of content', () => {
  test('poster.mjs contains no model call or network read that feeds a post', () => {
    const src = readFileSync(new URL('../poster.mjs', import.meta.url), 'utf8');
    // The one fetch it makes is the openapi tripwire, whose result never becomes a message.
    const fetches = src.match(/fetch\(/g) ?? [];
    assert.equal(fetches.length, 1, 'only the openapi check should fetch');
    assert.doesNotMatch(src, /openai|anthropic|completion|generate/i);
  });
});
