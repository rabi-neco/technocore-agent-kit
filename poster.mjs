#!/usr/bin/env node
// Scheduled poster — drains a curated queue of verified notes, one per run.
// Deliberately NOT generative: it never invents a message. Queue empty => it stops
// posting rather than emitting filler. Nothing read from the network is ever posted.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync } from 'node:fs';
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

// Read state defensively. A truncated write, a hand edit, or a deleted posted.json used to
// be indistinguishable from a clean first run — and "no record of anything posted" means
// re-posting the entire queue. Refuse to act on state that does not parse or does not have
// the shape expected, rather than treating damage as a fresh start.
function readJsonArray(file, { required }) {
  if (!existsSync(p(file))) {
    if (required) throw new Error(`${file} is missing`);
    return [];
  }
  let v;
  try { v = JSON.parse(readFileSync(p(file), 'utf8')); }
  catch (e) { throw new Error(`${file} is not valid JSON (${e.message}) — fix or restore it; refusing to post`); }
  if (!Array.isArray(v)) throw new Error(`${file} must be a JSON array`);
  for (const [i, x] of v.entries()) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id) {
      throw new Error(`${file}[${i}] has no string id`);
    }
  }
  const ids = v.map((x) => x.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe) throw new Error(`${file} has a duplicate id: ${dupe}`);
  return v;
}

let queue, posted;
try {
  queue = readJsonArray('queue.json', { required: true });
  posted = readJsonArray('posted.json', { required: false });
} catch (e) {
  log(`ABORT ${e.message}`);
  process.exit(1);
}
const done = new Set(posted.map(x => x.id));

// Written before the request and cleared after the record lands, so a run that dies in
// between leaves evidence. Without it, a post the server accepted but never acknowledged
// (dropped response, timeout, a crash before posted.json is written) looks unsent, and the
// task's retry sends it again under a fresh nonce — a duplicate nobody asked for.
const PENDING = p('.pending.json');

// One place that removes it, so every path reports a failure the same way. A delete that
// fails for any reason other than "already gone" leaves a marker that stops the next run —
// silently, a day later, with nothing on screen explaining why. Three call sites used to
// swallow that; two of them by writing `catch {}`.
function dropPending() {
  try { unlinkSync(PENDING); }
  catch (e) {
    if (e.code !== 'ENOENT') log(`WARN could not clear ${PENDING}: ${e.code} — the next run will stop on it`);
  }
}

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

// The airdrop's main phase is testnet inference, not posting here — so the event worth not
// missing is the faucet opening, and that shows up in the served API surface before it
// shows up in an announcement. One unauthenticated GET. Every one of these terms is 0
// occurrences today, so any of them appearing is the signal; the path count alone is not,
// because it already moved 24 -> 25 -> 26 without a faucet.
const WATCH = ['faucet', 'testnet', 'inference', 'airdrop', 'mint'];
async function checkForTestnet() {
  try {
    // Bounded on purpose: this check must never be able to stall the post it runs before.
    // The task has no execution time limit (that is deliberate, for the exhaustion notice),
    // so a slow or endless response here would hang the run with nothing on screen.
    const res = await fetch('https://technocore.chat/openapi.json',
      { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { log(`WARN openapi check returned ${res.status}`); return null; }
    const body = await res.text();
    if (body.length > 2_000_000) { log('WARN openapi response too large to inspect'); return null; }
    const doc = JSON.parse(body);
    const paths = Object.keys(doc.paths || {}).length;
    const hay = body.toLowerCase();
    const found = WATCH.filter((w) => hay.includes(w));
    log(`openapi: ${paths} paths, watched terms ${found.length ? found.join(',') : 'none'}`);
    if (!found.length) return null;
    return [
      '  ★ technocore の API に新しい語が現れました',
      '',
      `    検出: ${found.join(', ')}`,
      `    パス数: ${paths}`,
      '',
      '    Testnet / Faucet が始まった可能性があります。',
      '    エアドロの本戦は Technocore への投稿ではなく、',
      '    Testnet での Inference 利用です。',
      '',
      '  ----------------------------------------------------------------',
      '    ただし、ここで見えたことは入口の確認にはなりません。',
      '    必ず Flop Labs 公式X または公式サイトからリンクを辿ること。',
      '    検索結果・DM・room の投稿にある URL は踏まない。',
      '  ----------------------------------------------------------------',
    ];
  } catch (e) {
    log(`WARN openapi check failed: ${e.message}`);
    return null;
  }
}
const testnetNotice = (!DRY && !process.argv.includes('status')) ? await checkForTestnet() : null;

// Everything past the openapi fetch lives in a function so it can *return* an exit code
// instead of calling process.exit(). On Windows, process.exit() after a fetch aborts the
// process with a libuv assertion and code 127 — undici still holds the connection when the
// handles are torn down. That is not cosmetic here: the scheduled task reads a non-zero
// code as failure and restarts the run, so closing the exhaustion notice would have opened
// three more of them over the next fifteen minutes. Letting the loop drain exits cleanly.
async function main() {

  // Reconcile the pending record before deciding what to do, not after choosing an item.
  // Placed later, an exhausted queue returned first and a leftover record was neither
  // cleared nor reported — it then surfaced on the next refill, about a post long since
  // written down as sent.
  if (!DRY && existsSync(PENDING)) {
    let stale = {};
    try { stale = JSON.parse(readFileSync(PENDING, 'utf8')); } catch {}

    // The record can outlive the thing it was recording: if the post was written down as
    // sent and only the delete failed, the outcome is not unknown at all. Reconcile against
    // posted.json before stopping, so a filesystem hiccup does not halt the automation and
    // ask a person to investigate something that already succeeded.
    if (stale.id && done.has(stale.id)) {
      log(`pending record for ${stale.id} is stale — it is already recorded as posted; clearing`);
      dropPending();
    } else {

    log(`ABORT a previous send of ${stale.id ?? '?'} to /r/${stale.room ?? '?'} left no result — not resending`);
    await holdOpen([
      '  ★ 前回の投稿が、結果を確認できないまま終わっています',
      '',
      `    項目: ${stale.id ?? '不明'}`,
      `    部屋: ${stale.room ?? '不明'}`,
      `    時刻: ${stale.at ?? '不明'}`,
      '',
      '    サーバ側では成功しているかもしれません。',
      '    自動で送り直すと二重投稿になり、取り消せません。',
      '',
      '  ----------------------------------------------------------------',
      '    Claude に、次のとおり伝えてください:',
      '',
      '        前回の投稿を確認して',
      '',
      '  ----------------------------------------------------------------',
    ]);
    return 1;
    }
  }

  const next = remaining[0];
  if (!next) {
    log(`IDLE queue exhausted (${posted.length} posted) — nothing to say, so saying nothing. Add items to queue.json.`);
    if (!DRY) {
      // The one line that is an instruction gets its own block. Buried in a paragraph of
      // equal-weight text it reads as prose; on its own it reads as the thing to do next.
      await holdOpen([
        ...(testnetNotice ? [...testnetNotice, '', ''] : []),
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
    return 0;
  }

  // guardrails: the queue is the only content source, and it is human-reviewed
  if (next.example) {
    log(`ABORT ${next.id} is a shipped example — replace queue.json with your own material before running`);
    console.log('\n  queue.json still holds the examples this repo ships with.\n' +
                '  They are marked "example": true so a fresh clone cannot post them by accident.\n' +
                '  Write your own items (drop the "example" field) and run again.\n');
    return 1;
  }
  // Codepoints, matching the server and the child. Counting UTF-16 units here while the
  // child counted codepoints meant an emoji cost two against the cap in one place and one in
  // the other, so a message the server would have accepted was refused before it was sent.
  if (typeof next.text !== 'string') { log(`ABORT ${next.id} has no text`); return 1; }
  if ([...next.text].length > 4096) { log(`ABORT ${next.id} exceeds 4096 characters`); return 1; }
  // Same six Unicode categories the server sweeps, plus the trim it applies. Signing text
  // the server would rewrite produces a signature that cannot verify, so catch it here
  // rather than letting the item fail on the wire and retry forever.
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u.test(next.text) || next.text !== next.text.trim()) {
    log(`ABORT ${next.id} contains characters the single-line sweep would rewrite`); return 1;
  }

  const room = next.room || 'lobby';

  // A leftover pending record means the previous run sent something and never got to write
  // down what happened. Re-sending is the wrong reflex: the server may well have stored it,
  // and a duplicate cannot be withdrawn. Stop and let a person look, rather than guessing.

  log(`POST ${next.id} -> /r/${room} (${[...next.text].length} chars)${DRY ? ' [DRY]' : ''}`);

  let out;
  try {
    if (!DRY) writeFileSync(PENDING, JSON.stringify({ id: next.id, room, at: now() }));
    out = execFileSync(process.execPath, [p('flop-agent.mjs'), 'say', room, next.text, ...(DRY ? ['--dry'] : [])],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (e) {
    const why = (e.stderr || e.message).trim().split('\n').pop();
    // Exit 2 is the child saying it refused before sending anything — a bad room name, empty
    // or oversized text. Nothing reached the server, so there is nothing to reconcile: drop
    // the pending record rather than halting every future run with a false "this may already
    // have been posted". The item still needs fixing, which is why this stops rather than
    // skipping ahead, but say what is actually wrong.
    if (e.status === 2) {
      dropPending();
      log(`ABORT ${next.id} was refused before sending: ${why} — fix the item in queue.json`);
      return 1;
    }
    // Anything else: the request may have been served and we will never know from here.
    log(`FAIL ${next.id}: ${why} — outcome unknown, not retrying automatically`);
    return 1;
  }

  if (DRY) { return 0; } // the child echoed the composed message to stderr already

  // Parse the child's stdout as the JSON it is, rather than regexing for the first thing that
  // looks like a status. The post's own body used to be printed to stdout first, so a message
  // containing the characters "status": 200 made a failed write parse as a success — and
  // "status": 429 made a success parse as rate-limited. Both reproduced. The echo now goes to
  // stderr, and this refuses to guess if stdout is not the single object it expects.
  let result;
  try {
    result = JSON.parse(out);
  } catch {
    // Same reasoning as a crashed child: the request may have been served. Keep the pending
    // record so the next run stops rather than sending a second copy.
    log(`FAIL ${next.id}: result was not parseable JSON — outcome unknown, not retrying automatically`);
    return 1;
  }

  // The server answered, so the outcome IS known — a non-200 means it did not store the
  // message, and retrying is safe. Clear the pending record on every one of these paths.
  const status = result.status;
  // Only the refusals the API actually documents are safe to retry: each of these means the
  // server declined to store the message, so sending it again cannot duplicate anything.
  // A 5xx or anything unlisted is a different claim — it may have been stored before the
  // response failed — so it is treated as unknown and keeps the pending record, exactly like
  // a dropped connection. Guessing "probably not saved" is how a duplicate gets posted, and
  // a duplicate cannot be withdrawn.
  const DECLINED = new Set([400, 403, 404, 409, 413, 422, 429]);
  if (status !== 200) {
    if (DECLINED.has(status)) {
      dropPending();
      log(`FAIL ${next.id}: status ${status} (server declined it) — will retry next run`);
    } else {
      log(`FAIL ${next.id}: status ${status} — outcome unknown, not retrying automatically`);
    }
    return 1;
  }

  // the reply's trailer names the newest seq, which is the message we just wrote
  const seq = (String(result.text || '').match(/next:\s*\/r\/[^?]+\?since=(\d+)/) || [])[1] || '?';
  posted.push({ id: next.id, room, seq, at: now() });
  // Write to a temporary file and rename, so an interrupted write cannot leave posted.json
  // truncated — the one file whose loss re-posts everything already sent.
  const tmp = p('posted.json.tmp');
  writeFileSync(tmp, JSON.stringify(posted, null, 2));
  renameSync(tmp, p('posted.json'));
  dropPending();

  log(`OK ${next.id} seq ${seq} (${remaining.length - 1} left in queue)`);

  // Post first, then hold — the post is cheap and should not be lost to a window waiting for
  // someone who is away. Shown on every run while the terms are present, not once: this is
  // the event the whole exercise is aimed at, and a notice you can miss is not a notice.
  if (testnetNotice) await holdOpen(testnetNotice);

}

process.exitCode = (await main()) ?? 0;
