/**
 * Per-machine choice of who judges the AI's replies, and whether anyone is told.
 *
 * WHY A FILE ON THIS MACHINE. The judge runs where the user's own subscription lives, and a
 * second CLI (agy, on the owner's Mac) exists on one machine only. A server-side setting would
 * point every machine at a binary most of them do not have.
 *
 * WHY `silent` EXISTS. Measured 2026-10-02 on the owner's account: a verdict reaches the user
 * one turn after the reply it is about, by which time the work is done, and a verdict that
 * blocks the reply instead forces the AI to resend it, so the user reads it twice. Neither is
 * useful. What is useful is the record, so `silent` keeps judging and recording and stops
 * telling anyone.
 *
 * File: ~/.ownmind/judge.json, e.g. {"cli": "agy", "model": "gemini-3.8-flash-low", "silent": true}
 * Anything missing or malformed falls back to the shipped behaviour: Claude Code, haiku, not silent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIS = new Set(['claude', 'agy']);
// A model name goes onto a command line. Only the characters model names actually use.
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function judgeConfigPath() {
  return process.env.OWNMIND_JUDGE_CONFIG || path.join(os.homedir(), '.ownmind', 'judge.json');
}

export function readJudgeConfig(file = judgeConfigPath()) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { /* no file, or not JSON: the shipped defaults */ }
  return {
    cli: CLIS.has(raw.cli) ? raw.cli : 'claude',
    model: typeof raw.model === 'string' && MODEL_SHAPE.test(raw.model) ? raw.model : null,
    silent: raw.silent === true,
  };
}
