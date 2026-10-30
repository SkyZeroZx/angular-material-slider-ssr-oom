#!/usr/bin/env node

// Concurrency as the lever instead of magnitude. validate.mjs and fuzz.mjs ask
// how large one request must be to kill a worker; this asks how many cheap
// requests in flight together do it, which is the question that decides whether
// a production-sized heap is actually safe. Each round is a fresh worker that
// has already served the control, then N identical requests fired at once.
//
//   node scripts/amplify.mjs [--build=dist/fix] [--heaps=1024,4096]
//     [--query=?max=5e7] [--levels=1,2,4,8] [--rounds=3]
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, relative, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const arg = (name, fallback) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const build = resolve(arg('build', 'dist/srr-material-oom'));
const buildName = relative(process.cwd(), build).replaceAll('\\', '/');
const heaps = arg('heaps', '1024,4096').split(',');
const query = arg('query', '?max=5e7');
const levels = arg('levels', '1,2,4,8')
  .split(',')
  .map(Number);
const rounds = Number(arg('rounds', '3'));
const control = arg('control', '?max=1e2');
const timeoutMs = Number(arg('timeout', '180000'));
// Fire and forget: send, wait this many ms, abort the socket, never read a byte
// of the answer. The question it asks is whether the render outlives the client,
// because if it does the sender's cost is the request and nothing else.
const abortAfterMs = Number(arg('abort', '0'));

const serverDir = join(build, 'server');
const heapArgs = (heap) => (heap === 'default' ? [] : [`--max-old-space-size=${heap}`]);

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

function heapLimitMiB(heap) {
  const {stdout} = spawnSync(
    process.execPath,
    [...heapArgs(heap), '-p', "require('v8').getHeapStatistics().heap_size_limit"],
    {encoding: 'utf8'},
  );
  return Math.round(Number(stdout) / 2 ** 20);
}

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const {port} = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function get(port, path, ms) {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
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

async function start(heap) {
  const port = await freePort();
  const proc = spawn(process.execPath, [...heapArgs(heap), join(serverDir, 'server.mjs')], {
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

// Send `n` requests, abort every socket after `abortAfterMs`, read nothing.
async function fireAndForget(port, n) {
  const controllers = Array.from({length: n}, () => new AbortController());
  const inflight = controllers.map((c) =>
    fetch(`http://127.0.0.1:${port}/${query}`, {signal: c.signal}).then(
      () => 'answered',
      () => 'aborted',
    ),
  );
  await sleep(abortAfterMs);
  for (const c of controllers) c.abort();
  return Promise.all(inflight);
}

// One round: a clean worker, then `n` identical requests in flight together.
async function round(heap, n) {
  const worker = await start(heap);
  try {
    const started = performance.now();
    const responses = abortAfterMs
      ? (await fireAndForget(worker.port, n)).map((outcome) => ({error: outcome}))
      : await Promise.all(Array.from({length: n}, () => get(worker.port, query, timeoutMs)));
    const ms = Math.round(performance.now() - started);
    if (!worker.exit) await Promise.race([worker.exited, sleep(10_000)]);
    const health = worker.exit ? {} : await get(worker.port, control, 10_000);
    const alive = !worker.exit && health.status === 200 && health.ssr;
    if (!alive && !worker.exit) await Promise.race([worker.exited, sleep(30_000)]);
    const fatal = Boolean(worker.exit) && worker.stderr.includes('FATAL ERROR:');
    const rangeError = worker.stderr.includes('RangeError: Invalid array length');
    const outcome = fatal
      ? 'fatal'
      : alive
        ? rangeError
          ? 'RangeError'
          : '200'
        : worker.exit
          ? 'crash'
          : 'hung';
    return {
      outcome,
      ms,
      served: responses.filter((r) => r.status === 200).length,
      lost: responses.filter((r) => r.status !== 200).length,
      diagnostic: /FATAL ERROR:[^\r\n]*/.exec(worker.stderr)?.[0] ?? '',
    };
  } finally {
    await stop(worker);
  }
}

const versions = Object.fromEntries(
  ['core', 'material'].map((pkg) => [
    pkg,
    JSON.parse(readFileSync(`node_modules/@angular/${pkg}/package.json`, 'utf8')).version,
  ]),
);
console.log(`${variant} build, ${buildName}`);
console.log(`Node ${process.version}, Angular ${versions.core}, Material ${versions.material}`);
console.log(
  abortAfterMs
    ? `${query} at once, aborted after ${abortAfterMs}ms, ${rounds} fresh workers per cell\n`
    : `${query} at once, ${rounds} fresh workers per cell\n`,
);

const widths = [11, 11, ...levels.map(() => 20)];
const print = (cells) => console.log(cells.map((cell, i) => cell.padEnd(widths[i])).join(' '));
print(['heap', 'limit', ...levels.map((n) => `${n} in flight`)]);

const results = [];
for (const heap of heaps) {
  const limit = heapLimitMiB(heap);
  const cells = [];
  for (const n of levels) {
    const runs = [];
    for (let i = 0; i < rounds; i++) runs.push(await round(heap, n));
    results.push(...runs.map((run) => ({...run, heap, heapLimitMiB: limit, concurrency: n})));
    const counts = {};
    for (const run of runs) counts[run.outcome] = (counts[run.outcome] ?? 0) + 1;
    const ms = runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    cells.push(
      `${Object.entries(counts)
        .map(([name, c]) => `${c}/${runs.length} ${name}`)
        .join(', ')}, ${(ms / 1000).toFixed(1)}s`,
    );
  }
  print([heap === 'default' ? 'default' : `${heap} MiB`, `${limit} MiB`, ...cells]);
}

// The cheapest concurrency that killed every round, per heap.
console.log('');
for (const heap of heaps) {
  const threshold = levels.find((n) =>
    results
      .filter((r) => r.heap === heap && r.concurrency === n)
      .every((r) => r.outcome === 'fatal'),
  );
  console.log(
    threshold
      ? `${heap}: ${threshold} concurrent ${query} killed the worker in every round.`
      : `${heap}: no tested concurrency of ${query} killed it in every round.`,
  );
}

mkdirSync('evidence', {recursive: true});
const slug = query.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '');
// The heap list is part of the name: the same payload answers differently on
// each one, and a run must not overwrite another heap's result.
const mode = abortAfterMs ? `-abort${abortAfterMs}` : '';
const output = `evidence/amplify-${variant}-${heaps.join('-')}-${slug}${mode}.json`;
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
      query,
      control,
      heaps,
      levels,
      rounds,
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Details: ${output}`);
