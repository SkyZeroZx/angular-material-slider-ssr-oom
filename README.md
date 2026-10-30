# Angular Material slider SSR OOM lab

Minimal reproduction on Angular **22.2.4** and Material **22.2.5** with Node **24.16.0**, using a production build served by `AngularNodeAppEngine` on a `RenderMode.Server` route.

When a `<mat-slider>` with `showTickMarks` takes its numbers from the request, one GET is enough to kill the Node worker that renders it. No auth and no body, only the query string.

## Cause

`ngAfterViewInit()` measures the slider only in the browser, but builds the tick marks on the server too ([`slider.ts#L438-L466`](https://github.com/angular/components/blob/v22.2.5/src/material/slider/slider.ts#L438-L466)):

```ts
if (this._platform.isBrowser) {
  this._updateDimensions();
}
// ...
this._updateTickMarkUI();
```

With one thumb, `_updateTickMarkUINonRange()` allocates one entry per step ([`#L887-L896`](https://github.com/angular/components/blob/v22.2.5/src/material/slider/slider.ts#L887-L896)):

```ts
let numActive = Math.max(Math.round((value - this.min) / step), 0) + 1;
let numInactive = Math.max(Math.round((this.max - value) / step), 0) - 1;
this._isRtl() ? numActive++ : numInactive++;

this._tickMarks = Array(numActive)
  .fill(_MatTickMark.ACTIVE)
  .concat(Array(numInactive).fill(_MatTickMark.INACTIVE));
```

With two thumbs, `_updateTickMarkUIRange()` builds three arrays and a fourth from `concat` ([`#L898-L911`](https://github.com/angular/components/blob/v22.2.5/src/material/slider/slider.ts#L898-L911)):

```ts
const numInactiveBeforeStartThumb = Math.max(Math.round((startValue - this.min) / step), 0);
const numActive = Math.max(Math.round((endValue - startValue) / step) + 1, 0);
const numInactiveAfterEndThumb = Math.max(Math.round((this.max - endValue) / step), 0);
```

The template renders them only `@if (_cachedWidth)` ([`slider.html#L12`](https://github.com/angular/components/blob/v22.2.5/src/material/slider/slider.html#L12)), which the server never sets. So during SSR the whole array is built and never rendered.

Nothing bounds the count. The obvious term is `(max - min) / step`, but the thumbs size it too: `_getValue()` returns the input's value without clamping it to `[min, max]`, so `value`, `start` or `end` alone can ask for a billion entries while `min`, `max` and `step` stay at their defaults.

[#26322](https://github.com/angular/components/pull/26322) fixed [#26317](https://github.com/angular/components/issues/26317) by skipping the array when `showTickMarks` is off. With it on, the count is still unbounded, and [#29496](https://github.com/angular/components/issues/29496) is the browser side of it. `main` and 22.3.0-next.4 have the same code.

## Route

[`price-range.ts`](src/app/price-range/price-range.ts) binds a single-thumb slider to the query string, the way a price filter would:

```ts
readonly min = Number(this.params.get('min') ?? '0');
readonly max = Number(this.params.get('max') ?? '100');
readonly step = Number(this.params.get('step') ?? '1');
readonly value = Number(this.params.get('value') ?? '0');
readonly show = this.params.get('show') !== '0';
```

[`price-band.ts`](src/app/price-band/price-band.ts) is the range version on `/band`, with `start` (default `0`) and `end` (default `100`) instead of `value`. Every route is `RenderMode.Server`. There is no guard, resolver, backend call or artificial delay.

## Results

### One request

Fresh worker per run, 3 runs per cell, and every cell was unanimous. `fatal` is a V8 `FATAL ERROR` with exit code 134, and every other request in flight on that worker is lost with it. Heap sizes are `--max-old-space-size`.

| Request                                | Query bytes |         Ticks | 512 MiB   | 1 GiB        | Evidence                                                                                         |
| -------------------------------------- | ----------: | ------------: | --------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `/?max=1e9`                            |           8 | 1,000,000,001 | **fatal** | **fatal**    | [512](evidence/stock-512-max-1e9.json), [1024](evidence/stock-max-1e9.json)                      |
| `/?value=1e9`                          |          10 | 1,000,000,001 | **fatal** | **fatal**    | [512](evidence/fuzz-stock-512-thumb_only.json), [1024](evidence/fuzz-stock-1024-thumb_only.json) |
| `/band?start=1e9`                      |          10 | 1,000,000,000 | **fatal** | **fatal**    | [512](evidence/stock-512-band-start-1e9.json), [1024](evidence/stock-band-start-1e9.json)        |
| `/?max=86400&step=0.001`               |          21 |    86,400,001 | **fatal** | 200 in 6.8 s | [512](evidence/fuzz-stock-512-realistic.json), [1024](evidence/fuzz-stock-1024-realistic.json)   |
| `/?max=1000000&step=0.01`              |          22 |   100,000,001 | **fatal** | 200 in 7.3 s | [512](evidence/fuzz-stock-512-realistic.json), [1024](evidence/fuzz-stock-1024-realistic.json)   |
| `/?min=-1000000&max=1000000&step=0.01` |          35 |   200,000,001 | **fatal** | **fatal**    | [512](evidence/fuzz-stock-512-realistic.json), [1024](evidence/fuzz-stock-1024-realistic.json)   |

The last three are the ones I would worry about. 86400 is a day in seconds and 0.001 is a millisecond. 1000000 is a price and 0.01 is a cent. Neither number stands out in a code review, but what gets allocated is their ratio, and nobody reviews the ratio.

Validating `max` doesn't save you either. `/?value=1e9&max=100` pins `max` to its default and still kills both heaps ([512](evidence/fuzz-stock-512-thumb_only.json), [1024](evidence/fuzz-stock-1024-thumb_only.json)), and `/band?start=1e9` doesn't touch `min`, `max` or `step` at all. `value` is also the parameter most likely to end up in a shared URL, since it is the user's own selection.

### Heap size

A bigger heap doesn't help. `npm run validate` on `?max=1e9` ([`stock-max-1e9.json`](evidence/stock-max-1e9.json)):

```text
heap      limit       ?max=1e2                 ?max=1e9
256 MiB   448 MiB     3/3 200, 0.0 s           3/3 fatal, 3.0 s
1024 MiB  1216 MiB    3/3 200, 0.0 s           3/3 fatal, 5.5 s
4096 MiB  4288 MiB    3/3 200, 0.0 s           3/3 fatal, 5.8 s
16384 MiB 16576 MiB   3/3 200, 0.0 s           3/3 fatal, 5.6 s
default   4288 MiB    3/3 200, 0.0 s           3/3 fatal, 5.6 s
```

On 256 MiB the worker simply runs out of heap. From 1 GiB up it fails before that:

```text
FATAL ERROR: invalid table size Allocation failed - JavaScript heap out of memory
```

Above 2^25 entries the array stays in dictionary mode, and from about 2.5e8 entries the dictionary hits V8's hash-table size limit before the heap is full ([`fuzz-stock-1024-all.json`](evidence/fuzz-stock-1024-all.json)). That is why 16 GiB dies the same way 1 GiB does.

### Without a crash

A count too small to exhaust the heap still blocks the worker, because the array is built on the one thread that serves every request. `npm run block` measures what another user on the same worker sees while one `?max=5e7` renders, on the default 4,288 MiB heap ([`block-stock-default-max-5e7.json`](evidence/block-stock-default-max-5e7.json)):

|                                     |              |
| ----------------------------------- | -----------: |
| Response                            |          200 |
| Logged                              |      nothing |
| Worker                              |        alive |
| Another user's latency, idle        |        25 ms |
| Another user's latency, during      | **3,639 ms** |
| Requests per second to keep it busy |     **0.28** |

One request every 3.6 seconds keeps the worker from serving anyone else, and nothing in the logs looks wrong. This costs CPU, not memory, so a bigger heap changes nothing. 50,000,000 is an ordinary price ceiling in IDR, COP, VND or CLP.

The cost is not linear. Same worker, same heap, 3 fresh workers per value ([`block-stock-default-max-*.json`](evidence/)):

| `?max=`        | Worker busy for |
| -------------- | --------------: |
| `1000000`      |          0.01 s |
| `20000000`     |          0.10 s |
| `33554432`     |          0.16 s |
| **`34000000`** |       **2.8 s** |
| `50000000`     |           3.6 s |

`33554432` is 2^25, the same boundary as above. Raising a ceiling from 33 to 34 million is 1.3% more range for 17 times the work, and nothing about that edit looks dangerous.

### Concurrent requests

The renders run one after the other on the same thread, but the previous array isn't collected before the next one is reserved, so N requests in flight can hold N arrays. `npm run amplify` fires N identical requests at a fresh worker, 3 workers per cell, all unanimous.

`?max=5e7` ([512 MiB and 1 GiB](evidence/amplify-stock-1024-512-max-5e7.json), [default](evidence/amplify-stock-default-max-5e7.json)):

| Heap               | 1   | 2         | 4         | 8   |
| ------------------ | --- | --------- | --------- | --- |
| 512 MiB            | 200 | **fatal** | **fatal** |     |
| 1 GiB              | 200 | 200       | **fatal** |     |
| default, 4,288 MiB | 200 | 200       | 200       | 200 |

The default heap survives 8, but the last of those answers arrives after about 28 seconds.

On 1 GiB the value doesn't need to be that large ([`1e7`](evidence/amplify-stock-1024-max-1e7.json), [`2e7`](evidence/amplify-stock-1024-max-2e7.json), [`34000000`](evidence/amplify-stock-1024-max-34000000.json)):

| `?max=`    | 2   | 4         | 8         |
| ---------- | --- | --------- | --------- |
| `10000000` | 200 | 200       | 200       |
| `20000000` | 200 | 200       | **fatal** |
| `34000000` | 200 | **fatal** | **fatal** |

Four people using the same price filter at the same time are enough for a 1 GiB worker. Nobody has to be attacking it.

Closing the connection doesn't help, because the render outlives the client. With `--abort` the script closes each socket after N ms and never reads the answer. `?value=1e9` on 1 GiB still killed the worker 3/3 at 50, 10 and 1 ms ([50](evidence/amplify-stock-1024-value-1e9-abort50.json), [10](evidence/amplify-stock-1024-value-1e9-abort10.json), [1](evidence/amplify-stock-1024-value-1e9-abort1.json)), so a timeout on the caller's side mitigates nothing.

## Fix

Return early from `_updateTickMarkUI()` until `_cachedWidth` is set, which the template already requires:

```diff
- if (!this.showTickMarks || this.step === undefined || ...) {
+ if (!this.showTickMarks || !this._cachedWidth || this.step === undefined || ...) {
```

`npm run variants` builds it into `dist/fix`. It sits ahead of the `_isRange` branch, so it covers both methods. With it, every payload in this lab answers 200 in under 50 ms and the worker stays up:

- All 65 payloads in the sweep ([`all`](evidence/fuzz-fix-256-all.json), [`realistic`](evidence/fuzz-fix-512-realistic.json), [`thumb_only`](evidence/fuzz-fix-1024-thumb_only.json), [`thumb`](evidence/fuzz-fix-1024-thumb.json)).
- The range slider on `/band` ([`start=1e9`](evidence/fix-band-start-1e9.json), [`start=1e9&end=-1e9`](evidence/fix-band-start-1e9-end--1e9.json), [`start=-1e9&end=1e9`](evidence/fix-1024-band-start--1e9-end-1e9.json), [`min=-1e9&max=2e9`](evidence/fix-band-min--1e9-max-2e9-start-0-end-1e9.json), [`max=86400&step=0.001`](evidence/fix-band-max-86400-step-0.001.json), [`max=1000000&step=0.01`](evidence/fix-1024-band-max-1000000-step-0.01.json)).
- `?max=1e9` on every heap ([`fix-max-1e9.json`](evidence/fix-max-1e9.json)).
- `?max=5e7` takes 7 ms instead of 3.6 s, so nobody else waits ([`block-fix-default-max-5e7.json`](evidence/block-fix-default-max-5e7.json)).

It only covers the server. Once the browser has a width it builds the same array, which is [#29496](https://github.com/angular/components/issues/29496). A complete fix bounds the counts that actually get reserved. Bounding `(max - min) / step` is not enough on its own, because `value`, `start` and `end` aren't clamped to that range.

## Scope

It needs request-time SSR (`RenderMode.Server`), `showTickMarks` on, and `min`, `max`, `step`, `value`, `start` or `end` coming from the request. Values from a CMS or an API reach the same inputs, but then you need write access to those. Prerendered routes aren't rendered per request.

Filtering the input string doesn't work. `?max=1E9`, `?max=+1e9`, `?max=%201e9`, `?max=1e%2B9` and `?max=0x3B9ACA00` all reach the same sink and are fatal 3/3 on 256 MiB ([`fuzz-stock-256-all.json`](evidence/fuzz-stock-256-all.json)), so a pattern that catches scientific notation still lets the hex through.

What doesn't kill it, from the same sweep:

- Malformed input. `?max=abc`, `?step=abc`, `?max=-1e9` and `?step=-1` answer 200, because a `NaN` or negative count never allocates.
- `?max=1e9&show=0`, with tick marks off.
- Counts above 2^32 - 1. `?max=4294967296`, `?max=1e308`, `?max=Infinity` and `?step=1e-309` throw `RangeError: Invalid array length` before allocating anything. The error is logged, the page still answers 200 and the worker stays up.

Near the limit the result isn't monotonic. On 1 GiB, `?max=2e8` is a `RangeError` 5/5 while `?max=1.3e8` and `?max=2.5e8` are fatal 5/5 ([`fuzz-stock-1024-all.json`](evidence/fuzz-stock-1024-all.json)). Don't take one value that survives as proof that the ones around it do.

## Run it

```bash
npm ci
npm run build
npm run validate
```

Every trial is a fresh worker with only its own `--max-old-space-size`, and it renders the control before the measured request, so a worker that never served SSR can't count as a result. The verdict comes from the worker itself: a V8 fatal error and a dead process, or an answer and a live one. Results land in [`evidence/`](evidence/).

| Command            | What it answers                                       |
| ------------------ | ----------------------------------------------------- |
| `npm run validate` | does one payload kill a worker, across heaps          |
| `npm run fuzz`     | which payloads kill a worker, across the query string |
| `npm run block`    | what one payload costs everybody else                 |
| `npm run amplify`  | what concurrency does that one request does not       |
| `npm run variants` | builds `dist/fix`                                     |

The commands behind each result:

| Result                      | Command                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `?max=1e9` across heaps     | `node scripts/validate.mjs`                                                           |
| `?max=1e9` on 512 MiB       | `node scripts/validate.mjs --heaps=512`                                               |
| `/band?start=1e9`           | `node scripts/validate.mjs --heaps=512,1024 "--candidate=band?start=1e9"`             |
| `value` and realistic pairs | `node scripts/fuzz.mjs --heap=512 --corpus=thumb_only` (also `realistic`, and `1024`) |
| Blocking without a crash    | `node scripts/block.mjs` (`?max=5e7`; `"--attack=?max=34000000"` for the cliff)       |
| Concurrency, `?max=5e7`     | `node scripts/amplify.mjs --heaps=512,1024 --levels=1,2,4` (also `--heaps=default`)   |
| Concurrency, smaller values | `node scripts/amplify.mjs --heaps=1024 --levels=2,4,8 "--query=?max=2e7"`             |
| Closing the socket          | `node scripts/amplify.mjs --heaps=1024 --levels=1 "--query=?value=1e9" --abort=50`    |
| The fix                     | `npm run variants`, then add `--build=dist/fix` to any of the above                   |

`npm run fuzz` now has 65 payloads in nine groups. The `fuzz-*-all.json` files were recorded before `realistic`, `thumb_only` and `thumb` were added, so they hold the first 46, and those three groups have their own files.

By hand, with `curl.exe` because PowerShell aliases `curl`:

```powershell
npm run build
npm run serve:ssr:srr-material-oom
curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost:4000/?max=1e2"
curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost:4000/?max=1e9"
```

`200`, then `000` after about five seconds while the server prints the fatal error.

## Environment

```text
Node.js:   24.16.0, Windows 11 x64
Angular:   22.2.4 production build, RenderMode.Server
Material:  22.2.5
SSR:       @angular/ssr 22.2.5, AngularNodeAppEngine + Express 5.3.0
```

I also tried `?max=1e9` on fresh `ng new --ssr` apps with Angular 21.2.25 / Material 21.2.14 and Angular 20.3.34 / Material 20.2.14. It was fatal 9/9 on each, across 256 MiB, 1 GiB and the default heap. Those runs aren't in `evidence/`.
