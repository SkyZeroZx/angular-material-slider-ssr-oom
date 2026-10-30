#!/usr/bin/env node

// Offensive sweep over the query string a request controls. Unlike validate.mjs,
// which proves one payload on many heaps, this hunts for payloads: it reuses a
// worker while payloads are cheap and survive, respawns after anything that is
// slow, errored or fatal, and re-proves every kill on a worker of its own. A
// payload only counts as a kill when a fresh worker, which has already served
// the control, dies on it.
//
//   node scripts/fuzz.mjs [--build=dist/fix] [--heap=256] [--confirm=3]
//     [--corpus=all] [--control=?max=1e2] [--slow=1000] [--timeout=60000]
import {spawn} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, relative, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const arg = (name, fallback) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const build = resolve(arg('build', 'dist/srr-material-oom'));
const buildName = relative(process.cwd(), build).replaceAll('\\', '/');
const heap = arg('heap', '256');
const confirmRuns = Number(arg('confirm', '3'));
const corpusName = arg('corpus', 'all');
const control = arg('control', '?max=1e2');
const slowMs = Number(arg('slow', '1000'));
const timeoutMs = Number(arg('timeout', '60000'));

const serverDir = join(build, 'server');
const heapArgs = heap === 'default' ? [] : [`--max-old-space-size=${heap}`];

function detectVariant() {
  for (const file of readdirSync(serverDir).filter((name) => name.endsWith('.mjs'))) {
    const code = readFileSync(join(serverDir, file), 'utf8');
    if (!code.includes('_updateTickMarkUI(){')) continue;
    return code.includes('_updateTickMarkUI(){if(!this.showTickMarks||!this._cachedWidth')
      ? 'fix'
      : 'stock';
  }
  throw new Error(`No slider code in ${serverDir}. Run npm run build first.`);
}
const variant = detectVariant();

// Each entry is one thing an attacker can say in the query string. `why` records
// the intent so a result can be read without re-deriving the arithmetic.
const CORPUS = {
  // Plain magnitude on the one parameter this app defaults into range.
  magnitude: [
    ['?max=1e7', 'ten million ticks'],
    ['?max=3e7', 'thirty million, just under 2^25'],
    ['?max=5e7', 'fifty million'],
    ['?max=1.3e8', 'last size V8 keeps as a regular array'],
    ['?max=2e8', 'past the regular-array limit'],
    ['?max=2.5e8', 'start of the dictionary-elements band'],
    ['?max=1e9', 'the published candidate'],
    ['?max=4294967294', 'one below 2^32 - 1, V8 max array length'],
    ['?max=4294967295', '2^32 - 1 exactly'],
    ['?max=4294967296', 'one past the array-length limit'],
    ['?max=9007199254740991', 'Number.MAX_SAFE_INTEGER'],
    ['?max=1e308', 'near Number.MAX_VALUE'],
  ],
  // Values that are not finite counts at all, where the guard is arithmetic.
  nonfinite: [
    ['?max=1e400', 'overflows to Infinity'],
    ['?max=Infinity', 'Infinity by name'],
    ['?min=-1e400', 'negative Infinity as the lower bound'],
    ['?max=abc', 'NaN from an unparsable max'],
    ['?max=', 'empty max, Number("") is 0'],
    ['?step=abc', 'NaN step'],
    ['?step=0', 'zero step, the slider falls back to 1'],
    ['?step=-1', 'negative step, a negative count'],
    ['?max=-1e9', 'max below min, a negative count'],
  ],
  // The denominator is the cheaper lever: small step, not large max.
  step: [
    ['?step=1e-3', 'a hundred thousand ticks'],
    ['?step=1e-5', 'ten million ticks'],
    ['?step=4e-6', 'twenty-five million ticks'],
    ['?step=1e-6', 'a hundred million ticks'],
    ['?step=1e-7', 'a billion ticks, 10 bytes'],
    ['?step=1e-9', 'a hundred billion ticks'],
    ['?step=5e-324', 'Number.MIN_VALUE, the smallest denormal'],
    ['?step=1e-309', 'denormal, 100/step rounds to Infinity'],
  ],
  // Two parameters instead of one: does the span multiply the cost.
  combo: [
    ['?min=-1e9&max=1e9', 'two billion ticks from both ends'],
    ['?min=-1e308&max=1e308', 'the widest finite span'],
    ['?max=1e4&step=1e-5', 'a billion from a modest max and a small step'],
    ['?min=-1e9&max=1e9&step=1e-3', 'span and step together'],
    ['?max=1e9&value=1e9', 'large value alongside large max'],
    ['?max=1e9&show=1', 'ticks named explicitly'],
  ],
  // Does the documented off switch actually hold, and does parsing respect it.
  control_off: [
    ['?max=1e9&show=0', 'the documented off switch'],
    ['?max=1e9&show=0&show=1', 'repeated key, last wins in Angular'],
    ['?max=1e9&SHOW=0', 'wrong case, not the recognised key'],
    ['?max=1e9&show=false', 'truthy string, ticks stay on'],
    ['?max=1e9&show=%30', 'percent-encoded zero'],
  ],
  // Pairs a real application would hold. Neither number is remarkable on its
  // own; the tick count is their ratio, and nothing reviews the ratio.
  realistic: [
    ['?max=100000&step=0.01', '0 to 100k at cent precision, 10M ticks'],
    ['?max=1000000&step=0.01', '0 to 1M at cent precision, 100M ticks'],
    ['?max=1000000&step=0.1', '0 to 1M at ten-cent precision, 10M ticks'],
    ['?max=86400&step=0.001', 'a day in seconds at millisecond precision, 86M ticks'],
    ['?max=31536000&step=1', 'a year in seconds, 31.5M ticks, just under the cliff'],
    ['?max=100&step=0.00001', '0 to 100 at five decimals, 10M ticks'],
    ['?min=-1000000&max=1000000&step=0.01', 'a signed offset at cent precision, 200M ticks'],
    ['?max=34000000&step=1', 'an IDR or COP price ceiling, one step past the cliff'],
  ],
  // _getValue() returns input.value with no clamp to [min, max], and the counts
  // are differences against it, so the thumb alone sets the size. max stays at
  // this app's default 100 in every one of these. It is also the parameter an
  // app is likeliest to put in a shareable URL, being the user's own selection.
  thumb_only: [
    ['?value=1e6', 'a million ticks from the thumb alone'],
    ['?value=5e7', 'fifty million, 10 bytes, max still 100'],
    ['?value=-5e7', 'fifty million below the floor'],
    ['?value=1e9', 'a billion ticks, 10 bytes, max still 100'],
    ['?value=-1e9', 'a billion below the floor'],
    ['?value=34000000', 'one step past the cliff from the thumb alone'],
    ['?value=1e9&max=100', 'max pinned to its default, explicitly'],
  ],
  // The thumb splits the array in two before concat. Does where it sits cost more.
  thumb: [
    ['?max=34000000&value=0', 'thumb at the floor, one large array'],
    ['?max=34000000&value=17000000', 'thumb centred, two arrays then concat'],
    ['?max=34000000&value=34000000', 'thumb at the ceiling'],
    ['?max=34000000&value=-1e9', 'thumb below the floor'],
  ],
  // Number() is lenient; the query layer may hand over shapes code did not expect.
  parsing: [
    ['?max=+1e9', 'leading plus'],
    ['?max=%201e9', 'leading space, Number trims'],
    ['?max=0x3B9ACA00', 'hex literal for 1e9'],
    ['?max=1E9', 'capital exponent'],
    ['?max=1e%2B9', 'percent-encoded plus in the exponent'],
    ['?max=1e9%00', 'trailing NUL'],
  ],
};

const corpus =
  corpusName === 'all'
    ? Object.entries(CORPUS).flatMap(([group, items]) =>
        items.map(([query, why]) => ({group, query, why})),
      )
    : (CORPUS[corpusName] ?? []).map(([query, why]) => ({group: corpusName, query, why}));
if (!corpus.length) {
  throw new Error(`Unknown corpus ${corpusName}. Try: all, ${Object.keys(CORPUS).join(', ')}`);
}

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const {port} = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function get(port, query, ms) {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${query}`, {
      signal: AbortSignal.timeout(ms),
    });
    const body = await response.text();
    return {
      status: response.status,
      ssr: body.includes('<mat-slider'),
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {error: error.cause?.code ?? error.name, ms: Math.round(performance.now() - started)};
  }
}

// A worker that has not yet rendered the control cannot produce a result.
async function start() {
  const port = await freePort();
  const proc = spawn(process.execPath, [...heapArgs, join(serverDir, 'server.mjs')], {
    env: {...process.env, PORT: String(port)},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const worker = {proc, port, stderr: '', exit: null};
  proc.stderr.on('data', (chunk) => (worker.stderr = (worker.stderr + chunk).slice(-32_000)));
  worker.exited = new Promise((done) =>
    proc.once('exit', (code, signal) => done((worker.exit = {code, signal}))),
  );
  let ready = {};
  for (let i = 0; i < 150 && !worker.exit && !(ready.status === 200 && ready.ssr); i++) {
    ready = await get(port, control, 2_000);
    if (!ready.ssr) await sleep(100);
  }
  if (!(ready.status === 200 && ready.ssr)) {
    await stop(worker);
    throw new Error(`Worker never rendered ${control}:\n${worker.stderr}`);
  }
  return worker;
}

async function stop(worker) {
  if (!worker.exit) worker.proc.kill('SIGKILL');
  await Promise.race([worker.exited, sleep(5_000)]);
}

// One payload against one live worker. Returns the outcome and whether the
// worker is still trustworthy for the next payload.
async function hit(worker, query) {
  const before = worker.stderr.length;
  const response = await get(worker.port, query, timeoutMs);
  if (response.status !== 200) await Promise.race([worker.exited, sleep(10_000)]);
  const health = worker.exit ? {} : await get(worker.port, control, 10_000);
  const alive = !worker.exit && health.status === 200 && health.ssr;
  // A worker can answer and then abort on its next GC, so give it time to exit.
  if (!alive && !worker.exit) await Promise.race([worker.exited, sleep(30_000)]);
  const fresh = worker.stderr.slice(before);
  const fatal = Boolean(worker.exit) && worker.stderr.includes('FATAL ERROR:');
  const rangeError = fresh.includes('RangeError: Invalid array length');
  const outcome = fatal
    ? 'fatal'
    : alive
      ? rangeError
        ? 'RangeError'
        : response.ms >= slowMs
          ? 'slow'
          : String(response.status ?? response.error)
      : worker.exit
        ? 'crash'
        : 'hung';
  const diagnostic = /FATAL ERROR:[^\r\n]*|RangeError: Invalid array length/.exec(fresh)?.[0] ?? '';
  return {
    outcome,
    ms: response.ms,
    response: response.status ?? response.error,
    diagnostic,
    reusable: alive && outcome === '200',
  };
}

// A kill is only a kill if a worker that has served nothing else dies on it.
async function confirm(query, runs) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    const worker = await start();
    try {
      results.push(await hit(worker, query));
    } finally {
      await stop(worker);
    }
  }
  const counts = {};
  for (const run of results) counts[run.outcome] = (counts[run.outcome] ?? 0) + 1;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  return {runs: results.length, counts, ms, diagnostic: results.find((r) => r.diagnostic)?.diagnostic ?? ''};
}

const versions = Object.fromEntries(
  ['core', 'material'].map((pkg) => [
    pkg,
    JSON.parse(readFileSync(`node_modules/@angular/${pkg}/package.json`, 'utf8')).version,
  ]),
);
console.log(`${variant} build, ${buildName}, heap ${heap} MiB`);
console.log(`Node ${process.version}, Angular ${versions.core}, Material ${versions.material}`);
console.log(
  `${corpus.length} payloads, corpus ${corpusName}, kills re-proved on ${confirmRuns} fresh workers\n`,
);
console.log(`${'payload'.padEnd(34)} ${'outcome'.padEnd(18)} ${'ms'.padStart(7)}  why`);
console.log('-'.repeat(104));

const results = [];
let worker = await start();
try {
  for (const {group, query, why} of corpus) {
    if (!worker || worker.exit) {
      if (worker) await stop(worker);
      worker = await start();
    }
    const run = await hit(worker, query);
    let confirmed = null;
    if (run.outcome !== '200') {
      // Anything off the happy path gets clean workers before it is believed.
      // Every non-200 outcome gets the full count, not just the fatal ones: on a
      // larger heap the same payload alternates between fatal and RangeError,
      // and a single run cannot tell a reliable kill from a coin flip.
      await stop(worker);
      worker = null;
      confirmed = await confirm(query, confirmRuns);
    } else if (!run.reusable) {
      await stop(worker);
      worker = null;
    }
    const verdict = confirmed
      ? Object.entries(confirmed.counts)
          .map(([name, n]) => `${n}/${confirmed.runs} ${name}`)
          .join(', ')
      : run.outcome;
    results.push({group, query, why, ...run, confirmed});
    const flag = verdict.includes('fatal') ? ' <= KILL' : '';
    console.log(
      `${query.padEnd(34)} ${verdict.padEnd(18)} ${String(confirmed?.ms ?? run.ms).padStart(7)}  ${why}${flag}`,
    );
  }
} finally {
  if (worker) await stop(worker);
}

const kills = results.filter((r) => (r.confirmed ? r.confirmed.counts.fatal : r.outcome === 'fatal'));
console.log(`\n${kills.length} of ${results.length} payloads killed a fresh worker on ${heap} MiB.`);
for (const kill of kills) console.log(`  ${kill.query}  ${kill.why}`);

mkdirSync('evidence', {recursive: true});
const output = `evidence/fuzz-${variant}-${heap}-${corpusName}.json`;
writeFileSync(
  output,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      versions,
      variant,
      build: buildName,
      heap,
      control,
      corpus: corpusName,
      confirmRuns,
      slowMs,
      timeoutMs,
      kills: kills.map((k) => k.query),
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Details: ${output}`);
