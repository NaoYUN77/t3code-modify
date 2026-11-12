// Group the sidebar's thread cards under the project they belong to.
//
// T3 Code's sidebar is one flat list, newest thread first, and every card
// repeats its project's name in small type: 23 of the 27 threads on this machine
// are in one project, so that name is on 23 cards out of 27 and the list still
// does not say which threads belong together. The app has a per-project *filter*
// (the funnel next to the search box) and it groups *projects* that share a
// repository across environments (`sidebarProjectGrouping-*.js`), but nothing
// nests threads under a project — checked against 0.1.7's bundle, where the list
// is rendered straight from a recency-sorted array.
//
// So the grouping is applied to the rendered list. It cannot re-render the app's
// React tree and must not fight it: a row that React owns is never moved, hidden
// or re-created. The list happens to be a flex column (`display:flex; gap:1px`
// on the app's own `ul`), so CSS `order` re-sorts its children without
// touching the DOM at all — the only nodes added are our own header `li`s, which
// React simply never sees. Rows keep their app order inside a project, and
// projects are ordered by their most recent thread, so the list still reads
// newest-first from the top.
//
// A row's project is not in the DOM: `data-sidebar-parent` is null on every row.
// It is in the React props the row was rendered from (`thread`, `project`,
// `projectDisplayName`), reached through the `__reactFiber$` property React
// leaves on every element. If that ever stops working the list goes back to
// being flat, which is the app's own look — the failure mode is cosmetic.
//
// Off: `localStorage['t3sidebar:group'] = '0'` and reload, or add
// `?t3NoSidebarGroup` to the client's URL.

const LIST = '[data-slot="sidebar-content"] [data-slot="sidebar-group"] > ul';
const ROW = '[data-sidebar-row]';
const OWN_ROW = 'data-t3g-row';
const HEAD = 'data-t3g-head';
const VOID = 'data-t3g-void';

/** The thread and project a row was rendered for, read off its React props. */
function rowInfo(li) {
  const row = li.querySelector(`:scope > ${ROW}`);
  if (!row) return null;
  const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'));
  let fiber = key ? row[key] : null;
  for (let depth = 0; fiber && depth < 24; depth += 1) {
    const props = fiber.memoizedProps;
    if (props && props.thread && props.project) {
      return {
        threadId: props.thread.id ?? null,
        // The name the app shows is the *group's* name (a project group can span
        // environments); it is what the cards repeat, so it is what groups them.
        name: props.projectDisplayName || props.project.title || '',
      };
    }
    fiber = fiber.return;
  }
  return null;
}

const CSS = `
/* A project heading over the threads that belong to it. Coloured from the
   app's own sidebar token, so a theme change takes it along. */
[${HEAD}] {
  display: flex; align-items: center; gap: 6px; list-style: none;
  margin: 0; padding: 10px 8px 3px;
  font-size: 11px; font-weight: 500; letter-spacing: .02em; line-height: 1.2;
  color: var(--app-theme-sidebar-muted-foreground, var(--sidebar-muted-foreground, var(--muted-foreground, #71717a)));
  user-select: none; cursor: default;
}
[${HEAD}]::before {
  content: ''; flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%;
  background: currentColor; opacity: .5;
}
[${HEAD}] > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The card says its project once per card; the heading says it once per group.
   Only the text goes: the icon still marks the row, and the heading is the one
   that can be out of view.
   Both spans in a card truncate, so it is the muted colour that tells the
   project's name apart from the thread's title; the truncate class alone
   hid the titles. */
[${OWN_ROW}] ${ROW} span.truncate.text-secondary-label { display: none; }
/* The zero-height divider rows between recency buckets, which mean nothing once
   the list is grouped by project. */
[${VOID}] { display: none; }
`;

function injectStyle() {
  if (document.getElementById('t3-sidebar-grouping')) return;
  const style = document.createElement('style');
  style.id = 't3-sidebar-grouping';
  style.textContent = CSS;
  document.head.append(style);
}

function enabled() {
  try {
    if (localStorage.getItem('t3sidebar:group') === '0') return false;
  } catch {
    /* storage blocked: the feature is on by default */
  }
  return !new URLSearchParams(location.search).has('t3NoSidebarGroup');
}

/** Re-sort the list's children into one run per project. */
function apply(ul, state) {
  const children = [...ul.children];
  const rows = children.filter((li) => li.matches(`[${OWN_ROW}]`) || li.querySelector(`:scope > ${ROW}`));

  const groups = [];
  const byKey = new Map();
  for (const li of rows) {
    li.setAttribute(OWN_ROW, '');
    li.removeAttribute(VOID);
    const info = rowInfo(li);
    if (info?.threadId) li.dataset.t3gId = info.threadId;
    const key = info?.name ? `p:${info.name}` : `u:${li.dataset.t3gId ?? rows.indexOf(li)}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, name: info?.name ?? '', rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(li);
  }

  // What the list looks like now, so a re-render that changed nothing (a title
  // being edited, a status ticking) costs one string compare and no DOM work.
  const signature = `${ul.dataset.t3gUl ?? (ul.dataset.t3gUl = String(Date.now()))}|` +
    groups.map((g) => `${g.key}=${g.rows.map((li) => li.dataset.t3gId).join(',')}`).join(';');
  if (signature === state.signature) return;
  state.signature = signature;

  // Headers are ours: throw them all away and put back the ones this pass wants.
  for (const head of ul.querySelectorAll(`:scope > [${HEAD}]`)) head.remove();

  const spacer = children.filter((li) => !li.matches(`[${OWN_ROW}]`) && !li.matches(`[${HEAD}]`));
  for (const li of spacer) li.setAttribute(VOID, '');

  groups.forEach((group, index) => {
    group.rows.forEach((li, i) => {
      // 100 per project leaves room for 90 threads in one before it runs into
      // the next project's numbers.
      li.style.order = String(index * 100 + 10 + i);
    });
    if (!group.name) return; // a row we could not identify keeps its place, headless
    const head = document.createElement('li');
    head.setAttribute(HEAD, '');
    head.style.order = String(index * 100);
    const name = document.createElement('span');
    name.textContent = group.name;
    head.append(name);
    // In the DOM as well as in `order`, so a screen reader reads the heading
    // before the threads it covers.
    ul.insertBefore(head, group.rows[0]);
  });
}

export function startSidebarGrouping() {
  if (window.__t3SidebarGrouping) return;
  window.__t3SidebarGrouping = true;
  if (!enabled()) return;

  injectStyle();
  const state = { ul: null, signature: '', frame: 0, observer: null };

  const schedule = () => {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      if (state.ul) apply(state.ul, state);
    });
  };

  /** The list element is replaced whenever the sidebar re-mounts (a route
   *  change, the project filter, a resize), so it is re-found and re-observed
   *  rather than held. */
  const attach = () => {
    const ul = document.querySelector(LIST);
    if (ul === state.ul) return;
    state.observer?.disconnect();
    state.ul = ul;
    state.signature = '';
    if (!ul) return;
    state.observer = new MutationObserver(schedule);
    state.observer.observe(ul, { childList: true });
    schedule();
  };

  attach();
  // Cheap, and only until the list appears: nothing listens to the whole app.
  const timer = setInterval(attach, 1000);
  window.addEventListener('popstate', schedule);
  // The app can re-render the rows under a settled route without the list
  // element changing, which is still a childList mutation — nothing else needed.
  return () => clearInterval(timer);
}
