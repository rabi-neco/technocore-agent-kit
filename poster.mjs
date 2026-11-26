#!/usr/bin/env node
// Scheduled poster — drains a curated queue of verified notes, one per run.
// Deliberately NOT generative: it never invents a message. Queue empty => it stops
// posting rather than emitting filler. Nothing read from the network is ever posted.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
//
// Resolves true only when a person pressed a key — the one case where someone has seen it.
// The caller exits 0 then, whatever stopped the run: the task restarts on a non-zero code
// (every 5 minutes, up to 3 times — measured 2026-11-26), and a restart cannot fix anything
// a person has to fix. It only reopens the notice they just closed, three more times.
function holdOpen(lines) {
  const bar = '='.repeat(64);
  console.log(`\n${bar}\n${lines.join('\n')}\n${bar}\n`);
  if (!process.stdin.isTTY) return Promise.resolve(false);
  console.log('  何かキーを押すと閉じます\n');
  return new Promise((done) => {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => { try { process.stdin.pause(); } catch {} done(true); });
    } catch { done(false); }
  });
}

// What every notice ends with: the one thing to do, set apart so it reads as an instruction.
const tellClaude = (words) => [
  '  ----------------------------------------------------------------',
  '    Claude に、次のとおり伝えてください:',
  '',
  `        ${words}`,
  '',
  '  ----------------------------------------------------------------',
];

// A stop that needs a person used to be a log line and nothing else: the run ended, the
// next one stopped on the same thing, and nothing on screen said so.
const stoppedNotice = (title, subject, why, words) => [
  `  ★ 投稿を止めています（${title}）`,
  '',
  `    対象: ${subject}`,
  `    理由: ${why}`,
  '',
  ...tellClaude(words),
];

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
  // Before any fetch, so process.exit() is still safe here (see main() below for why later
  // exits are not). Not under status or --dry: those are someone at a prompt already.
  const asked = process.argv.includes('status') || DRY;
  const seen = asked ? false : await holdOpen(stoppedNotice(
    'queue.json か posted.json が読めません', 'queue.json / posted.json', e.message,
    'queue.json と posted.json を確認して'));
  process.exit(seen ? 0 : 1);
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

// A refresh that keeps failing was a WARN line a day, and then, on day seven, a note that
// is simply gone. Three days without a success leaves four to notice and fix it. Read after
// the refresh above, so a run that just succeeded never raises it. No marker at all is a
// first run, not a failure, and is left alone.
const DID_STALE_MS = 72 * 60 * 60 * 1000;
const DID_RECLAIM_MS = 7 * 24 * 60 * 60 * 1000;
function didStaleNotice() {
  const stamp = p('.did-refreshed');
  if (!existsSync(stamp)) return null;
  const last = Date.parse(readFileSync(stamp, 'utf8').trim());
  if (!Number.isFinite(last)) return null;
  const age = Date.now() - last;
  if (age < DID_STALE_MS) return null;
  const left = Math.max(0, Math.ceil((DID_RECLAIM_MS - age) / (24 * 60 * 60 * 1000)));
  log(`WARN DID note not refreshed since ${new Date(last).toISOString()} — about ${left} day(s) before it is reclaimed`);
  return [
    '  ★ DIDノートの更新が3日以上成功していません',
    '',
    `    最後に成功: ${new Date(last).toISOString()}`,
    `    消えるまで: 残り約${left}日（7日で回収されます）`,
    '',
    ...tellClaude('DIDノートを確認して'),
  ];
}
const didNotice = (!DRY && !process.argv.includes('status')) ? didStaleNotice() : null;

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

// Optional and local: official-watch.mjs is not part of the published kit, so a clone has
// no such file and this does nothing. Where it exists it reads the official guide and the
// faucet's /limits once a day and says when either changed. It returns a notice and a
// commit(); the commit — which records what was seen — runs only once a person has closed
// the window, so a change nobody looked at is raised again the next day.
async function watchOfficial() {
  const mod = p('official-watch.mjs');
  if (!existsSync(mod)) return null;
  try { return await (await import(pathToFileURL(mod).href)).check({ dir: DIR, log }); }
  catch (e) { log(`WARN official watch failed: ${e.message}`); return null; }
}
const official = (!DRY && !process.argv.includes('status')) ? await watchOfficial() : null;

// Everything this run has to say, gathered into one window shown at the end — not one window
// per finding, and not only on the paths that happened to hold one open before.
const notices = [official?.notice, didNotice, testnetNotice].filter(Boolean);

// Everything past the openapi fetch lives in a function so it can *return* an exit code
// instead of calling process.exit(). On Windows, process.exit() after a fetch aborts the
// process with a libuv assertion and code 127 — undici still holds the connection when the
// handles are torn down. That is not cosmetic here: the scheduled task reads a non-zero
// code as failure and restarts the run, so closing the exhaustion notice would have opened
// three more of them over the next fifteen minutes. Letting the loop drain exits cleanly.
//
// main() returns an exit code, or { code, block } when the stop needs a person — block is the
// notice for it, shown together with the run's other notices in one window at the end.
async function main() {
  // A queue item a person has to fix. The log line stays as it was; the window is new.
  const stop = (id, why) => {
    log(`ABORT ${id} ${why}`);
    return { code: 1, block: DRY ? null : stoppedNotice('キューの項目に問題があります', id, why, 'queue.json を直して') };
  };

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
    return { code: 1, block: [
      '  ★ 前回の投稿が、結果を確認できないまま終わっています',
      '',
      `    項目: ${stale.id ?? '不明'}`,
      `    部屋: ${stale.room ?? '不明'}`,
      `    時刻: ${stale.at ?? '不明'}`,
      '',
      '    サーバ側では成功しているかもしれません。',
      '    自動で送り直すと二重投稿になり、取り消せません。',
      '',
      ...tellClaude('前回の投稿を確認して'),
    ] };
    }
  }

  const next = remaining[0];
  if (!next) {
    log(`IDLE queue exhausted (${posted.length} posted) — nothing to say, so saying nothing. Add items to queue.json.`);
    // The one line that is an instruction gets its own block. Buried in a paragraph of
    // equal-weight text it reads as prose; on its own it reads as the thing to do next.
    return { code: 0, block: DRY ? null : [
      '  ★ 投稿キューが空になりました（ネタ切れ）',
      '',
      `    これまでに ${posted.length} 件を投稿済みです。`,
      '    埋め草は投稿しない設計なので、ここで停止しています。',
      '',
      ...tellClaude('キュー補充して'),
      '',
      '    補充すれば、次回ログオン時から自動で再開します。',
    ] };
  }

  // guardrails: the queue is the only content source, and it is human-reviewed
  if (next.example) {
    console.log('\n  queue.json still holds the examples this repo ships with.\n' +
                '  They are marked "example": true so a fresh clone cannot post them by accident.\n' +
                '  Write your own items (drop the "example" field) and run again.\n');
    return stop(next.id, 'is a shipped example — replace queue.json with your own material before running');
  }
  // Codepoints, matching the server and the child. Counting UTF-16 units here while the
  // child counted codepoints meant an emoji cost two against the cap in one place and one in
  // the other, so a message the server would have accepted was refused before it was sent.
  if (typeof next.text !== 'string') return stop(next.id, 'has no text');
  if ([...next.text].length > 4096) return stop(next.id, 'exceeds 4096 characters');
  // Same six Unicode categories the server sweeps, plus the trim it applies. Signing text
  // the server would rewrite produces a signature that cannot verify, so catch it here
  // rather than letting the item fail on the wire and retry forever.
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u.test(next.text) || next.text !== next.text.trim()) {
    return stop(next.id, 'contains characters the single-line sweep would rewrite');
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
      return stop(next.id, `was refused before sending: ${why} — fix the item in queue.json`);
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
  return 0;
}

// Post first, then hold — the post is cheap and should not be lost to a window waiting for
// someone who is away. The notices are shown on every run while their condition holds, not
// once: a notice you can miss is not a notice.
const r = await main();
const { code, block } = typeof r === 'number' ? { code: r, block: null } : r;
const blocks = [...notices, ...(block ? [block] : [])];
const seen = blocks.length ? await holdOpen(blocks.flatMap((b, i) => (i ? ['', '', ...b] : b))) : false;
// Record what the official watch saw only after a person has seen it (see watchOfficial).
if (seen && official?.commit) {
  try { official.commit(); } catch (e) { log(`WARN could not record the official state: ${e.message}`); }
}
process.exitCode = seen ? 0 : code;
