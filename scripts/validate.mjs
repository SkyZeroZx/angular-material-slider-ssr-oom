#!/usr/bin/env node

// One fresh SSR worker per trial, with only that worker's V8 heap limited. Each
// worker renders the control before the measured request, so a worker that never
// served SSR cannot count as a result. The verdict comes from the worker itself:
// a V8 fatal error and a dead process, or a response and a live process.
//
//   node scripts/validate.mjs [--build=dist/fix] [--heaps=256,default] [--trials=3]
//     [--control=?max=1e2] [--candidate=?max=1e9] [--expect=fatal|survive|any]
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, relative, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const arg = (name, fallback) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const build = resolve(arg('build', 'dist/srr-material-oom'));
const buildName = relative(process.cwd(), build).replaceAll('\\', '/');
const heaps = arg('heaps', '256,1024,4096,16384,default').split(',');
const trials = Number(arg('trials', '3'));
const control = arg('control', '?max=1e2');
const candidate = arg('candidate', '?max=1e9');
const expect = arg('expect', 'fatal');

const serverDir = join(build, 'server');
const heapArgs = (heap) => (heap === 'default' ? [] : [`--max-old-space-size=${heap}`]);
const variant = detectVariant();

// Read the tick-mark code the worker will run, not the variant we meant to build.
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

async function get(port, query, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${query}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    const ms = Math.round(performance.now() - started);
    return {status: response.status, ssr: body.includes('<mat-slider'), ms};
  } catch (error) {
    return {error: error.cause?.code ?? error.name, ms: Math.round(performance.now() - started)};
  }
}

async function trial(heap, query) {
  const port = await freePort();
  const worker = spawn(process.execPath, [...heapArgs(heap), join(serverDir, 'server.mjs')], {
    env: {...process.env, PORT: String(port)},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let exit = null;
  worker.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-32_000)));
  const exited = new Promise((done) =>
    worker.once('exit', (code, signal) => done((exit = {code, signal}))),
  );
  try {
    let ready = {};
    for (let i = 0; i < 150 && !exit && !(ready.status === 200 && ready.ssr); i++) {
      ready = await get(port, control, 2_000);
      if (!ready.ssr) await sleep(100);
    }
    if (!(ready.status === 200 && ready.ssr)) {
      throw new Error(`Worker never rendered ${control}:\n${stderr}`);
    }

    const response = await get(port, query, 120_000);
    if (response.status !== 200) await Promise.race([exited, sleep(10_000)]);
    const health = exit ? {} : await get(port, control, 10_000);
    const alive = !exit && health.status === 200 && health.ssr;
    // A worker can answer and then abort on its next GC, so give it time to exit.
    if (!alive && !exit) await Promise.race([exited, sleep(30_000)]);
    const fatal = Boolean(exit) && stderr.includes('FATAL ERROR:');
    const rangeError = stderr.includes('RangeError: Invalid array length');
    const outcome = fatal
      ? 'fatal'
      : alive
        ? rangeError
          ? 'RangeError'
          : String(response.status ?? response.error)
        : exit
          ? 'crash'
          : 'hung';
    const diagnostic =
      /FATAL ERROR:[^\r\n]*|RangeError: Invalid array length/.exec(stderr)?.[0] ?? '';
    return {heap, query, outcome, ms: response.ms, response: response.status ?? response.error,
      alive, exit, diagnostic};
  } finally {
    if (!exit) worker.kill('SIGKILL');
    await Promise.race([exited, sleep(5_000)]);
  }
}

function summarize(runs) {
  const counts = {};
  for (const run of runs) counts[run.outcome] = (counts[run.outcome] ?? 0) + 1;
  const ms = runs.map((run) => run.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const outcomes = Object.entries(counts).map(([outcome, n]) => `${n}/${runs.length} ${outcome}`);
  return `${outcomes.join(', ')}, ${(ms / 1000).toFixed(1)} s`;
}

const versions = Object.fromEntries(
  ['core', 'material', 'ssr'].map((pkg) => [
    pkg,
    JSON.parse(readFileSync(`node_modules/@angular/${pkg}/package.json`, 'utf8')).version,
  ]),
);
console.log(`${variant} build, ${buildName}`);
console.log(`Node ${process.version}, Angular ${versions.core}, Material ${versions.material}`);
console.log(`${trials} fresh workers per cell\n`);

const widths = [9, 11, 24, 24];
const print = (cells) => console.log(cells.map((cell, i) => cell.padEnd(widths[i])).join(' '));
print(['heap', 'limit', control, candidate]);

const rows = [];
const results = [];
for (const heap of heaps) {
  const limit = heapLimitMiB(heap);
  const cells = [];
  for (const query of [control, candidate]) {
    const runs = [];
    for (let i = 0; i < trials; i++) runs.push(await trial(heap, query));
    results.push(...runs.map((run) => ({...run, heapLimitMiB: limit})));
    cells.push(summarize(runs));
  }
  rows.push([heap === 'default' ? 'default' : `${heap} MiB`, `${limit} MiB`, ...cells]);
  print(rows.at(-1));
}

const controls = results.filter((run) => run.query === control);
const attacks = results.filter((run) => run.query === candidate);
const passed =
  controls.every((run) => run.outcome === '200') &&
  (expect === 'any' ||
    attacks.every((run) => (expect === 'fatal' ? run.outcome === 'fatal' : run.alive)));
console.log(
  expect === 'any'
    ? '\nDone.'
    : passed
      ? `\nPASS: ${control} renders on every heap; ${candidate} ${
          expect === 'fatal' ? 'kills every worker' : 'leaves every worker alive'
        }.`
      : `\nFAIL: expected ${candidate} to be ${expect} on every heap.`,
);

const slug = candidate.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '');
// The heap list is part of the name: the same payload answers differently on
// each one, and a run must not overwrite another heap's result.
const output = `evidence/${variant}-${heaps.join('-')}-${slug}.json`;
mkdirSync('evidence', {recursive: true});
writeFileSync(
  output,
  JSON.stringify(
    {date: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
      versions, variant, build: buildName, control, candidate, trials, expect,
      passed, rows, results},
    null,
    2,
  ) + '\n',
);
console.log(`Details: ${output}`);
process.exitCode = passed ? 0 : 1;
