// Shared fixture plumbing. Every test runs the real CLI in a throwaway directory with a
// throwaway key, so nothing here can touch the live identity or post to the network.
//
// The key is generated, never copied: copying the real agent.key.json — even briefly, even
// for a check — puts it somewhere with different ACLs, which is how it was exposed once
// already. keygen sets the ACL on what it creates, so a generated one is safe.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

export function sandbox({ withKey = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flop-test-'));
  for (const f of ['flop-agent.mjs', 'poster.mjs']) cpSync(join(SRC, f), join(dir, f));
  if (withKey) run(dir, 'flop-agent.mjs', ['keygen']);
  return {
    dir,
    write: (name, value) => writeFileSync(join(dir, name),
      typeof value === 'string' ? value : JSON.stringify(value)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// spawnSync, not execFileSync: the latter returns only stdout and throws on a non-zero
// exit, so a first version of this silently reported an empty stderr for every run that
// succeeded — and the composed message, which several tests read, is written to stderr.
// The exit code is usually what is under test, so failure must not throw either.
export function run(dir, script, args = []) {
  const r = spawnSync(process.execPath, [join(dir, script), ...args],
    { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const readSource = (f) => execFileSync('node',
  ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(SRC, f))}, 'utf8'))`],
  { encoding: 'utf8' });
