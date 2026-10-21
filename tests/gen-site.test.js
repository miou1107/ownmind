// The project website under docs/ is generated from docs/site/template.html
// and docs/site/strings.json by scripts/gen-site/gen-site.mjs. These tests
// fail when a language block is missing a string the others have, or when the
// committed pages drift from what the generator would write (someone edited
// the output, or edited the sources and forgot to regenerate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, render, LANGS, TEMPLATE, STRINGS } from '../scripts/gen-site/gen-site.mjs';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

test('every language has exactly the strings English has', async () => {
  const all = JSON.parse(await readFile(STRINGS, 'utf8'));
  const want = Object.keys(all.en).sort();
  for (const lang of LANGS) {
    assert.ok(all[lang.code], `strings.json has no block for ${lang.code}`);
    assert.deepEqual(Object.keys(all[lang.code]).sort(), want, `${lang.code} keys differ from en`);
    for (const [k, v] of Object.entries(all[lang.code])) {
      assert.equal(typeof v, 'string', `${lang.code}.${k} is not a string`);
    }
  }
});

test('committed pages match the generator output', async () => {
  const files = await build(TEMPLATE, STRINGS);
  for (const [name, data] of Object.entries(files)) {
    const onDisk = await readFile(join(docs, name), 'utf8');
    assert.equal(onDisk, data, `docs/${name} is stale: run node scripts/gen-site/gen-site.mjs`);
  }
});

test('render escapes HTML and emits JSON literals', () => {
  const out = render('<p>{{T.a}}</p><script>x={{json:T.a}}</script>', [{ T: { a: 'a<b>&"c"' } }]);
  assert.equal(out, '<p>a&lt;b&gt;&amp;&quot;c&quot;</p><script>x="a\\u003cb>&\\"c\\""</script>');
  assert.equal(JSON.parse(out.match(/x=(.*)<\/script>/)[1]), 'a<b>&"c"');
});

test('render repeats sections and honours current flags', () => {
  const out = render('{{#L}}[{{n}}{{#c}}*{{/c}}]{{/L}}{{^E}}none{{/E}}', [{ L: [{ n: 'a', c: true }, { n: 'b', c: false }], E: [] }]);
  assert.equal(out, '[a*][b]none');
});

test('render refuses a key no language defines', () => {
  assert.throws(() => render('{{T.missing}}', [{ T: {} }]), /not defined/);
});

test('render refuses a section that is never closed', () => {
  assert.throws(() => render('{{#A}}x', [{ A: true }]), /unrendered/);
  assert.throws(() => render('x{{/A}}y', [{ A: true }]), /unrendered/);
});

test('render keeps a JSON literal safe inside a script element', () => {
  const out = render('{{json:T.a}}', [{ T: { a: '</script><script>alert(1)</script> ' } }]);
  assert.ok(!out.includes('</script>'), out);
  assert.equal(JSON.parse(out), '</script><script>alert(1)</script> ');
});

test('render expands a value once, inside and outside a section', () => {
  const scopes = [{ T: { a: '{{T.b}}', b: 'B' }, S: true }];
  assert.equal(render('{{T.a}}|{{#S}}{{T.a}}{{/S}}', scopes), '{{T.b}}|{{T.b}}');
});

test('render does not resolve inherited properties', () => {
  assert.throws(() => render('{{T.constructor}}', [{ T: {} }]), /not defined/);
});
