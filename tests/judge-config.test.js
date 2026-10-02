import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import { readJudgeConfig } from '../hooks/lib/judge-config.js';

const write = (obj) => {
  const file = path.join(tempDir('om-judge-config-'), 'judge.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
};

test('no file means the shipped judge, and people are still told', () => {
  assert.deepEqual(readJudgeConfig('/nonexistent/judge.json'), { cli: 'claude', model: null, silent: false });
});

test('the owner can pick agy, a model, and silence', () => {
  assert.deepEqual(
    readJudgeConfig(write({ cli: 'agy', model: 'gemini-3.8-flash-low', silent: true })),
    { cli: 'agy', model: 'gemini-3.8-flash-low', silent: true },
  );
});

test('anything malformed falls back instead of reaching a command line', () => {
  assert.deepEqual(readJudgeConfig(write('not json')), { cli: 'claude', model: null, silent: false });
  const odd = readJudgeConfig(write({ cli: 'rm', model: 'x; rm -rf ~', silent: 'yes' }));
  assert.deepEqual(odd, { cli: 'claude', model: null, silent: false });
});
