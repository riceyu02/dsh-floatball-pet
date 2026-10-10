'use strict';
/**
 * Dev check: pull the injected apply script out of `src/update.js`, write it next to this
 * file as `apply-script.extracted.cjs`, and syntax-check it.
 *
 * The apply script is built as an array of string literals, so no ordinary linter sees it:
 * a broken line inside it passes `node --check src/update.js` and only fails on the one
 * machine that tries to self-update. This makes that failure visible here instead.
 *
 * Runs first in `npm test`, so a broken apply script fails the build instead of shipping:
 *
 *   node tools/check-apply-script.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'update.js');
const OUT = path.join(__dirname, 'apply-script.extracted.cjs');

const source = fs.readFileSync(SOURCE, 'utf8');
const match = /const APPLY_SCRIPT = \[([\s\S]*?)\n\]\.join\('/.exec(source);
if (match === null) {
  console.error('could not find the APPLY_SCRIPT array in src/update.js');
  process.exitCode = 1;
} else {
  // The array is a list of string literals; evaluate just that fragment.
  const lines = (0, eval)(`[${match[1]}]`);
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    console.error('the extracted fragment is not an array of strings');
    process.exitCode = 1;
  } else {
    const script = lines.join('\n');
    fs.writeFileSync(OUT, `${script}\n`);
    console.log(`extracted ${lines.length} lines (${script.length} bytes) to ${path.relative(ROOT, OUT)}`);
    try {
      execFileSync(process.execPath, ['--check', OUT], { stdio: 'inherit' });
      console.log('apply script syntax: OK');
    } catch {
      console.error('apply script syntax: FAILED');
      process.exitCode = 1;
    }
  }
}
