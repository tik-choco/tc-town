import fs from 'node:fs';
import assert from 'node:assert/strict';
const catalogs = JSON.parse(fs.readFileSync(new URL('../src/i18n/ai.json', import.meta.url), 'utf8'));
const keys = Object.keys(catalogs.en).sort();
const placeholders = text => [...text.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW']) {
  assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, locale + ' keys');
  for (const key of keys) { assert.ok(catalogs[locale][key].trim(), locale + ' ' + key); assert.deepEqual(placeholders(catalogs[locale][key]), placeholders(catalogs.en[key]), locale + ' ' + key); }
}
console.log('AI strings: en, ja, zh-CN, zh-TW complete');
