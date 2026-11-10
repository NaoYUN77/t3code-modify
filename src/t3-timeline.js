// Entry point injected into T3 Code's web client.
//
// It follows the SPA route, subscribes to the thread the user is looking at,
// and docks the timeline beside that thread's chat, so that dragging back
// through a task shows what was decided and what was run at each step.

import { TimelinePanel } from './panel.js';
import { Integration } from './t3-integration.js';
import { T3Client, rpc, subscribeThread } from './t3-rpc.js';
import { toNode } from './timeline-core.js';

const DEBUG = new URLSearchParams(location.search).has('t3TimelineDebug');
window.__T3_TIMELINE_DEBUG = DEBUG;
const log = (...a) => DEBUG && console.log('[timeline]', ...a);

function threadIdFromLocation() {
  // The client canonicalises /threads/<environmentId>/<threadId> to
  // /<environmentId>/<threadId>, so read the trailing uuid instead of the
  // route shape: it is the thread id either way.
  const last = location.pathname.split('/').filter(Boolean).at(-1);
  return last && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)
    ? decodeURIComponent(last)
    : null;
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
 * The client hands out a *window* over a thread's items — the recent ones, and
 * the same window on every re-sync — so replacing the list with each update
 * would quietly drop the earlier history the panel exists to scrub through.
 * Steps are matched by id and ordered by their ordinal, which is global to the
 * thread and therefore comparable between a full snapshot and a window.
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

  // Steps arrive from the projection without the parts of them that are large:
  // a file change has no diff, a tool call has no output. Those come from the
  // item detail, per step, when it is first read — and are kept here, because a
  // re-sync rebuilds every node from the projection and would drop them.
  const fetched = new Map(); // step id -> the fields the detail added
  const requested = new Set(); // steps already asked about, including empty answers

  function withFetched(list) {
    return list.map((node) => {
      const patch = fetched.get(node.id);
      return patch ? toNode({ ...node.raw, ...patch }) : node;
    });
  }

  function attach(node, patch) {
    fetched.set(node.id, patch);
    const k = nodes.indexOf(node); // -1 once the thread has moved on
    if (k < 0) return;
    nodes[k] = toNode({ ...node.raw, ...patch });
    panel.refresh();
  }

  /** Whether the projection left out something this step needs. */
  function needsDetail(node) {
    if (node.type === 'file_change') return !node.diff;
    if (node.type === 'checkpoint') return node.turn > 0; // turn 0 opens the thread
    return node.raw?.outputOmitted === true && !node.output;
  }

  async function loadDetail(node) {
    if (!node || requested.has(node.id) || !needsDetail(node)) return;
    requested.add(node.id);
    try {
      if (node.type === 'checkpoint') {
        // The checkpoint records a snapshot, not the diff of the turn it opens;
        // that turn's changes are the nearest thing to what it covers.
        const { diff } = await client.call(rpc.getTurnDiff, {
          threadId: currentThread,
          fromTurnCount: node.turn - 1,
          toTurnCount: node.turn,
        });
        if (diff) attach(node, { diffStr: diff });
        return;
      }
      const { item } = await client.call(rpc.getTurnItem, { threadId: currentThread, itemId: node.raw.id });
      if (!item) return;
      if (item.diffStr) attach(node, { diffStr: item.diffStr });
      else if (item.output) attach(node, { output: item.output });
    } catch (e) {
      log('could not load the detail of', node.id, e);
    }
  }

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
      client = await new T3Client().connect();
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
        nodes = withFetched(mergeNodes(nodes, nodesFromProjection(projection)));
        panel.setNodes(nodes);
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

  panel.onSelect = (node) => loadDetail(node);

  // Follow client-side navigation without hooking the router.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    log('route', location.pathname);
    watch(threadIdFromLocation());
  }, 400);

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 't' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      panel.setOpen(!panel.open);
    }
  });

  await watch(threadIdFromLocation());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}
