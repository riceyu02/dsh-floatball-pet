'use strict';
/**
 * Dev helper: what is actually behind an npm name the README or a release might use.
 *
 *   node tools/_check-npm-names.cjs dsh-ball dsh-floatball ...
 *
 * `registry.npmjs.org/<name>` answers 200 for "taken", 404 for "free", and a name that was
 * published and later removed can also answer 404 while still being unavailable for a
 * while afterwards. The registry's own search endpoint distinguishes those cases, which is
 * why this asks both.
 */
const https = require('node:https');

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('usage: node tools/_check-npm-names.cjs <name> [name...]');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve) => {
    const request = https.get(url, { headers: { 'user-agent': 'dsh-floatball-pet-name-check' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', (error) => resolve({ status: 0, body: String(error.message) }));
    request.setTimeout(20000, () => { request.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

(async () => {
  for (const name of names) {
    const packument = await get(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (packument.status === 200) {
      let info = null;
      try { info = JSON.parse(packument.body); } catch { /* leave null */ }
      const latest = info && info['dist-tags'] ? info['dist-tags'].latest : '?';
      const modified = info && info.time ? info.time.modified : '?';
      const maintainers = info && info.maintainers ? info.maintainers.map((m) => m.name).join(', ') : '?';
      console.log(`${name.padEnd(24)} 已占用  最新=${latest}  最后更新=${modified}  维护者=${maintainers}`);
      continue;
    }
    // 404: either never used, or removed. The search index tells the difference.
    const search = await get(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`);
    let seenBefore = false;
    try {
      const parsed = JSON.parse(search.body);
      seenBefore = (parsed.objects || []).some((entry) => entry.package && entry.package.name === name);
    } catch { /* unknown */ }
    console.log(`${name.padEnd(24)} ${packument.status === 404 ? '空闲' : `HTTP ${packument.status}`}${seenBefore ? '（但搜索索引里仍有同名记录，需谨慎）' : '  ✔ 干净可用'}`);
  }
})();
