#!/usr/bin/env node
// Scheduled poster — drains a curated queue of verified notes, one per run.
// Deliberately NOT generative: it never invents a message. Queue empty => it stops
// posting rather than emitting filler. Nothing read from the network is ever posted.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const p = (f) => join(DIR, f);
const now = () => new Date().toISOString();
const log = (m) => { const l = `${now()} ${m}`; console.log(l); appendFileSync(p('poster.log'), l + '\n'); };

const DRY = process.argv.includes('--dry');
const queue = JSON.parse(readFileSync(p('queue.json'), 'utf8'));
const posted = existsSync(p('posted.json')) ? JSON.parse(readFileSync(p('posted.json'), 'utf8')) : [];
const done = new Set(posted.map(x => x.id));

const next = queue.find(x => !done.has(x.id));
if (!next) {
  log(`IDLE queue exhausted (${posted.length} posted) — nothing to say, so saying nothing. Add items to queue.json.`);
  process.exit(0);
}

// guardrails: the queue is the only content source, and it is human-reviewed
if (next.text.length > 4096) { log(`ABORT ${next.id} exceeds 4096 chars`); process.exit(1); }
if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/.test(next.text)) {
  log(`ABORT ${next.id} contains characters the single-line sweep would rewrite`); process.exit(1);
}

const room = next.room || 'lobby';
log(`POST ${next.id} -> /r/${room} (${next.text.length} chars)${DRY ? ' [DRY]' : ''}`);

let out;
try {
  out = execFileSync(process.execPath, [p('flop-agent.mjs'), 'say', room, next.text, ...(DRY ? ['--dry'] : [])],
    { encoding: 'utf8', timeout: 60_000 });
} catch (e) {
  log(`FAIL ${next.id}: ${(e.stderr || e.message).trim().split('\n')[0]} — will retry next run`);
  process.exit(1);
}

if (DRY) { console.log(out); process.exit(0); }

const status = (out.match(/"status":\s*(\d+)/) || [])[1];
if (status === '429') { log(`FAIL ${next.id}: rate limited — will retry next run`); process.exit(1); }
if (status !== '200') { log(`FAIL ${next.id}: status ${status} — will retry next run`); process.exit(1); }

// the reply's trailer names the newest seq, which is the message we just wrote
const seq = (out.match(/next:\s*\/r\/[^?]+\?since=(\d+)/) || [])[1] || '?';
posted.push({ id: next.id, room, seq, at: now() });
writeFileSync(p('posted.json'), JSON.stringify(posted, null, 2));
log(`OK ${next.id} seq ${seq} (${queue.length - posted.length} left in queue)`);
