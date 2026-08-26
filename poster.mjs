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

// A normal run flashes a console window shut and that is the point. Exhaustion is the one
// outcome that needs a human, so it holds the same window open instead of writing a log
// line nobody opens.
//
// No timeout. A window that closes itself while you are away destroys the very signal it
// exists to deliver, and closing it costs you nothing to begin with. It waits until a key
// is pressed. (Task Scheduler's "タスクを停止するまでの時間" must be disabled too, or it
// kills the window on its own schedule and undoes this.)
//
// Only when a console is actually attached: run from a pipe or a script there is no window
// to keep open and no keypress coming, so it prints and exits rather than hanging a caller.
function holdOpen(lines) {
  const bar = '='.repeat(64);
  console.log(`\n${bar}\n${lines.join('\n')}\n${bar}\n`);
  if (!process.stdin.isTTY) return Promise.resolve();
  console.log('  何かキーを押すと閉じます\n');
  return new Promise((done) => {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => { try { process.stdin.pause(); } catch {} done(); });
    } catch { done(); }
  });
}

const DRY = process.argv.includes('--dry');
const queue = JSON.parse(readFileSync(p('queue.json'), 'utf8'));
const posted = existsSync(p('posted.json')) ? JSON.parse(readFileSync(p('posted.json'), 'utf8')) : [];
const done = new Set(posted.map(x => x.id));

const remaining = queue.filter(x => !done.has(x.id));

if (process.argv.includes('status')) {
  console.log(`posted ${posted.length} / queued ${queue.length} / remaining ${remaining.length}`);
  remaining.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${x.room || 'lobby'}  ${x.id}`));
  process.exit(0);
}

// Notes are reclaimed after 7 idle days (retention_seconds: 604800), and the clock runs on
// the file's write time — being read by anyone does not extend it. The DID note is the one
// thing pointing at this identity, and nothing was rewriting it: posting to a room touches
// the room, not the note. Left alone it would simply vanish a week after publication.
//
// Rewriting it is idempotent and costs one request, so do it on every run, before anything
// that can fail or exit. A failure here is logged and never blocks the post.
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
async function refreshDidNote() {
  const stamp = p('.did-refreshed');
  const last = existsSync(stamp) ? Date.parse(readFileSync(stamp, 'utf8').trim()) : 0;
  if (Date.now() - last < REFRESH_AFTER_MS) return;
  try {
    const out = execFileSync(process.execPath, [p('flop-agent.mjs'), 'publish'],
      { encoding: 'utf8', timeout: 60_000 });
    if (/"status":\s*200/.test(out)) {
      writeFileSync(stamp, now() + '\n');
      log('DID note refreshed (7-day reclaim clock reset)');
    } else {
      log(`WARN DID note refresh did not return 200 — ${(out.match(/"status":\s*(\d+)/) || [])[1]}`);
    }
  } catch (e) {
    log(`WARN DID note refresh failed: ${(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}
if (!DRY && !process.argv.includes('status')) await refreshDidNote();

const next = remaining[0];
if (!next) {
  log(`IDLE queue exhausted (${posted.length} posted) — nothing to say, so saying nothing. Add items to queue.json.`);
  if (!DRY) {
    // The one line that is an instruction gets its own block. Buried in a paragraph of
    // equal-weight text it reads as prose; on its own it reads as the thing to do next.
    await holdOpen([
      '  ★ 投稿キューが空になりました（ネタ切れ）',
      '',
      `    これまでに ${posted.length} 件を投稿済みです。`,
      '    埋め草は投稿しない設計なので、ここで停止しています。',
      '',
      '  ----------------------------------------------------------------',
      '    Claude に、次のとおり伝えてください:',
      '',
      '        キュー補充して',
      '',
      '  ----------------------------------------------------------------',
      '',
      '    補充すれば、次回ログオン時から自動で再開します。',
    ]);
  }
  process.exit(0);
}

// guardrails: the queue is the only content source, and it is human-reviewed
if (next.example) {
  log(`ABORT ${next.id} is a shipped example — replace queue.json with your own material before running`);
  console.log('\n  queue.json still holds the examples this repo ships with.\n' +
              '  They are marked "example": true so a fresh clone cannot post them by accident.\n' +
              '  Write your own items (drop the "example" field) and run again.\n');
  process.exit(1);
}
if (next.text.length > 4096) { log(`ABORT ${next.id} exceeds 4096 chars`); process.exit(1); }
// Same six Unicode categories the server sweeps, plus the trim it applies. Signing text
// the server would rewrite produces a signature that cannot verify, so catch it here
// rather than letting the item fail on the wire and retry forever.
if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u.test(next.text) || next.text !== next.text.trim()) {
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

log(`OK ${next.id} seq ${seq} (${remaining.length - 1} left in queue)`);
