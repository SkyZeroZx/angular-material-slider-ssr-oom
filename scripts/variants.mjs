#!/usr/bin/env node

// Builds dist/fix from the installed Material bundle, then puts the published
// bundle back. Each edit must match exactly once, or nothing is built.
//
//   node scripts/variants.mjs [fix]
import assert from 'node:assert/strict';
import {execSync} from 'node:child_process';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';

const bundle = 'node_modules/@angular/material/fesm2022/slider.mjs';
const published = readFileSync(bundle, 'utf8');
assert(
  published.includes('  _updateTickMarkUINonRange(step) {'),
  'The slider bundle is not the published one. Run npm ci.',
);

function replaceOnce(code, from, to) {
  const at = code.indexOf(from);
  assert(at >= 0 && code.indexOf(from, at + 1) < 0, `Expected one match: ${from.split('\n')[0]}`);
  return code.slice(0, at) + to + code.slice(at + from.length);
}

const variants = {
  // No tick array before the slider has measured a width. The template renders
  // tick marks only under @if (_cachedWidth), and the server never measures one.
  fix: () =>
    replaceOnce(
      published,
      'if (!this.showTickMarks || this.step === undefined',
      'if (!this.showTickMarks || !this._cachedWidth || this.step === undefined',
    ),
};

try {
  for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(variants)) {
    assert(variants[name], `Unknown variant ${name}`);
    writeFileSync(bundle, variants[name]());
    rmSync('.angular/cache', {recursive: true, force: true});
    execSync(`npx ng build --output-path dist/${name}`, {stdio: 'inherit'});
  }
} finally {
  writeFileSync(bundle, published);
  rmSync('.angular/cache', {recursive: true, force: true});
}
