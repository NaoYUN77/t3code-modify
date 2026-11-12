#!/usr/bin/env node
// Patch the T3 Code *desktop app* (Electron), not the server's client.
//
// The desktop app renders a client bundle out of its own `resources/app.asar`;
// it only talks to the server over WebSocket, so `install.mjs` (which patches
// the client the server serves) does nothing for it. This script goes into the
// app's asar instead.
//
//   node scripts/patch-desktop.mjs --probe       # report only, changes nothing
//   node scripts/patch-desktop.mjs --patch       # extract, inject, repack
//   node scripts/patch-desktop.mjs --uninstall   # restore the backup
//
// The injection is one inline classic <script> (built from src/ into a single
// IIFE, because the renderer may load over file:// where ES module imports are
// blocked) placed just before </body> of the client's index.html. It carries a
// marker comment so --uninstall can take it back out, and the original
// app.asar is kept as app.asar.t3bak.
//
// This is a modification of an installed application: quit the app first, and
// if it no longer starts, --uninstall puts the original asar back.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const BUILD = path.join(ROOT, 'build', 't3-timeline.iife.js');
const MARK = '<!-- t3-timeline:panel -->';
const MARK_END = '<!-- /t3-timeline:panel -->';
const BACKUP = 'app.asar.t3bak';
const ASAR_VERSION = '@electron/asar@3';
const FUSES_VERSION = '@electron/fuses@1';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const say = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

function npx(spec, args, opts = {}) {
  return run('npx', ['--yes', spec, ...args], opts);
}

/** npx and friends are .cmd shims on Windows, which execFile cannot launch
 *  directly — and a path with spaces (Program Files\\T3 Code) must survive the
 *  shell, so the arguments are quoted by hand. */
function quoteWin(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function run(cmd, args, opts = {}) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts };
  if (process.platform === 'win32') {
    const line = [cmd, ...args].map(quoteWin).join(' ');
    return execSync(line, { ...options, shell: 'cmd.exe' });
  }
  return execFileSync(cmd, args, options);
}

// --- find the app ----------------------------------------------------------

const looksLikeT3 = (s) => /t3[\s._-]?code|t3code/i.test(s);

function candidates() {
  const out = [];
  const add = (dir) => {
    if (!dir) return;
    const resources = path.join(dir, 'resources');
    const asar = path.join(resources, 'app.asar');
    if (fs.existsSync(asar)) out.push({ appDir: dir, resources, asar });
  };

  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
      .filter(Boolean);
    for (const root of roots) {
      // %LOCALAPPDATA%\Programs\<app>\resources\app.asar is the usual place,
      // but check the root itself too for per-machine installs.
      add(root);
      const programs = path.join(root, 'Programs');
      for (const base of [programs, root]) {
        let entries = [];
        try {
          entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory() || !looksLikeT3(e.name)) continue;
          add(path.join(base, e.name));
        }
      }
    }
  } else if (process.platform === 'darwin') {
    for (const dir of fs.existsSync('/Applications') ? fs.readdirSync('/Applications') : []) {
      if (!dir.endsWith('.app') || !looksLikeT3(dir)) continue;
      add(path.join('/Applications', dir, 'Contents'));
    }
  } else {
    const roots = ['/opt', path.join(os.homedir(), '.local', 'share')];
    for (const root of roots) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || !looksLikeT3(e.name)) continue;
        add(path.join(root, e.name));
      }
    }
  }
  return out;
}

function locate() {
  const direct = opt('--asar');
  if (direct) {
    const asar = path.resolve(direct);
    if (!fs.existsSync(asar)) die(`no such file: ${asar}`);
    return { appDir: path.dirname(path.dirname(asar)), resources: path.dirname(asar), asar };
  }
  const found = candidates();
  const explicit = opt('--app-dir');
  if (explicit) {
    const appDir = path.resolve(explicit);
    const asar = path.join(appDir, 'resources', 'app.asar');
    if (!fs.existsSync(asar)) die(`no resources/app.asar under ${appDir}`);
    return { appDir, resources: path.join(appDir, 'resources'), asar };
  }
  if (!found.length) {
    die(
      'could not find a T3 Code desktop install (no resources/app.asar with "t3" in the path).\n' +
        'Point at it with --app-dir "C:\\path\\to\\T3Code" (the folder holding resources\\), ' +
        'or --asar "C:\\path\\to\\resources\\app.asar".',
    );
  }
  return found[0];
}

// --- asar helpers ----------------------------------------------------------

function extract(asar, dest) {
  npx(ASAR_VERSION, ['extract', asar, dest], { stdio: ['ignore', 'pipe', 'inherit'] });
}

function pack(dir, out, unpackDirs) {
  const args = ['pack', dir, out];
  for (const d of unpackDirs) args.push('--unpack-dir', d);
  npx(ASAR_VERSION, args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Top-level entries of app.asar.unpacked, to keep native modules unpacked. */
function unpackedTopLevel(resources) {
  const dir = path.join(resources, 'app.asar.unpacked');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

function walk(dir, visit, depth = 0) {
  if (depth > 8) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, visit, depth + 1);
    else visit(p);
  }
}

/** The index.html the renderer loads: the one with a root element and the most
 *  script tags — a bundled app can carry examples or docs HTML too. */
function findIndexHtml(dir) {
  const hits = [];
  walk(dir, (p) => {
    if (!/\.html?$/i.test(p)) return;
    let html;
    try {
      html = fs.readFileSync(p, 'utf8');
    } catch {
      return;
    }
    if (html.length > 2_000_000) return;
    const scripts = (html.match(/<script\b/gi) || []).length;
    const root = /id=["']root["']/.test(html);
    if (!root && !scripts) return;
    hits.push({ file: p, rel: path.relative(dir, p), scripts, root, size: html.length, html });
  });
  hits.sort((a, b) => Number(b.root) - Number(a.root) || b.scripts - a.scripts);
  return hits;
}

/** How much of the DOM the desktop bundle is expected to have. If these are
 *  zero, the app's client has moved on and the injected script will no-op. */
const ANCHORS = [
  'sidebar-content',
  'data-sidebar-row',
  'sidebar-inset',
  'sidebar-group',
  'thread',
  // How the app talks to the server: if the renderer itself opens the socket,
  // the injected panel can reuse the same origin; if these are absent, the
  // socket lives in the main process and the panel needs the app's bridge.
  'websocket-ticket',
  'wsTicket',
  'orchestrationProtocol',
];

function anchorReport(extracted) {
  const counts = Object.fromEntries(ANCHORS.map((a) => [a, 0]));
  let scanned = 0;
  walk(extracted, (p) => {
    if (!/\.(m?js|cjs)$/i.test(p)) return;
    let text;
    try {
      const st = fs.statSync(p);
      if (st.size > 30_000_000) return;
      text = fs.readFileSync(p, 'latin1');
    } catch {
      return;
    }
    scanned += 1;
    for (const a of ANCHORS) {
      let i = 0;
      while ((i = text.indexOf(a, i)) !== -1) {
        counts[a] += 1;
        i += a.length;
      }
    }
  });
  return { counts, scanned };
}

function extractToTemp(asar) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3desktop-'));
  say(`extracting ${asar} -> ${dir}`);
  extract(asar, dir);
  return dir;
}

// --- bundle ----------------------------------------------------------------

function ensureBundle() {
  if (!fs.existsSync(BUILD) || flag('--rebuild')) {
    say('bundling src/ into one IIFE with esbuild…');
    fs.mkdirSync(path.dirname(BUILD), { recursive: true });
    run(
      'npx',
      ['--yes', 'esbuild@0.25.0', path.join(SRC, 't3-timeline.js'), '--bundle', '--format=iife',
        '--target=chrome120', `--outfile=${BUILD}`, '--log-level=warning'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
    );
  }
  const code = fs.readFileSync(BUILD, 'utf8');
  if (/<\/script/i.test(code)) die('the bundle contains "</script" — inline injection would break the HTML');
  return code;
}

function scriptBlock(code) {
  return `${MARK}<script>${code}</script>${MARK_END}`;
}

function stripBlock(html) {
  const a = html.indexOf(MARK);
  if (a === -1) return { html, removed: false };
  const b = html.indexOf(MARK_END, a);
  if (b === -1) return { html, removed: false };
  return { html: html.slice(0, a) + html.slice(b + MARK_END.length), removed: true };
}

// --- commands --------------------------------------------------------------

function probe() {
  const app = locate();
  say(`app:      ${app.appDir}`);
  say(`asar:     ${app.asar} (${(fs.statSync(app.asar).size / 1e6).toFixed(1)} MB)`);
  const unpacked = unpackedTopLevel(app.resources);
  say(`unpacked: ${unpacked.length ? unpacked.join(', ') : '(none)'}`);

  try {
    const exe = process.platform === 'win32'
      ? ['.exe'].map((ext) => fs.readdirSync(app.appDir).find((f) => f.toLowerCase().endsWith(ext))).find(Boolean)
      : null;
    const target = exe ? path.join(app.appDir, exe) : app.appDir;
    const out = npx(FUSES_VERSION, ['read', '--app', target]);
    say('\nfuses:');
    for (const line of out.trim().split('\n')) say(`  ${line}`);
  } catch (e) {
    say(`\nfuses: could not read (${String(e.message).split('\n')[0]})`);
  }

  const tmp = extractToTemp(app.asar);
  const hits = findIndexHtml(tmp);
  if (!hits.length) die('no client index.html found inside the asar');
  say(`\nindex.html candidates (best first):`);
  for (const h of hits.slice(0, 5)) {
    const csp = /http-equiv=["']Content-Security-Policy["']/i.test(h.html);
    say(`  ${h.rel}  (${h.size} bytes, ${h.scripts} scripts, root=${h.root}, csp=${csp}, patched=${h.html.includes(MARK)})`);
  }
  const best = hits[0];
  const csp = best.html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
  if (csp) say(`\nCSP: ${csp[0].slice(0, 300)}`);

  const { counts, scanned } = anchorReport(tmp);
  say(`\nanchors in ${scanned} JS files:`);
  for (const [k, n] of Object.entries(counts)) say(`  ${k}: ${n}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  say('\nprobe only — nothing was changed. Next: node scripts/patch-desktop.mjs --patch');
}

function patch() {
  const app = locate();
  const code = ensureBundle();

  if (fs.existsSync(path.join(app.resources, BACKUP)) && !flag('--force')) {
    die(
      `a backup already exists: ${BACKUP} — this app has been patched before.\n` +
        'Run --uninstall first, or --patch --force to overwrite the backup with the current asar.',
    );
  }

  const tmp = extractToTemp(app.asar);
  const hits = findIndexHtml(tmp);
  if (!hits.length) die('no client index.html found inside the asar');
  const best = hits[0];
  if (!best.root) say(`warning: ${best.rel} has no #root element — check that this is the right page`);

  const { html: cleaned } = stripBlock(best.html);
  if (!cleaned.includes('</body>')) die(`${best.rel} has no </body>`);
  const patched = cleaned.replace('</body>', `  ${scriptBlock(code)}\n  </body>`);
  fs.writeFileSync(best.file, patched);
  say(`patched ${best.rel} (+${(patched.length - best.html.length) / 1024 | 0} KB inline script)`);

  const out = path.join(os.tmpdir(), `app.patched.${Date.now()}.asar`);
  pack(tmp, out, unpackedTopLevel(app.resources));

  // Keep the original once; swapping only after the pack succeeded means a
  // failed pack leaves the app untouched.
  const backup = path.join(app.resources, BACKUP);
  if (!fs.existsSync(backup) || flag('--force')) fs.copyFileSync(app.asar, backup);
  try {
    fs.copyFileSync(out, app.asar);
  } catch (e) {
    die(`could not replace ${app.asar} — is the app running? (${e.code || e.message})`);
  }
  fs.rmSync(out, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  say(`\nbackup:   ${backup}`);
  say('quit the app completely and start it again.');
  say('if it does not start, put the backup back: node scripts/patch-desktop.mjs --uninstall');
}

function uninstall() {
  const app = locate();
  const backup = path.join(app.resources, BACKUP);
  if (fs.existsSync(backup)) {
    try {
      fs.copyFileSync(backup, app.asar);
    } catch (e) {
      die(`could not restore ${app.asar} — is the app running? (${e.code || e.message})`);
    }
    fs.rmSync(backup);
    say(`restored ${app.asar} from backup`);
    return;
  }
  const tmp = extractToTemp(app.asar);
  const hits = findIndexHtml(tmp);
  const hit = hits.find((h) => h.html.includes(MARK));
  if (!hit) {
    say('no marker found — nothing to remove');
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }
  const { html, removed } = stripBlock(hit.html);
  fs.writeFileSync(hit.file, html);
  const out = path.join(os.tmpdir(), `app.clean.${Date.now()}.asar`);
  pack(tmp, out, unpackedTopLevel(app.resources));
  try {
    fs.copyFileSync(out, app.asar);
  } catch (e) {
    die(`could not replace ${app.asar} — is the app running? (${e.code || e.message})`);
  }
  fs.rmSync(out, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  say(`removed the injected script (${removed})`);
}

try {
  if (flag('--patch')) patch();
  else if (flag('--uninstall')) uninstall();
  else probe();
} catch (e) {
  die(e.message);
}
