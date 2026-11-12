// Entry point injected into T3 Code's web client.
//
// It follows the SPA route, subscribes to the thread the user is looking at,
// and docks the timeline beside that thread's chat, so that dragging back
// through a task shows what was asked and what came of it.

import { TimelinePanel } from './panel.js';
import { Integration } from './t3-integration.js';
import { T3Client, rpc, subscribeThread } from './t3-rpc.js';
import { startSidebarGrouping } from './t3-sidebar.js';
import { conversations, toNode } from './timeline-core.js';

const DEBUG = new URLSearchParams(location.search).has('t3TimelineDebug');
window.__T3_TIMELINE_DEBUG = DEBUG;
const log = (...a) => DEBUG && console.log('[timeline]', ...a);

function threadIdFromLocation() {
  // The desktop app's page never changes address (it is a file:// page in the
  // app bundle), so the prelude in the injected build records the thread id the
  // app itself asked for and that is the answer there.
  const fromApp = window.__t3panelNet?.threadId;
  if (fromApp) return fromApp;

  // A hash router would keep the route in the fragment; the web client keeps it
  // in the path. Read whichever is there.
  const route = location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname;
  // The client canonicalises /threads/<environmentId>/<threadId> to
  // /<environmentId>/<threadId>, so read the trailing uuid instead of the
  // route shape: it is the thread id either way.
  const parts = route.split('/').filter(Boolean);
  // A new thread's composer is /draft/<uuid> until its first message creates
  // the thread. That id is not a thread id — subscribing to it would leave the
  // panel docked and empty over a conversation that does not exist yet, so the
  // panel waits until the route becomes /<environmentId>/<threadId>.
  if (parts.includes('draft')) return null;
  const last = parts.at(-1);
  return last && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)
    ? decodeURIComponent(last)
    : null;
}

/**
 * Where the RPC lives.
 *
 * In the web client everything is same-origin: no transport, and T3Client uses
 * relative paths. The desktop app is not — its renderer is loaded from the app
 * bundle while the server is remote, and it authenticates with a bearer token
 * instead of the browser's cookie. `patch-desktop.mjs` injects a prelude that
 * records the address, ticket route and headers the app itself used, and this
 * reads them back.
 *
 * The prelude runs before the app has necessarily made a request, so this waits
 * for one. `__t3panelConfig` (the patch script's `--server-url`) is the fallback
 * for a build whose requests do not go through window.fetch.
 */
async function resolveTransport() {
  const net = window.__t3panelNet;
  const cfg = window.__t3panelConfig || {};
  const fallback = () =>
    cfg.serverUrl ? { base: String(cfg.serverUrl).replace(/\/$/, ''), headers: cfg.headers || {} } : undefined;
  if (!net) return fallback();

  const captured = () => {
    if (!net.ticket) return null;
    try {
      const u = new URL(net.ticket);
      return { base: u.origin, ticketPath: u.pathname, headers: net.headers || {} };
    } catch {
      return null;
    }
  };
  // About 30 s: the app asks for a ticket when its socket (re)connects, which is
  // at startup and on every reconnect.
  for (let i = 0; i < 120; i += 1) {
    const t = captured();
    if (t) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fallback();
}

function nodesFromProjection(projection) {
  const projected = projection?.visibleTurnItems;
  const raws = Array.isArray(projected) && projected.length
    ? projected.map((p, k) => ({ position: p.position ?? k, sourceItemId: p.sourceItemId, item: p.item }))
    : (projection?.turnItems ?? []).map((item, k) => ({ position: item.ordinal ?? k, item }));
  return raws.map(toNode).filter(Boolean);
}

/**
 * Fold a projection into the steps already known.
 *
 * The subscription's first snapshot carries the whole thread — 5395 items on the
 * one this was built against — but *re-reading* it does not: what the panel asks
 * for on every event, `getThreadProjection`, answers with the recent items only,
 * the same ~77 of them each time. Replacing the list with that would quietly drop
 * the earlier history the panel exists to scrub through. Steps are matched by id
 * and ordered by their ordinal, which is global to the thread and therefore
 * comparable between a full snapshot and a window.
 */
function mergeNodes(previous, incoming) {
  if (!previous.length) return incoming;
  if (!incoming.length) return previous;
  const byId = new Map(incoming.map((n) => [n.id, n]));
  const merged = previous.map((n) => byId.get(n.id) ?? n);
  const seen = new Set(merged.map((n) => n.id));
  for (const n of incoming) if (!seen.has(n.id)) merged.push(n);
  merged.sort((a, b) => a.position - b.position);
  return merged;
}

export async function boot() {
  if (document.getElementById('t3-timeline-host')) return;

  const panel = new TimelinePanel().mount().setVisible(false);
  const integration = new Integration(panel).start();
  if (DEBUG) window.__t3timeline = { panel, integration, resync: () => integration.setActive(true) };

  let client = null;
  let currentThread; // undefined so the first call is never mistaken for a no-op
  let nodes = [];

  const watch = async (threadId) => {
    if (currentThread === threadId) return;
    currentThread = threadId;
    nodes = [];
    panel.setNodes([]);
    client?.close();
    client = null;

    if (!threadId) {
      integration.setActive(false);
      return;
    }
    integration.setActive(true);
    panel.setThread({ title: '正在连接 T3 Code…', id: threadId });
    try {
      client = await new T3Client(await resolveTransport()).connect();
      log('connected for', threadId);

      let refetch = null;
      const resync = () => {
        clearTimeout(refetch);
        refetch = setTimeout(async () => {
          try {
            applyProjection(await client.call(rpc.getThreadProjection, { threadId }));
          } catch (e) {
            log('resync failed', e);
          }
        }, 700);
      };

      const applyProjection = (projection) => {
        if (currentThread !== threadId) return;
        if (projection?.thread) panel.setThread(projection.thread);
        // Steps are merged and kept; the panel is handed the conversations they
        // bound, which is all it draws.
        nodes = mergeNodes(nodes, nodesFromProjection(projection));
        panel.setNodes(conversations(nodes));
      };

      for await (const item of subscribeThread(client, threadId)) {
        if (currentThread !== threadId) break;
        if (item?.kind === 'snapshot') applyProjection(item.projection);
        else if (item?.kind === 'event') resync();
      }
    } catch (e) {
      log('subscribe failed', e);
      panel.setThread({ title: `连接失败：${e.message}`, id: threadId });
    }
  };

  // Follow client-side navigation without hooking the router. The desktop app
  // moves between threads without touching the address, so the thread id the
  // prelude captured is part of what is watched.
  const routeKey = () => `${location.href}|${window.__t3panelNet?.threadId || ''}`;
  let lastRoute = routeKey();
  setInterval(() => {
    if (routeKey() === lastRoute) return;
    lastRoute = routeKey();
    log('route', location.pathname, window.__t3panelNet?.threadId);
    watch(threadIdFromLocation());
  }, 400);

  await watch(threadIdFromLocation());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    startSidebarGrouping();
    boot();
  });
} else {
  startSidebarGrouping();
  boot();
}
