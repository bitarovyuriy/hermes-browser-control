#!/usr/bin/env node
/**
 * Per-user installer for the Hermes browser-relay native-messaging host.
 *
 *   node tools/install-native-host.mjs                 # install for real Chrome + Chromium + Chrome for Testing
 *   node tools/install-native-host.mjs --print          # show what would be written, touch nothing
 *   node tools/install-native-host.mjs --check          # verify the current install, exit 1 on drift
 *   node tools/install-native-host.mjs --uninstall      # remove manifest, launcher and registry values
 *
 * What it does (all under HKEY_CURRENT_USER — **no admin, no machine-wide state**):
 *   1. writes the host manifest to %LOCALAPPDATA%\hermes\native-messaging\<name>.json
 *      with `allowed_origins: ["chrome-extension://<id>/"]` for the id Chrome
 *      actually assigns the unpacked extension in `extension/`;
 *   2. writes a launcher next to it that runs the host with absolute paths, so
 *      the host never depends on PATH, cwd or shell expansion;
 *   3. registers the manifest path in each browser family's per-user
 *      NativeMessagingHosts key.
 *
 * Nothing here hardcodes a user profile: every path is derived from
 * %LOCALAPPDATA% and the location of this file at install time.
 *
 * The extension id is derived with Chrome's own algorithm: the unpacked id is
 * the first 16 bytes of SHA-256 of the absolute extension path (UTF-16LE, native
 * separators), re-encoded into the a–p id alphabet. The e2e run asserts this
 * against the id Chrome actually reports.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(HERE, '..');

export const HOST_NAME = 'com.hermes.browser_relay';
export const REGISTRY_SUBKEY = `NativeMessagingHosts\\${HOST_NAME}`;

/**
 * Chrome's registry base for each browser family.
 *
 * Measured on this machine with Chrome for Testing 154 (the binary the e2e
 * uses): the lookup honours `Software\Google\Chrome\NativeMessagingHosts` and
 * `Software\Chromium\NativeMessagingHosts`, and ignores the product-keyed
 * `Software\Google\Chrome for Testing\...` and `Software\Chrome for Testing\...`
 * keys entirely even though the browser writes its own state there. So the
 * `chrome` family covers both shipping Google Chrome and Chrome for Testing,
 * and no inert keys are registered.
 */
export const BROWSER_FAMILIES = Object.freeze({
  chrome: { products: ['Google\\Chrome'], label: 'Google Chrome (and Chrome for Testing)' },
  chromium: { products: ['Chromium'], label: 'Chromium' },
});

export const DEFAULT_BROWSERS = ['chrome', 'chromium'];

const ALPHABET = 'abcdefghijklmnop';

// --------------------------------------------------------------------- utils

export function toPosix(p) {
  return p.replaceAll('\\', '/');
}

export function logPathFor(localAppData, name = HOST_NAME) {
  return path.join(localAppData, 'hermes', 'logs', `${name}.log`);
}

export function nativeMessagingDir(localAppData) {
  return path.join(localAppData, 'hermes', 'native-messaging');
}

// A path that is absolute on Windows whatever host we run on: `C:\…`, `C:/…` or a UNC share.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Chrome's id for an unpacked extension: SHA-256 of the absolute path's bytes — UTF-16LE
 * on Windows, UTF-8 on POSIX, which is what Chrome itself hashes — first 16 bytes, each
 * nibble mapped to a–p.
 *
 * A Windows-shaped path is normalised with `path.win32`, so the id does not depend on the
 * host doing the derivation: `C:\example\extension` yields the same id on Linux CI as on
 * the Windows machine the vector was measured on.
 */
export function extensionIdForPath(extensionDir) {
  const windows = WINDOWS_ABSOLUTE.test(extensionDir) || process.platform === 'win32';
  const absolute = windows
    ? path.win32.resolve(extensionDir.replaceAll('/', '\\'))
    : path.posix.resolve(extensionDir);
  const digest = createHash('sha256').update(Buffer.from(absolute, windows ? 'utf16le' : 'utf8')).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) id += ALPHABET[digest[i] >> 4] + ALPHABET[digest[i] & 0xf];
  return id;
}

export function registryKeysFor(browsers) {
  const keys = [];
  for (const browser of browsers) {
    const family = BROWSER_FAMILIES[browser];
    if (!family) throw new Error(`unknown browser family: ${browser} (known: ${Object.keys(BROWSER_FAMILIES).join(', ')})`);
    for (const product of family.products) {
      keys.push(`HKCU\\Software\\${product}\\${REGISTRY_SUBKEY}`);
    }
  }
  return keys;
}

/** The `...\NativeMessagingHosts` containers, for tidying up after uninstall. */
export function registryParentsFor(browsers) {
  return browsers.map((browser) => {
    const family = BROWSER_FAMILIES[browser];
    if (!family) throw new Error(`unknown browser family: ${browser}`);
    return family.products.map((product) => `HKCU\\Software\\${product}\\NativeMessagingHosts`);
  }).flat();
}

function regExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'reg.exe');
}

export function regAdd(key, value, { exe = regExe(), spawn = spawnSync } = {}) {
  const result = spawn(exe, ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`reg add ${key} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function regDelete(key, { exe = regExe(), spawn = spawnSync } = {}) {
  const result = spawn(exe, ['delete', key, '/f'], { encoding: 'utf8' });
  return result.status === 0;
}

export function regQuery(key, { exe = regExe(), spawn = spawnSync } = {}) {
  const result = spawn(exe, ['query', key, '/ve'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const match = /REG_SZ\s+(.+?)\s*$/m.exec(result.stdout);
  return match ? match[1].trim() : null;
}

// ------------------------------------------------------------------ artefacts

/** The launcher Chrome execs: absolute paths, no PATH, loud failure into a log. */
export function launcherScript({ nodePath, hostScript, logPath }) {
  const q = (value) => `"${value}"`;
  return [
    '@echo off',
    `rem Hermes browser-relay native messaging launcher — generated by install-native-host.mjs`,
    'setlocal',
    // Pin a diagnostics sink for the host so it does not depend on the browser's
    // environment reaching us — an explicit HERMES_NATIVE_LOG still wins.
    `if not defined HERMES_NATIVE_LOG set "HERMES_NATIVE_LOG=${logPath}"`,
    `if not exist ${q(nodePath)} (`,
    `  >>${q(logPath)} echo %DATE% %TIME% FATAL node runtime missing: ${nodePath}`,
    '  exit /b 9009',
    ')',
    `if not exist ${q(hostScript)} (`,
    `  >>${q(logPath)} echo %DATE% %TIME% FATAL relay host script missing: ${hostScript}`,
    '  exit /b 9008',
    ')',
    `${q(nodePath)} ${q(hostScript)}`,
    'set "RC=%ERRORLEVEL%"',
    `if not "%RC%"=="0" >>${q(logPath)} echo %DATE% %TIME% relay-host exited with code %RC%`,
    'exit /b %RC%',
    '',
  ].join('\r\n');
}

export function manifestFor({ launcherPath, extensionId, description }) {
  return {
    name: HOST_NAME,
    description,
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

// --------------------------------------------------------------------- plan

export function buildPlan(options = {}) {
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const extensionDir = options.extensionDir ?? path.join(MVP_ROOT, 'extension');
  const hostScript = options.hostScript ?? path.join(MVP_ROOT, 'tools', 'native-host', 'relay-host.mjs');
  const nodePath = options.nodePath ?? process.execPath;
  const extensionId = options.extensionId ?? extensionIdForPath(extensionDir);
  const browsers = options.browsers ?? DEFAULT_BROWSERS;
  const dir = nativeMessagingDir(localAppData);
  const manifestPath = path.join(dir, `${HOST_NAME}.json`);
  // .bat, not .cmd: this is exactly the shape Google's own native-messaging
  // example installs on Windows, and Chrome launches it through cmd.exe for us.
  const launcherPath = path.join(dir, `${HOST_NAME}.bat`);
  const logPath = logPathFor(localAppData);
  const statePath = path.join(dir, 'installed.json');
  return {
    localAppData,
    extensionDir: path.resolve(extensionDir),
    extensionId,
    hostScript: path.resolve(hostScript),
    nodePath,
    browsers,
    dir,
    manifestPath,
    launcherPath,
    logPath,
    statePath,
    registryKeys: registryKeysFor(browsers),
    registryParents: registryParentsFor(browsers),
    manifest: manifestFor({
      launcherPath,
      extensionId,
      description: 'Hermes browser extension — one-shot pairing bootstrap (loopback relay ticket minting)',
    }),
    launcher: launcherScript({ nodePath, hostScript: path.resolve(hostScript), logPath }),
  };
}

export function install(plan, { spawn = spawnSync, fs = { mkdirSync, writeFileSync } } = {}) {
  fs.mkdirSync(plan.dir, { recursive: true });
  fs.writeFileSync(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(plan.launcherPath, plan.launcher, 'utf8');
  fs.mkdirSync(path.dirname(plan.logPath), { recursive: true });
  for (const key of plan.registryKeys) regAdd(key, plan.manifestPath, { spawn });
  const state = {
    installedAt: new Date().toISOString(),
    hostName: HOST_NAME,
    manifestPath: plan.manifestPath,
    launcherPath: plan.launcherPath,
    logPath: plan.logPath,
    extensionDir: plan.extensionDir,
    extensionId: plan.extensionId,
    nodePath: plan.nodePath,
    registryKeys: plan.registryKeys,
    browsers: plan.browsers,
  };
  fs.writeFileSync(plan.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function uninstall(plan, { spawn = spawnSync } = {}) {
  const removed = { registry: [], files: [], emptyParents: [] };
  for (const key of plan.registryKeys) {
    if (regDelete(key, { spawn })) removed.registry.push(key);
  }
  // Leave no empty NativeMessagingHosts container behind; a failure here just
  // means the browser or another host still owns the key, which is fine.
  for (const parent of plan.registryParents ?? []) {
    if (regDelete(parent, { spawn })) removed.emptyParents.push(parent);
  }
  for (const file of [plan.manifestPath, plan.launcherPath, plan.statePath]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.files.push(file);
    }
  }
  return removed;
}

export function check(plan, { spawn = spawnSync } = {}) {
  const problems = [];
  if (!existsSync(plan.manifestPath)) problems.push(`manifest missing: ${plan.manifestPath}`);
  if (!existsSync(plan.launcherPath)) problems.push(`launcher missing: ${plan.launcherPath}`);
  if (!existsSync(plan.hostScript)) problems.push(`host script missing: ${plan.hostScript}`);
  if (existsSync(plan.manifestPath)) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(plan.manifestPath, 'utf8'));
    } catch (err) {
      problems.push(`manifest is not valid json: ${err.message}`);
    }
    if (parsed) {
      if (parsed.path !== plan.launcherPath) problems.push(`manifest path is ${parsed.path}, expected ${plan.launcherPath}`);
      if (!parsed.allowed_origins?.includes(`chrome-extension://${plan.extensionId}/`)) {
        problems.push(`allowed_origins does not cover chrome-extension://${plan.extensionId}/`);
      }
      if (parsed.type !== 'stdio') problems.push(`manifest type is ${parsed.type}, expected stdio`);
    }
  }
  for (const key of plan.registryKeys) {
    const value = regQuery(key, { spawn });
    if (value !== plan.manifestPath) problems.push(`registry ${key} is ${value ?? '(unset)'}, expected ${plan.manifestPath}`);
  }
  return problems;
}

// ---------------------------------------------------------------------- cli

function parseArgs(argv) {
  const opts = { browsers: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--extension-dir': opts.extensionDir = next(); break;
      case '--extension-id': opts.extensionId = next(); break;
      case '--host-script': opts.hostScript = next(); break;
      case '--node': opts.nodePath = next(); break;
      case '--appdata': opts.localAppData = next(); break;
      case '--browsers': opts.browsers = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--uninstall': opts.uninstall = true; break;
      case '--check': opts.check = true; break;
      case '--print': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

const HELP = `install-native-host.mjs — per-user Hermes native-messaging host installer

  --extension-dir <path>   unpacked extension dir (default: <mvp>/extension)
  --extension-id <id>      pin the id instead of deriving it from the path
  --host-script <path>     host to launch (default: tools/native-host/relay-host.mjs)
  --node <path>            node runtime to launch with (default: the running node)
  --appdata <path>         %LOCALAPPDATA% override (default: the real one)
  --browsers <list>        chrome,chromium (default: both)
  --print                  dry run — report the plan without writing anything
  --check                  verify the on-disk install; exit 1 on drift
  --uninstall              remove manifest, launcher and HKCU registry values
  --json                   machine-readable output
`;

function summarise(plan, extra = {}) {
  return JSON.stringify(
    {
      hostName: HOST_NAME,
      extensionDir: plan.extensionDir,
      extensionId: plan.extensionId,
      manifestPath: plan.manifestPath,
      launcherPath: plan.launcherPath,
      logPath: plan.logPath,
      registryKeys: plan.registryKeys,
      ...extra,
    },
    null,
    2,
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const plan = buildPlan(opts);

  if (opts.uninstall) {
    const removed = uninstall(plan);
    process.stdout.write(opts.json ? `${JSON.stringify({ removed }, null, 2)}\n` : `uninstalled ${removed.registry.length} registry value(s), removed ${removed.files.length} file(s)\n`);
    return 0;
  }
  if (opts.check) {
    const problems = check(plan);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems, ...JSON.parse(summarise(plan)) }, null, 2)}\n`);
    else if (problems.length) process.stdout.write(`native host install has drifted:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    else process.stdout.write(`native host install is intact (${plan.extensionId})\n`);
    return problems.length === 0 ? 0 : 1;
  }
  if (opts.dryRun) {
    // The plan is JSON either way: `--print` exists to be diffed and asserted
    // against, so a pretty-printed summary is the useful shape.
    process.stdout.write(`${summarise(plan, { manifest: plan.manifest, launcher: plan.launcher })}\n`);
    return 0;
  }
  const state = install(plan);
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(state, null, 2)}\n`
      : `native host installed for ${state.extensionId}\n  manifest: ${state.manifestPath}\n  launcher: ${state.launcherPath}\n  registry: ${state.registryKeys.length} key(s) under HKCU\n  log:      ${state.logPath}\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  toPosix(path.resolve(process.argv[1])) === toPosix(path.resolve(fileURLToPath(import.meta.url)));
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`install-native-host: ${err.message}\n`);
    process.exitCode = 1;
  }
}
