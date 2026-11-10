#!/usr/bin/env node
// Patch the T3 Code web client to load the timeline panel.
//
// T3 Code's client is a prebuilt bundle with no plugin API, so the only way to
// put a panel inside it is to add one file to its asset directory and one
// <script> tag to its index.html. This script does exactly that, keeps a
// backup, and can undo it.
//
//   node install.mjs              # patch the newest local client
//   node install.mjs --uninstall  # put it back
//   node install.mjs --status     # show what is installed
//   node install.mjs --client-dir <path>
//
// Re-run it after `t3 update`, which restores the stock client.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC_DIR = path.join(import.meta.dirname, 'src');
const ASSET_PREFIX = 't3-timeline';
const MARKER = '<!-- t3-timeline:panel -->';
const ASSET_FILES = ['t3-timeline.js', 'panel.js', 'timeline-core.js', 't3-rpc.js', 't3-integration.js'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

function t3Home() {
  return process.env.T3CODE_HOME ? path.resolve(process.env.T3CODE_HOME) : path.join(os.homedir(), '.t3');
}

/** The version directory the running server uses, else the newest installed. */
function findClientDir() {
  const explicit = opt('--client-dir');
  if (explicit) return path.resolve(explicit);

  const versionsDir = path.join(t3Home(), 'runtime', 'versions');
  if (!fs.existsSync(versionsDir)) {
    throw new Error(
      `no T3 Code runtime found at ${versionsDir} — is T3 Code installed for this user?\n` +
        'If it keeps its data elsewhere, point this installer at the client directory ' +
        'with --client-dir <path> (the one holding index.html), or set T3CODE_HOME.',
    );
  }
  const versions = fs
    .readdirSync(versionsDir)
    .filter((v) => fs.existsSync(path.join(versionsDir, v, 'client', 'index.html')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  let running = null;
  try {
    running = JSON.parse(fs.readFileSync(path.join(t3Home(), 'userdata', 'server-runtime.json'), 'utf8')).serverVersion;
  } catch {
    /* no runtime file; fall back to newest */
  }
  const version = running && versions.includes(running) ? running : versions.at(-1);
  if (!version) {
    throw new Error(
      `no T3 Code client found under ${versionsDir} — pass --client-dir <path> to name one, ` +
        'or set T3CODE_HOME if T3 Code keeps its data somewhere else.',
    );
  }
  return path.join(versionsDir, version, 'client');
}

function scriptTag() {
  return `${MARKER}<script type="module" src="/assets/${ASSET_PREFIX}.js"></script>`;
}

function status(clientDir) {
  const indexPath = path.join(clientDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const patched = html.includes(MARKER);
  const assets = ASSET_FILES.filter((f) => fs.existsSync(path.join(clientDir, 'assets', f)));
  console.log(`client:   ${clientDir}`);
  console.log(`patched:  ${patched ? 'yes' : 'no'}`);
  console.log(`assets:   ${assets.length ? assets.join(', ') : '(none)'}`);
  console.log(`backup:   ${fs.existsSync(`${indexPath}.t3-timeline.bak`) ? 'yes' : 'no'}`);
  return patched;
}

function install(clientDir) {
  const assetsDir = path.join(clientDir, 'assets');
  const indexPath = path.join(clientDir, 'index.html');
  const backupPath = `${indexPath}.t3-timeline.bak`;

  if (!fs.existsSync(assetsDir)) throw new Error(`missing assets dir: ${assetsDir}`);

  // Backup once, so --uninstall restores the pristine file even after t3 update.
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(indexPath, backupPath);
    console.log(`backed up index.html -> ${path.basename(backupPath)}`);
  }

  for (const file of ASSET_FILES) {
    const from = path.join(SRC_DIR, file);
    if (!fs.existsSync(from)) throw new Error(`missing source file: ${from}`);
    fs.copyFileSync(from, path.join(assetsDir, file));
  }
  console.log(`copied ${ASSET_FILES.length} asset files -> ${assetsDir}`);

  let html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes(MARKER)) {
    console.log('index.html already patched — refreshed assets only');
    return;
  }
  html = html.includes('</body>') ? html.replace('</body>', `  ${scriptTag()}\n  </body>`) : `${html}\n${scriptTag()}\n`;
  fs.writeFileSync(indexPath, html);
  console.log('patched index.html');
  console.log('\nReload the T3 Code client (hard reload) to see the panel.');
}

function uninstall(clientDir) {
  const indexPath = path.join(clientDir, 'index.html');
  const backupPath = `${indexPath}.t3-timeline.bak`;

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, indexPath);
    fs.rmSync(backupPath);
    console.log('restored index.html from backup');
  } else if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8').replace(new RegExp(`\\s*${MARKER}.*`), '');
    fs.writeFileSync(indexPath, html);
    console.log('removed the script tag');
  }

  for (const file of ASSET_FILES) {
    const p = path.join(clientDir, 'assets', file);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  console.log('removed panel assets — hard reload the client to finish');
}

try {
  const clientDir = findClientDir();
  if (flag('--status')) {
    status(clientDir);
  } else if (flag('--uninstall')) {
    uninstall(clientDir);
  } else if (flag('--dry-run')) {
    console.log(`would patch: ${clientDir}`);
    status(clientDir);
  } else {
    install(clientDir);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
