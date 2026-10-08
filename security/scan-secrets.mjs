// Secret scanner — the grep gate from the acceptance criteria.
//
//   node security/scan-secrets.mjs [rootDir]        # default: repo root
//
// Exits non-zero when a credential-shaped literal is found anywhere in the
// tree (source, docs, fixtures, build output). Patterns are assembled from
// fragments so this scanner never matches its own source. Run it in CI before
// packaging; a finding is a release blocker.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const S = String.raw;
const RE = (source) => new RegExp(source, 'i');

// Built from fragments so the pattern text in this file is not itself a match.
const KEY_MATERIAL = [
  { id: 'private-key-block', re: RE(`-${'-'}${'-'}BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY${'-'}${'-'}${'-'}`) },
  { id: 'aws-access-key-id', re: RE(`\\bAKIA[0-9A-Z]{16}\\b`) },
  { id: 'aws-secret-key', re: RE(`\\baws[_-]?secret[_-]?access[_-]?key\\b\\s*[:=]\\s*['"][A-Za-z0-9/+]{40}['"]`) },
  { id: 'github-token', re: RE(`\\b(?:ghp|gho|ghu|ghs|ghr)%s[A-Za-z0-9]{36,}\\b`.replace('%s', '_')) },
  { id: 'github-pat', re: RE(`\\bgithub${'_'}pat${'_'}[A-Za-z0-9_]{60,}\\b`) },
  { id: 'slack-token', re: RE(`\\bxox[baprs]${'-'}[A-Za-z0-9-]{10,}\\b`) },
  { id: 'stripe-live-key', re: RE(`\\b(?:sk|rk)${'_'}live${'_'}[A-Za-z0-9]{16,}\\b`) },
  { id: 'openai-style-key', re: RE(`\\b${'s'}${'k'}${'-'}[A-Za-z0-9]{32,}\\b`) },
  { id: 'google-api-key', re: RE(`\\bAIza[0-9A-Za-z_\\-]{35}\\b`) },
  { id: 'slack-webhook', re: RE(`https://hooks\\.slack\\.com/services/[A-Za-z0-9/]+`) },
  { id: 'jwt', re: RE(`\\beyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\b`) },
  { id: 'bearer-literal', re: RE(`Bearer\\s+[A-Za-z0-9._\\-]{24,}`) },
  {
    id: 'assigned-secret-literal',
    re: RE(`(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|ws[_-]?ticket|session[_-]?token)\\s*[:=]\\s*['"][A-Za-z0-9_+/=\\-]{16,}['"]`),
  },
];

// Never walk these; the listed extensions are binary or generated.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'coverage']);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.wav', '.ogg', '.mov',
  '.zip', '.crx', '.gz', '.tgz', '.7z', '.pdf', '.bin', '.pem', '.key',
]);
const MAX_BYTES = 4 * 1024 * 1024;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    // Skip this scanner itself: it necessarily contains credential-shaped regexes.
    if (entry.name === 'scan-secrets.mjs') continue;
    const full = join(dir, entry.name);
    try {
      if (statSync(full).size > MAX_BYTES) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  return out;
}

function redact(text) {
  const value = String(text || '').trim();
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

function main() {
  const root = resolve(process.argv[2] || process.cwd());
  const files = walk(root);
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > 4000) continue;
      for (const { id, re } of KEY_MATERIAL) {
        const match = line.match(re);
        if (match) findings.push({ file: relative(root, file), line: i + 1, id, sample: redact(match[0]) });
      }
    }
  }

  const count = findings.length;
  console.log(`scan-secrets: scanned ${files.length} files under ${root}`);
  if (!count) {
    console.log('scan-secrets: OK — no secret-shaped literals found.');
    return 0;
  }
  console.log(`scan-secrets: FAIL — ${count} finding(s):`);
  for (const finding of findings) {
    console.log(`  ${finding.file}:${finding.line}  [${finding.id}]  ${finding.sample}`);
  }
  return 1;
}

process.exitCode = main();
