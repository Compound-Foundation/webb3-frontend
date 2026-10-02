#!/usr/bin/env node
// CI gate: fail if `yarn audit` reports any high/critical advisory.
//
// A wrapper is needed because yarn 1's `--level` flag only filters the
// report — the exit code is a severity bitmask that still reflects lower
// severities, so `yarn audit --level high` can't be used directly as a gate.
//
// Advisories listed in scripts/audit-allowlist.json (with a written
// justification) are skipped.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const allowlistPath = path.join(__dirname, 'audit-allowlist.json');
const allowlist = fs.existsSync(allowlistPath)
  ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
  : [];
const allowedIds = new Map(allowlist.map((e) => [e.id, e]));

const res = spawnSync('yarn', ['audit', '--json'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const failing = new Map();
const skipped = new Map();
let sawSummary = false;

for (const line of (res.stdout || '').split('\n')) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type === 'auditSummary') sawSummary = true;
  if (event.type !== 'auditAdvisory') continue;
  const a = event.data.advisory;
  if (a.severity !== 'high' && a.severity !== 'critical') continue;
  const id = a.github_advisory_id || String(a.id);
  if (allowedIds.has(id)) {
    skipped.set(id, a);
  } else {
    failing.set(id, a);
  }
}

if (!sawSummary) {
  console.error('audit-check: `yarn audit` produced no summary — audit did not run correctly.');
  console.error(res.stderr || '');
  process.exit(1);
}

for (const [id, a] of skipped) {
  console.log(`ALLOWLISTED ${a.severity}: ${a.module_name} (${id}) — ${allowedIds.get(id).justification}`);
}

if (failing.size > 0) {
  console.error('\naudit-check: high/critical vulnerabilities found:\n');
  for (const [id, a] of failing) {
    console.error(`  ${a.severity.toUpperCase()}: ${a.module_name} — ${a.title}`);
    console.error(`    ${a.url || 'https://github.com/advisories/' + id}`);
    console.error(`    vulnerable: ${a.vulnerable_versions}  patched: ${a.patched_versions}\n`);
  }
  console.error(`${failing.size} advisory(ies) must be fixed (or allowlisted with justification in scripts/audit-allowlist.json).`);
  process.exit(1);
}

console.log('audit-check: no unaddressed high/critical vulnerabilities.');
