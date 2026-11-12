#!/usr/bin/env node
// Patch the T3 Code *desktop app* (Electron), not the server's client.
//
// The desktop app renders its own client out of a bundle it installs beside
// itself. What that bundle is depends on the build:
//
//   resources/app.asar     the Electron shell (main process + node_modules)
//   resources/server.asar  the T3 server *and* the client it serves, at
//                          apps/server/dist/client/  <- this is the target
//
// The renderer does not fetch the client from the server it is connected to
// (the server sees only /ws and /api), so `install.mjs` — which patches the
// client the server serves — leaves it untouched. This script goes into the
// asar that actually holds a client:
//
//   node scripts/patch-desktop.mjs --probe       # report only, changes nothing
//   node scripts/patch-desktop.mjs --patch       # extract, inject, repack
//   node scripts/patch-desktop.mjs --uninstall   # restore the backup
//
// Two scripts are injected:
//
//   1. a prelude at the top of <head>, before the app's own code. It wraps
//      fetch and WebSocket and records the address, ticket route and auth
//      headers the app uses to reach its server. The app authenticates with a
//      bearer token, not the web client's cookie, and the renderer may be
//      loaded over file:// where a relative URL means nothing — this is how
//      the panel learns where "the server" is.
//   2. the panel itself, one inline classic <script> built from src/ into a
//      single IIFE (a file:// renderer cannot import ES modules), before
//      </body>.
//
// The original asar is kept as <name>.asar.t3bak; --uninstall puts it back.
// Quit the app before patching.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const BUILD = path.join(ROOT, 'build', 't3-timeline.iife.js');
const MARK = '<!-- t3-timeline:panel -->';
const MARK_END = '<!-- /t3-timeline:panel -->';
const PRE = '<!-- t3-timeline:prelude -->';
const PRE_END = '<!-- /t3-timeline:prelude -->';
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

const npx = (spec, args, opts = {}) => run('npx', ['--yes', spec, ...args], opts);

// --- find the app and the asar that holds a client -------------------------

const looksLikeT3 = (s) => /t3[\s._-]?code|t3code/i.test(s);

function appDirs() {
  const out = [];
  const add = (dir) => {
    if (dir && fs.existsSync(path.join(dir, 'resources'))) out.push(dir);
  };

  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
      .filter(Boolean);
    for (const root of roots) {
      add(root);
      for (const base of [path.join(root, 'Programs'), root]) {
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
    for (const root of ['/opt', path.join(os.homedir(), '.local', 'share')]) {
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

/** `asar list` reads only the header, so this is cheap even for 200 MB. */
function asarHasClient(asar) {
  try {
    const out = run('npx', ['--yes', ASAR_VERSION, 'list', asar]);
    return /(^|[\\/])client[\\/]index\.html$/im.test(out);
  } catch {
    return false;
  }
}

function chooseAsar(resources) {
  const explicit = opt('--asar');
  if (explicit) {
    const asar = path.resolve(explicit);
    if (!fs.existsSync(asar)) die(`no such file: ${asar}`);
    return asar;
  }
  let names = [];
  try {
    names = fs.readdirSync(resources).filter((f) => f.endsWith('.asar'));
  } catch {
    die(`cannot read ${resources}`);
  }
  // server.asar first: in the desktop builds seen so far the shell's app.asar
  // has no HTML at all, and checking 200 MB of listing before 20 MB only costs
  // a moment anyway.
  names.sort((a, b) => (b === 'server.asar') - (a === 'server.asar'));
  for (const name of names) {
    const full = path.join(resources, name);
    if (asarHasClient(full)) return full;
  }
  die(
    `none of ${names.join(', ')} contains a client/index.html.\n` +
      'Pass --asar <path> to name the archive yourself, and --app-dir <folder> if the app ' +
      'itself was not found.',
  );
}

function locate() {
  const explicit = opt('--app-dir');
  if (explicit) {
    const appDir = path.resolve(explicit);
    const resources = path.join(appDir, 'resources');
    if (!fs.existsSync(resources)) die(`no resources folder under ${appDir}`);
    return { appDir, resources, asar: chooseAsar(resources) };
  }
  const found = appDirs();
  if (!found.length) {
    die(
      'could not find a T3 Code desktop install (no folder named like it with a resources/ inside).\n' +
        'Point at it with --app-dir "C:\\path\\to\\t3code" (the folder holding resources\\).',
    );
  }
  const appDir = found[0];
  const resources = path.join(appDir, 'resources');
  return { appDir, resources, asar: chooseAsar(resources) };
}

// --- asar helpers ----------------------------------------------------------

const extract = (asar, dest) => npx(ASAR_VERSION, ['extract', asar, dest], { stdio: ['ignore', 'pipe', 'inherit'] });

function pack(dir, out, unpackPatterns) {
  const args = ['pack', dir, out];
  for (const p of unpackPatterns) args.push('--unpack', p);
  npx(ASAR_VERSION, args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/** The files the archive keeps outside itself (`<asar>.unpacked`), read from
 *  its header. Re-packing without marking them unpacked would put native
 *  modules inside the archive, where they cannot be loaded. */
function unpackedEntries(asar) {
  try {
    const fd = fs.openSync(asar, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const size = head.readUInt32LE(12);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 16);
    fs.closeSync(fd);
    const json = JSON.parse(buf.toString('utf8').replace(/\0+$/, ''));
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, v] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (v.files) walk(v, p);
        else if (v.unpacked) out.push(p);
      }
    };
    walk(json, '');
    return out;
  } catch {
    return [];
  }
}

/** Copy a generated .unpacked tree into the app's own, keeping both usable. */
function mergeDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) mergeDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function walk(dir, visit, depth = 0) {
  if (depth > 10) return;
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

/** The index.html the renderer loads: a #root element, the most scripts, and
 *  preferably one under a client/ directory (a bundle can carry docs HTML too). */
function findIndexHtml(dir) {
  const hits = [];
  walk(dir, (p) => {
    if (!/\.html?$/i.test(p)) return;
    let html;
    try {
      const st = fs.statSync(p);
      if (st.size > 2_000_000) return;
      html = fs.readFileSync(p, 'utf8');
    } catch {
      return;
    }
    const scripts = (html.match(/<script\b/gi) || []).length;
    const root = /id=["']root["']/.test(html);
    if (!root && !scripts) return;
    hits.push({
      file: p,
      rel: path.relative(dir, p),
      scripts,
      root,
      inClient: /[\\/]client[\\/]/.test(p),
      size: html.length,
      html,
    });
  });
  hits.sort((a, b) => Number(b.inClient) - Number(a.inClient) || Number(b.root) - Number(a.root) || b.scripts - a.scripts);
  return hits;
}

/** How much of the DOM the panel relies on is still in the app's bundle. */
const ANCHORS = [
  'sidebar-content',
  'data-sidebar-row',
  'sidebar-inset',
  'sidebar-group',
  'thread',
  // The transport: if these are missing, the renderer does not talk HTTP/WS
  // itself and the prelude's capture will find nothing.
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
      if (fs.statSync(p).size > 30_000_000) return;
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

// --- injection -------------------------------------------------------------

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

/** Runs before the app's own scripts: records how the app reaches its server. */
function prelude() {
  const serverUrl = opt('--server-url');
  const config = serverUrl
    ? `window.__t3panelConfig = { serverUrl: ${JSON.stringify(serverUrl)} };\n`
    : '';
  return `(() => {
  ${config}const net = (window.__t3panelNet = window.__t3panelNet || {});
  const abs = (u) => { try { return new URL(String(u), location.href); } catch { return null; } };
  const norm = (h) => {
    if (!h) return null;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        const o = {}; h.forEach((v, k) => { o[k] = v; }); return o;
      }
      if (Array.isArray(h)) { const o = {}; for (const [k, v] of h) o[k] = v; return o; }
      if (typeof h === 'object') return { ...h };
    } catch {}
    return null;
  };
  const fetch0 = window.fetch;
  if (fetch0) window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      const u = url ? abs(url) : null;
      if (u && (u.protocol === 'http:' || u.protocol === 'https:')) {
        net.base = net.base || u.origin;
        if (u.pathname.indexOf('/api/auth/websocket-ticket') === 0) {
          net.ticket = u.href;
          net.headers = norm(init && init.headers) || norm(input && input.headers) || net.headers;
        }
      }
    } catch {}
    return fetch0.apply(this, arguments);
  };
  // The desktop renderer's address does not change when the user switches
  // thread (it is a fixed file:// page), so the current thread is read off the
  // app's own RPC frames instead: every subscribeThread request names one.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const noteFrame = (data) => {
    if (typeof data !== 'string' || data.length > 500000) return;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    for (const item of Array.isArray(frame) ? frame : [frame]) {
      const id = item && item.payload && item.payload.threadId;
      if (typeof id === 'string' && UUID.test(id)) net.threadId = id;
    }
  };
  const W = window.WebSocket;
  if (W) {
    function W2(url, protocols) {
      const ws = protocols === undefined ? new W(url) : new W(url, protocols);
      try {
        net.ws = String(url);
        const send0 = ws.send;
        ws.send = function (data) { try { noteFrame(String(data)); } catch {} return send0.apply(this, arguments); };
      } catch {}
      return ws;
    }
    W2.prototype = W.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) { try { W2[k] = W[k]; } catch {} }
    window.WebSocket = W2;
  }
})();`;
}

const preludeBlock = () => `${PRE}<script>${prelude()}</script>${PRE_END}`;
const panelBlock = (code) => `${MARK}<script>${code}</script>${MARK_END}`;

function stripBlock(html, start, end) {
  const a = html.indexOf(start);
  if (a === -1) return html;
  const b = html.indexOf(end, a);
  if (b === -1) return html;
  return html.slice(0, a) + html.slice(b + end.length);
}

const stripBlocks = (html) => stripBlock(stripBlock(html, MARK, MARK_END), PRE, PRE_END);

/**
 * Pack `dir` and swap it in, carrying the archive's unpacked files with it.
 *
 * `asar pack` writes the files it leaves out to `<output>.unpacked`. Packing to
 * a temp name elsewhere and copying only the archive orphans that directory —
 * which is how a repack loses a native module ("Cannot find module
 * '@ff-labs/fff-node'"). So the archive is packed beside its target, its
 * unpacked files merged into the app's own, and only then copied into place.
 */
function swapIn(app, dir, { backup = true } = {}) {
  const patterns = [...new Set(unpackedEntries(app.asar).map((p) => path.basename(p)))];
  const out = path.join(app.resources, `.t3patch-${Date.now()}.asar`);
  pack(dir, out, patterns);
  const file = `${app.asar}.t3bak`;
  if (backup && (!fs.existsSync(file) || flag('--force'))) fs.copyFileSync(app.asar, file);
  try {
    fs.copyFileSync(out, app.asar);
  } catch (e) {
    die(`could not replace ${app.asar} — is the app running? (${e.code || e.message})`);
  }
  if (fs.existsSync(`${out}.unpacked`)) {
    mergeDir(`${out}.unpacked`, `${app.asar}.unpacked`);
    fs.rmSync(`${out}.unpacked`, { recursive: true, force: true });
  }
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- commands --------------------------------------------------------------

function probe() {
  const app = locate();
  say(`app:      ${app.appDir}`);
  say(`asar:     ${app.asar} (${(fs.statSync(app.asar).size / 1e6).toFixed(1)} MB) — has client/index.html`);
  const unpacked = unpackedEntries(app.asar);
  say(`unpacked: ${unpacked.length ? `${unpacked.length} file(s), e.g. ${unpacked.slice(0, 3).join(', ')}` : '(none)'}`);

  try {
    const exe = process.platform === 'win32'
      ? fs.readdirSync(app.appDir).find((f) => f.toLowerCase().endsWith('.exe'))
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
  say('\nindex.html candidates (best first):');
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
  const backup = `${app.asar}.t3bak`;

  if (fs.existsSync(backup) && !flag('--force')) {
    die(
      `a backup already exists: ${backup} — this app has been patched before.\n` +
        'Run --uninstall first, or --patch --force to overwrite the backup with the current asar.',
    );
  }

  const tmp = extractToTemp(app.asar);
  const hits = findIndexHtml(tmp);
  if (!hits.length) die('no client index.html found inside the asar');
  const best = hits[0];

  let html = stripBlocks(best.html);
  if (!/<head[^>]*>/i.test(html)) die(`${best.rel} has no <head>`);
  if (!html.includes('</body>')) die(`${best.rel} has no </body>`);
  html = html.replace(/<head([^>]*)>/i, `<head$1>${preludeBlock()}`);
  html = html.replace('</body>', `  ${panelBlock(code)}\n  </body>`);
  fs.writeFileSync(best.file, html);
  say(`patched ${best.rel} (+${((html.length - best.html.length) / 1024) | 0} KB)`);

  swapIn(app, tmp);

  say(`\nbackup:   ${backup}`);
  say('quit the app completely and start it again.');
  say('if it does not start, put the backup back: node scripts/patch-desktop.mjs --uninstall');
}

function uninstall() {
  const app = locate();
  const backup = `${app.asar}.t3bak`;
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
  const hit = hits.find((h) => h.html.includes(MARK) || h.html.includes(PRE));
  if (!hit) {
    say('no marker found — nothing to remove');
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }
  fs.writeFileSync(hit.file, stripBlocks(hit.html));
  swapIn(app, tmp, { backup: false });
  say('removed the injected scripts');
}

try {
  if (flag('--patch')) patch();
  else if (flag('--uninstall')) uninstall();
  else probe();
} catch (e) {
  die(e.message);
}
