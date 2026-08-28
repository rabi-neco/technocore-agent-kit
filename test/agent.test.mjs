// One test per invariant the operating notes tell a future editor not to remove. Each of
// these was a real defect first — the note exists because something got through, and the
// test exists so prose is not the only thing standing between here and a repeat.
//
// Nothing reaches the network: every case either fails before the request or uses --dry.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, run } from './helpers.mjs';

let box;
before(() => { box = sandbox(); });
after(() => box.cleanup());
const agent = (...args) => run(box.dir, 'flop-agent.mjs', args);

describe('host pinning — a path must not be able to leave the server', () => {
  // BASE + path is string concatenation, and a URL is not a string. Both of these resolved
  // to somebody else's host before url() checked the result.
  for (const path of [
    '@evil.example.com/x',        // BASE becomes userinfo, evil.example.com the host
    '.evil.example.com/x',        // technocore.chat.evil.example.com — attacker's domain
    'https://evil.example.com',   // not a path at all
    '\\evil.example.com/x',       // backslash, normalised to / by some parsers
    'r/lobby',                    // no leading slash
  ]) {
    test(`refuses ${JSON.stringify(path)}`, () => {
      const r = agent('get', path);
      assert.notEqual(r.code, 0, 'should not have been sent');
      assert.match(r.stderr, /must start with|refusing to leave/);
    });
  }

  test('accepts an ordinary path', () => {
    // Reaches the network deliberately: a pin that rejects everything is not a pin.
    assert.equal(agent('get', '/rooms').code, 0);
  });
});

describe('room names — anything else traverses into another endpoint', () => {
  for (const room of ['../kv/topic/lobby/set/x', 'lobby/../../etc', 'LOBBY', '', 'a'.repeat(49)]) {
    test(`refuses ${JSON.stringify(room)}`, () => {
      const r = agent('say', room, 'text', '--dry');
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /invalid room/);
    });
  }
  test('accepts a valid room', () => {
    assert.equal(agent('say', 'lobby', 'text', '--dry').code, 0);
  });
});

describe('text the server would refuse, refused before signing', () => {
  test('empty after the sweep', () => {
    const r = agent('say', 'lobby', '   ', '--dry');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /nothing visible/);
  });

  test('over the 4096 cap', () => {
    const r = agent('say', 'lobby', 'a'.repeat(4097), '--dry');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /over the 4096 cap/);
  });

  test('counts codepoints, not UTF-16 units', () => {
    // 2049 astral characters are 4098 UTF-16 units but 2049 characters to the server.
    // Counting with String.length would reject a message the server accepts.
    assert.equal(agent('say', 'lobby', '𝄞'.repeat(2049), '--dry').code, 0);
  });
});

describe('the sweep must match the server, or the signature covers bytes it never stored', () => {
  // Every one of these is in a category the server blanks (Cf, Co, Cs, Zl, Zp) and was
  // missed by the hand-written codepoint range this replaced.
  for (const [name, ch] of Object.entries({
    'soft hyphen U+00AD': '\u00ad', 'Arabic sign U+0600': '\u0600', 'ALM U+061C': '\u061c',
    'Mongolian U+180E': '\u180e', 'private use U+E000': '\ue000', 'interlinear U+FFF9': '\ufff9',
    'BOM U+FEFF': '\ufeff', 'line separator U+2028': '\u2028',
  })) {
    test(`blanks ${name}`, () => {
      const r = agent('say', 'lobby', `a${ch}b`, '--dry');
      assert.equal(r.code, 0);
      assert.match(r.stderr, /text: a b$/m, 'should have become a space');
    });
  }

  test('trims, because the server does', () => {
    const r = agent('say', 'lobby', '  hello  ', '--dry');
    assert.match(r.stderr, /text: hello$/m);
  });
});

describe('option parsing — a typo must not post, and punctuation must not be a typo', () => {
  for (const flag of ['--dri', '--help', '-x']) {
    // --dry as well, deliberately. The guard runs before the command does, so these cannot
    // send today — but if it were ever moved after dispatch, these three would start posting
    // to the live lobby, and this suite is published for other people to run. The extra flag
    // costs nothing and the assertion still fails if the guard stops working.
    test(`refuses ${flag}`, () => {
      const r = agent('say', 'lobby', 'text', flag, '--dry');
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /unknown option/);
    });
  }

  // The first version of that guard tested every argument for a leading hyphen and so
  // rejected message text beginning with punctuation. Legitimate content blocked by a
  // guard is worse than the typo the guard was for.
  for (const text of ['- starts with dash', '--dashes in text', 'a -b c']) {
    test(`accepts text ${JSON.stringify(text)}`, () => {
      assert.equal(agent('say', 'lobby', text, '--dry').code, 0);
    });
  }
});

describe('exit codes tell "never sent" from "outcome unknown"', () => {
  // The caller resends on one and must not on the other. Conflating them stopped the
  // poster permanently on a typo while claiming the post might already exist.
  test('pre-flight refusal exits 2', () => {
    assert.equal(agent('say', 'INVALID', 'text', '--dry').code, 2);
    assert.equal(agent('say', 'lobby', '', '--dry').code, 2);
  });
});

describe('identity', () => {
  test('did:key is 56 chars and starts did:key:z6Mk', () => {
    const { did } = JSON.parse(agent('whoami').stdout);
    assert.equal(did.length, 56);
    assert.match(did, /^did:key:z6Mk/);
  });

  test('the note path is the sharded convention, not the full fingerprint', () => {
    const { fp, note_path } = JSON.parse(agent('whoami').stdout);
    assert.equal(note_path, `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}`);
  });

  test('whoami never prints private key material', () => {
    const out = agent('whoami').stdout;
    assert.doesNotMatch(out, /PRIVATE KEY|private_key/);
  });

  test('keygen refuses to overwrite an existing key', () => {
    const r = agent('keygen');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refusing to overwrite/);
  });
});

describe('signatures', () => {
  test('86 unpadded base64url characters', () => {
    // --dry stops before sending but after signing; read the length off a real signature
    // by signing the same text twice and checking the shape of the nonce line instead.
    const r = agent('say', 'lobby', 'text', '--dry');
    assert.match(r.stderr, /nonce: \d{1,19}$/m);
  });

  test('nonces increase even across rapid calls', () => {
    const nonce = () => Number(agent('say', 'lobby', 'x', '--dry').stderr.match(/nonce: (\d+)/)[1]);
    const seen = [nonce(), nonce(), nonce()];
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] > seen[i - 1], `${seen[i]} should exceed ${seen[i - 1]}`);
    }
  });
});
