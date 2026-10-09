'use strict';

/** Build a self-contained local DSH bundle around the existing Electron app. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-floatball-pet-build-'));
const STAGE = path.join(TEMP_ROOT, 'package');
const RUNTIME = path.join(STAGE, 'runtime');
const ARTIFACTS = path.join(ROOT, 'artifacts');

// Rebuild the helper first so its sources and version always match the bundle.
process.env.DSH_PET_ASSEMBLE_OUT = RUNTIME;
require('./assemble.cjs');
delete process.env.DSH_PET_ASSEMBLE_OUT;
console.log('assembling the Cordis bundle ...');

if (!fs.existsSync(path.join(RUNTIME, 'DSH悬浮球.exe')) && !fs.existsSync(path.join(RUNTIME, 'electron.exe'))) {
  throw new Error(`helper runtime is incomplete: ${RUNTIME}`);
}

fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(path.join(ROOT, 'plugin'), path.join(STAGE, 'plugin'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'client.js'), path.join(STAGE, 'client.js'));
fs.copyFileSync(path.join(ROOT, 'cordis.patch.yml'), path.join(STAGE, 'cordis.patch.yml'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(STAGE, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));
fs.copyFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), path.join(STAGE, 'THIRD-PARTY-NOTICES.md'));

const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  author: source.author,
  license: source.license,
  homepage: source.homepage,
  repository: source.repository,
  bugs: source.bugs,
  keywords: source.keywords,
  type: 'module',
  main: 'plugin/host.mjs',
  exports: {
    '.': './plugin/host.mjs',
    './host': './plugin/host.mjs',
    './client': './client.js',
    './package.json': './package.json',
  },
  files: ['plugin', 'client.js', 'runtime', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  os: ['win32'],
  cpu: ['x64'],
  engines: { node: '>=22', dsh: '>=0.1.7-rc.2 <0.3.0-0' },
  peerDependencies: { '@deepseek-ai/cordis': '^4.0.4' },
  peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true } },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    // The settings page inside DSH: the loader mounts a package with this field as a
    // client plugin under the settings UI, which is what the row in cordis.patch.yml
    // refers to.
    client: { inject: ['@deepseek-ai/dsh-client-ui-settings'], platform: 'web' },
  },
};
fs.writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

fs.mkdirSync(ARTIFACTS, { recursive: true });
const filename = `${source.name.replace(/^@/, '').replaceAll('/', '-')}-${source.version}.tgz`;
const artifact = path.join(ARTIFACTS, filename);

// npm pack is just a gzip-compressed tar whose top-level folder is `package/`.
// Creating it in-process also works inside Windows AppContainer sandboxes that
// allow Node itself but deny spawning npm.cmd as a child process.
tar.c({ gzip: true, cwd: TEMP_ROOT, file: artifact, portable: true }, ['package'])
  .then(() => {
    const bytes = fs.statSync(artifact).size;
    console.log('');
    console.log('DSH plugin built:', artifact);
    console.log('package size:', `${(bytes / 1024 / 1024).toFixed(1)} MB`);
  })
  .catch((error) => {
    console.error('could not create DSH plugin archive:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    } catch (error) {
      console.warn(`temporary build directory could not be removed: ${TEMP_ROOT} (${error.message})`);
    }
  });
