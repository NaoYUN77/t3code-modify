// The timeline panel. Draws into a shadow root so nothing in T3 Code's own
// stylesheet can leak in or out, and stays usable whether it is mounted over
// the real client or on the standalone demo page.

import {
  NODE_META,
  formatArgs,
  formatTime,
  parseDiff,
  shortPath,
  shortTool,
  stats,
} from './timeline-core.js';

// How many steps the list renders either side of the selected one. The list is
// a window rather than the whole history: 2500 rows cost ~300ms to lay out,
// against ~10ms for 120, and the panel redraws whenever the thread moves. The
// track above is how the whole task is traversed; the list keeps the steps
// around wherever you are, at a cost that does not grow with the thread.
const LIST_SPAN = 60;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.dock {
  /* --- Palette ----------------------------------------------------------
     T3 Code paints its colours onto the root element as ~60 semantic custom
     properties, and custom properties inherit across a shadow boundary, so each
     of these reads the app's own theme with no JavaScript and no listener: a
     theme change, an appearance change or a user theme file reaches the panel
     for free. Two sources, in this order:

       1. --app-theme-*  what the app writes when a theme is chosen — the five
                         built-ins (T3 Chat, Grove, Ocean, Ember, Iris) and any
                         user theme in ~/.t3/userdata/themes
       2. --background, --card, --foreground, --border, --muted, --accent,
          --primary, …  the app's own resolved values, which is what it shows
                         when no theme is set (its neutral black-and-white look).
                         Themed, the app points these at the --app-theme-* values
                         itself, so reading them here is the same thing said the
                         way the default look says it

     and what follows all that is this panel's own palette, for a host that is
     neither (the demo harness, or anything else that embeds the panel). */
  color-scheme: dark;
  --tl-surface: var(--app-theme-surface, var(--card, #16161e));
  --tl-surface-2: var(--app-theme-surface-raised, var(--surface-raised, #1b1b25));
  --tl-chrome: var(--app-theme-toolbar, var(--toolbar-background, #21212e));
  --tl-line: var(--app-theme-border, var(--border, #2c2c3a));
  --tl-fg: var(--app-theme-text, var(--foreground, #c8d3f5));
  --tl-fg-dim: var(--app-theme-text-muted, var(--muted-foreground, #828bb8));
  --tl-fg-faint: var(--app-theme-muted-foreground, var(--muted-foreground, #565f89));
  --tl-strong: var(--app-theme-text, var(--foreground, #fff));
  --tl-accent: var(--app-theme-accent, var(--primary, #7aa2f7));
  --tl-hover: var(--app-theme-muted, var(--muted, #20202c));
  --tl-sel: var(--app-theme-accent-surface, var(--accent, #2a3350));
  --tl-sel-fg: var(--app-theme-accent-surface-foreground, var(--accent-foreground, #c8d3f5));
  --tl-code-bg: var(--app-theme-code-background, var(--code-background, #101018));
  --tl-code-fg: var(--app-theme-code-foreground, var(--code-foreground, #cfd6f7));
  --tl-error: var(--app-theme-error, var(--error, #f7768e));
  --tl-warning: var(--app-theme-warning, var(--warning, #e0af68));
  /* The same green and red the app colours its own diffs with. */
  --tl-add: var(--diff-addition, var(--success, #9ece6a));
  --tl-del: var(--diff-deletion, var(--destructive, #f7768e));
  --tl-handle: var(--app-theme-text, var(--foreground, #cdd6f4));
  --tl-scroll: var(--app-scrollbar-thumb, #2c2c3a);

  /* What each kind of step is worth. The four the theme has an answer for use
     it — your own messages take the accent, a file change the green its diff
     uses, a failure its error, an ask its warning. The rest are fixed hues,
     apart from one another and legible on either appearance: a theme names one
     accent, and seventeen kinds cannot all be it. */
  --tl-user: var(--tl-accent);
  --tl-ask: #bb9af7;
  --tl-plan: #bb9af7;
  --tl-answer: var(--tl-fg);
  --tl-tool: #8ab4f8;
  --tl-cmd: #a9b1d6;
  --tl-search: #2ac3de;
  --tl-sub: #2ac3de;
  --tl-apr: #2ac3de;
  --tl-file: var(--tl-add);
  --tl-note: var(--tl-warning);
  --tl-secret: var(--tl-warning);
  --tl-ckpt: #6b7394;
  --tl-terse: var(--tl-fg-faint);
  --tl-stop: var(--tl-error);
  --tl-err: var(--tl-error);

  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 420px;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--tl-surface) 0%, var(--tl-surface-2) 100%);
  color: var(--tl-fg);
  font-family: var(--t3-timeline-font, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace);
  font-size: 12.5px; line-height: 1.5;
  border-left: 1px solid var(--tl-line);
  box-shadow: -24px 0 48px rgba(0,0,0,.45);
  z-index: 2147483000;
  transition: width .18s ease;
}
.dock.collapsed { width: 34px; }
.dock.collapsed .body, .dock.collapsed .head-text, .dock.collapsed .badge { display: none; }

/* Light. With an app behind it every value above already comes from it — the
   app resolves the appearance itself and writes the colours it means — so what
   changes here is only the last fallback: the panel's own palette, for a light
   host that offers neither, and the five fixed kind colours, which are picked
   against a dark surface and wash out against a light one. The host sets the
   attribute; see setAppearance. */
:host([data-appearance="light"]) .dock {
  color-scheme: light;
  --tl-surface: var(--app-theme-surface, var(--card, #ffffff));
  --tl-surface-2: var(--app-theme-surface-raised, var(--surface-raised, #fbfbfc));
  --tl-chrome: var(--app-theme-toolbar, var(--toolbar-background, #f4f4f5));
  --tl-line: var(--app-theme-border, var(--border, #e4e4e7));
  --tl-fg: var(--app-theme-text, var(--foreground, #27272a));
  --tl-fg-dim: var(--app-theme-text-muted, var(--muted-foreground, #52525b));
  --tl-fg-faint: var(--app-theme-muted-foreground, var(--muted-foreground, #a1a1aa));
  --tl-strong: var(--app-theme-text, var(--foreground, #18181b));
  --tl-accent: var(--app-theme-accent, var(--primary, #3b6fd4));
  --tl-hover: var(--app-theme-muted, var(--muted, #f4f4f5));
  --tl-sel: var(--app-theme-accent-surface, var(--accent, #e8edfb));
  --tl-sel-fg: var(--app-theme-accent-surface-foreground, var(--accent-foreground, #1e3a8a));
  --tl-code-bg: var(--app-theme-code-background, var(--code-background, #f7f7f8));
  --tl-code-fg: var(--app-theme-code-foreground, var(--code-foreground, #27272a));
  --tl-error: var(--app-theme-error, var(--error, #dc2626));
  --tl-warning: var(--app-theme-warning, var(--warning, #b45309));
  --tl-add: var(--diff-addition, var(--success, #15803d));
  --tl-del: var(--diff-deletion, var(--destructive, #b91c1c));
  --tl-handle: var(--app-theme-text, var(--foreground, #ffffff));
  --tl-scroll: var(--app-scrollbar-thumb, #d4d4d8);
  --tl-ask: #7c3aed;
  --tl-plan: #7c3aed;
  --tl-tool: #2563eb;
  --tl-cmd: #52525b;
  --tl-search: #0e7490;
  --tl-sub: #0e7490;
  --tl-apr: #0e7490;
  --tl-ckpt: #71717a;
}

/* Docked: a column inside the thread page's own layout, beside the chat. */
.dock.docked {
  position: relative; inset: auto; height: 100%; width: var(--t3-timeline-width, 410px);
  flex: 0 0 auto; box-shadow: none;
  /* T3 floats its thread controls in a fixed, z-50 group pinned to the
     viewport's top-right — over whichever panel is docked there. Overlaying
     them (the floating default) would swallow the very buttons we cloned, so
     while docked we yield and let the app's own chrome stay on top. */
  z-index: auto;
}
/* …and leave that group's strip clear, so its buttons do not land on our
   title or badge. The inset is measured by the integration. */
.dock.docked .head { padding-right: calc(10px + var(--t3-head-inset, 0px)); }
/* Collapsing leaves a 34px strip, which only reads as anything over a floating
   panel; docked, the toolbar toggle closes the panel outright instead, so this
   slot is not worth the width it costs the title. */
.dock.docked .collapse { display: none; }
/* Docked, the panel is a column of a thread page that already names the
   thread — the second line is better spent on the counts than on a title
   squeezed down to one character. */
.dock.docked .head .sub .thread { display: none; }

.head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px; border-bottom: 1px solid var(--tl-line);
  background: var(--tl-chrome);
  flex: 0 0 auto;
}
.head-text { flex: 1 1 auto; min-width: 0; }
.head h1 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--tl-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--tl-fg-faint); min-width: 0; }
.head .sub .thread { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The stats keep their width where a thread title can give up its own: a
   half-shown count is useless, and the title is legible in the page the panel
   is docked beside. On the second line they also get the width the first line
   has to share with the window buttons. */
.badge { flex: 0 0 auto; font-size: 10px; white-space: nowrap; color: var(--tl-fg-faint); border: 1px solid var(--tl-line); border-radius: 999px; padding: 1px 7px; }
.icobtn {
  flex: 0 0 auto; width: 22px; height: 22px; display: grid; place-items: center;
  background: transparent; color: var(--tl-fg-dim); border: 1px solid var(--tl-line);
  border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;
}
.icobtn:hover { color: var(--tl-fg); border-color: var(--tl-fg-faint); }

.body { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }

.scrub { padding: 12px 14px 10px; border-bottom: 1px solid var(--tl-line); flex: 0 0 auto; }
.readout { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 9px; }
.readout .pos { font-size: 15px; color: var(--tl-strong); font-weight: 600; }
.readout .pos small { font-size: 11px; color: var(--tl-fg-faint); font-weight: 400; }
.readout .turn { font-size: 11px; color: var(--tl-fg-faint); }
.track { position: relative; height: 42px; cursor: pointer; touch-action: none; user-select: none; }
.inner { position: absolute; left: 7px; right: 7px; top: 0; bottom: 0; }
.turnmarks { position: absolute; left: 0; right: 0; top: 0; height: 14px; }
.turnmark { position: absolute; top: 0; font-size: 9.5px; color: var(--tl-fg-faint); transform: translateX(-50%); pointer-events: none; }
.rail { position: absolute; left: 0; right: 0; top: 25px; height: 3px; background: var(--tl-line); border-radius: 2px; }
.fill {
  position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px;
  /* The track behind the playhead, in whatever the theme calls primary. */
  background: linear-gradient(90deg, #3d59a1, #7aa2f7);
  background: linear-gradient(90deg, color-mix(in srgb, var(--tl-accent) 45%, transparent), var(--tl-accent));
}
.dots { position: absolute; left: 0; right: 0; top: 21px; height: 11px; }
.dot {
  position: absolute; top: 3px; width: 5px; height: 5px; margin-left: -2.5px;
  border-radius: 50%; background: currentColor; cursor: pointer; opacity: .85;
}
.dot:hover { opacity: 1; transform: scale(1.5); }
/* Steps that happen hundreds of times are drawn as texture, so that the
   decisions among them still read as dots. */
.dot.t1:not(.on) { width: 4px; height: 4px; margin-left: -2px; top: 3.5px; opacity: .7; }
.dot.t2:not(.on) { width: 3px; height: 3px; margin-left: -1.5px; top: 4px; opacity: .45; }
.dot.on { width: 9px; height: 9px; margin-left: -4.5px; top: 1px; opacity: 1; box-shadow: 0 0 0 2px var(--tl-surface), 0 0 0 3px currentColor; }
.handle {
  position: absolute; top: 15px; width: 13px; height: 23px; margin-left: -6.5px;
  background: var(--tl-handle); border-radius: 4px; border: 1px solid var(--tl-line);
  box-shadow: 0 2px 8px rgba(0,0,0,.6); cursor: grab;
}
.handle:active { cursor: grabbing; }
.handle::after { content: ""; position: absolute; left: 5px; top: 6px; width: 1px; height: 9px; background: var(--tl-fg-faint); }
.legend { display: flex; gap: 10px; margin-top: 8px; font-size: 10px; color: var(--tl-fg-faint); }
.legend i { font-style: normal; }

.detail {
  flex: 0 0 auto; max-height: 46%; display: flex; flex-direction: column;
  padding: 11px 14px; border-bottom: 1px solid var(--tl-line); background: var(--tl-surface-2);
}
/* Only the body scrolls: the restore action belongs to the step and has to stay
   within reach however long the diff is. */
.detail .dscroll { overflow: auto; min-height: 0; }
.detail .dhead { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
.detail .name { font-weight: 600; color: var(--tl-strong); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail .when { margin-left: auto; color: var(--tl-fg-faint); white-space: nowrap; }
.chip { font-size: 10px; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; white-space: nowrap; flex: 0 0 auto; }
.msg { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--tl-fg); }
.msg.quote { border-left: 2px solid var(--tl-accent); padding-left: 9px; color: var(--tl-code-fg); }
.deltas { display: flex; gap: 8px; font-size: 11px; margin-bottom: 7px; }
.add { color: var(--tl-add); } .del { color: var(--tl-del); }
.files { margin: 0; padding-left: 16px; color: var(--tl-fg-dim); }

.diff { margin: 0; font-size: 11px; line-height: 1.45; border-radius: 6px; background: var(--tl-code-bg); border: 1px solid var(--tl-line); }
.diff .l { display: flex; white-space: pre; }
.diff .l > .g { flex: 0 0 34px; text-align: right; padding-right: 8px; color: var(--tl-fg-faint); user-select: none; }
.diff .l > .t { flex: 1 1 auto; overflow-wrap: normal; }
.diff .add { background: rgba(158,206,106,.10); background: color-mix(in srgb, var(--tl-add) 14%, transparent); }
.diff .add .t { color: color-mix(in srgb, var(--tl-add) 80%, var(--tl-code-fg)); }
.diff .del { background: rgba(247,118,142,.10); background: color-mix(in srgb, var(--tl-del) 14%, transparent); }
.diff .del .t { color: color-mix(in srgb, var(--tl-del) 80%, var(--tl-code-fg)); }
.diff .hunk .t { color: var(--tl-accent); }
.diff .meta .t { color: var(--tl-fg-faint); }

/* A tool call's arguments and its output: two monospace blocks, since that is
   what they are. */
.iohead { margin: 9px 0 4px; color: var(--tl-fg-faint); font-size: 10.5px; }
.iohead:first-child { margin-top: 0; }
.io {
  /* Inherited rather than defaulted: the browser's UA stylesheet puts its own
     monospace stack on every <pre>, which beats an inherited stack and has no
     CJK in it — a command's output in Chinese came out as tofu boxes. */
  font-family: inherit;
  margin: 0; font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  border-radius: 6px; padding: 7px 9px; background: var(--tl-code-bg); border: 1px solid var(--tl-line); color: var(--tl-code-fg);
}
.io.out {
  /* The result, a shade apart from the call it answered. */
  background: #0d0d14;
  background: color-mix(in srgb, var(--tl-code-bg) 80%, var(--tl-surface));
  color: var(--tl-code-fg);
}
.io .omit { color: var(--tl-fg-faint); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 10px; font-size: 11px; color: var(--tl-fg-dim); }
.kv b { font-weight: 500; color: var(--tl-fg-faint); }
.outcome { color: var(--tl-fg-faint); font-size: 10.5px; }

.list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 6px 14px; scrollbar-color: var(--tl-scroll) transparent; }
.row {
  display: grid; grid-template-columns: 26px 1fr; gap: 6px; align-items: baseline;
  padding: 5px 8px; border-radius: 6px; cursor: pointer;
}
.row:hover { background: var(--tl-hover); }
.row.on { background: var(--tl-sel); color: var(--tl-sel-fg); box-shadow: inset 2px 0 0 var(--tl-accent); }
.row.on .sum, .row.on .no, .row.on .time { color: inherit; }
.row .no { color: var(--tl-fg-faint); font-size: 10.5px; text-align: right; }
.row .txt { min-width: 0; }
.row .lead { display: flex; align-items: baseline; gap: 6px; }
.row .sum { color: var(--tl-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .time { margin-left: auto; color: var(--tl-fg-faint); font-size: 10.5px; }
.row.s1 { opacity: .82; }
.row.s2 { opacity: .6; }
.row.s1 .sum, .row.s2 .sum { color: var(--tl-fg-dim); }
.turnsep { display: flex; align-items: center; gap: 8px; margin: 9px 8px 3px; color: var(--tl-fg-faint); font-size: 10px; }
.turnsep::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--tl-line); }
.turnsep.edge { margin: 7px 8px; color: var(--tl-fg-faint); }
.turnsep.edge::after { flex: 0 0 0; }
.empty { color: var(--tl-fg-faint); padding: 20px 14px; text-align: center; }
`;

export class TimelinePanel {
  constructor({ collapsed = false } = {}) {
    this.nodes = [];
    this.index = 0;
    this.thread = null;
    this.docked = false;
    this.visible = true;
    // Whether the user wants the panel, as opposed to `visible`, which is
    // whether it currently fits where the host page has put it.
    this.open = true;
    this.onOpenChange = null;

    this.selected = -1; // the row and dot currently marked, for cheap repaints
    this.host = document.createElement('div');
    this.host.id = 't3-timeline-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.collapsed = collapsed;
    this.#render();
  }

  mount(target = document.body) {
    target.append(this.host);
    return this;
  }

  /** The panel only makes sense while a thread is open. */
  setVisible(visible) {
    this.visible = visible;
    if (this.docked) {
      this.host.style.display = visible ? 'flex' : 'none';
    } else {
      this.host.style.display = visible ? '' : 'none';
    }
    return this;
  }

  /** Docked = a column in the page's layout; otherwise a fixed overlay. */
  setDocked(docked) {
    this.docked = docked;
    this.dock.classList.toggle('docked', docked);
    // A collapsed strip belongs to the floating overlay; as a column it is just
    // a sliver of wasted width.
    if (docked) this.setCollapsed(false);
    // Set the layout properties one at a time rather than writing `cssText`:
    // the host page may have put inline properties of its own on this element
    // — a font variable, most often — and replacing the attribute would take
    // them with it.
    const s = this.host.style;
    s.display = !this.visible ? 'none' : docked ? 'flex' : '';
    s.flex = docked ? '0 0 auto' : '';
    s.minWidth = docked ? '0' : '';
    s.height = docked ? '100%' : '';
    s.alignSelf = docked ? 'stretch' : '';
    return this;
  }

  /**
   * Which appearance the panel is drawn for, `'light'` or `'dark'`.
   *
   * Only the fallback palette and the fixed kind colours need to know: every
   * value that comes from T3 Code's theme is already the app's own light or dark
   * answer. The host says which, because the host is what knows — inside T3 Code
   * the integration reads the app's theme, and the demo asks its own switch.
   */
  setAppearance(appearance) {
    if (appearance === 'light' || appearance === 'dark') this.host.dataset.appearance = appearance;
    else delete this.host.dataset.appearance;
    return this;
  }

  /** Show or hide the panel; `onOpenChange` lets the host keep its toggle in step. */
  setOpen(open) {
    if (this.open === open) return this;
    this.open = open;
    this.onOpenChange?.(open);
    return this;
  }

  /** Collapse to the narrow strip (floating mode only — see `setDocked`). */
  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.dock.classList.toggle('collapsed', collapsed);
    const button = this.dock.querySelector('.collapse');
    if (button) button.textContent = collapsed ? '⟨' : '⟩';
    return this;
  }

  setThread(thread) {
    this.thread = thread;
    const title = this.shadow.querySelector('.head h1');
    const sub = this.shadow.querySelector('.head .sub .thread');
    if (title) title.textContent = 'Timeline';
    if (sub) sub.textContent = thread?.title || thread?.id || '';
    return this;
  }

  setNodes(nodes) {
    // First steps in, the playhead starts at the present — the end of the task
    // — and follows the tail from there. Once the reader has scrubbed back it
    // stays where they left it: an update must not undo a look at the history.
    const wasAtEnd = this.nodes.length === 0 || this.index >= this.nodes.length - 1;
    // A re-sync usually brings the same steps back with a few more fields filled
    // in, and redrawing a few thousand dots and rows for that is the most
    // expensive thing the panel does.
    const sameSteps = nodes.length === this.nodes.length && nodes.every((n, k) => n.id === this.nodes[k].id);
    this.nodes = nodes;
    this.index = wasAtEnd ? Math.max(0, nodes.length - 1) : Math.max(0, Math.min(this.index, nodes.length - 1));
    if (!sameSteps) this.#paintFrame();
    this.#paintSelection();
    return this;
  }

  /**
   * Re-read the selected step after it gained detail, as the host does for a
   * file change whose diff it has just fetched. Only that step is touched: at a
   * few thousand steps, a full repaint on every fetch is felt.
   */
  refresh() {
    const i = Math.max(0, Math.min(this.index, Math.max(0, this.nodes.length - 1)));
    const node = this.nodes[i];
    const row = this.rowFor?.get(i);
    if (row && node) row.querySelector('.sum').textContent = node.summary;
    this.#paintDetail(node);
    return this;
  }

  select(i, { scroll = true } = {}) {
    if (!this.nodes.length) return this;
    this.index = Math.max(0, Math.min(i, this.nodes.length - 1));
    this.#paintSelection({ scroll });
    return this;
  }

  destroy() {
    this.host.remove();
  }

  // --- rendering -----------------------------------------------------------

  #render() {
    const style = document.createElement('style');
    style.textContent = CSS;
    const dock = document.createElement('div');
    dock.className = `dock${this.collapsed ? ' collapsed' : ''}`;
    dock.tabIndex = 0;
    dock.innerHTML = `
      <div class="head">
        <div class="head-text">
          <h1>Timeline</h1>
          <div class="sub"><span class="thread"></span><span class="badge"></span></div>
        </div>
        <button class="icobtn collapse" title="折叠">⟩</button>
        <button class="icobtn hide" title="关闭">×</button>
      </div>
      <div class="body">
        <div class="scrub">
          <div class="readout">
            <div class="pos"><span class="n">–</span> <small>/ <span class="total">0</span></small></div>
            <div class="turn"></div>
          </div>
          <div class="track">
            <div class="inner">
              <div class="turnmarks"></div>
              <div class="rail"><div class="fill"></div></div>
              <div class="dots"></div>
              <div class="handle"></div>
            </div>
          </div>
          <div class="legend">
            <i>◆ 用户</i><i>? 提问</i><i>▸ 回答</i><i>⚙ 工具</i><i>› 命令</i><i>✎ 改动</i><i>⏱ 还原点</i><i>✕ 错误</i>
          </div>
        </div>
        <div class="detail"></div>
        <div class="list"></div>
      </div>`;
    this.shadow.append(style, dock);
    this.dock = dock;

    dock.querySelector('.collapse').addEventListener('click', () => {
      this.setCollapsed(!this.collapsed);
      this.#layout();
    });
    // Closing hands it back to the host, which owns the toggle that reopens it;
    // tearing the host out here would only have the integration put it back.
    dock.querySelector('.hide').addEventListener('click', () => this.setOpen(false));

    const track = dock.querySelector('.track');
    const move = (e) => {
      const r = track.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, (e.clientX ?? 0) - r.left));
      const i = r.width ? Math.round((x / r.width) * (this.nodes.length - 1)) : 0;
      this.select(i);
    };
    let dragging = false;
    track.addEventListener('pointerdown', (e) => {
      dragging = true;
      track.setPointerCapture(e.pointerId);
      move(e);
    });
    track.addEventListener('pointermove', (e) => dragging && move(e));
    track.addEventListener('pointerup', (e) => {
      dragging = false;
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    });
    // Clicks on the dots and on the rows are delegated: there are a few
    // thousand of each, and one listener per element costs more to build than
    // the rest of the panel put together.
    dock.querySelector('.dots').addEventListener('click', (e) => {
      const dot = e.target.closest('.dot');
      if (!dot) return;
      this.select([...dot.parentElement.children].indexOf(dot));
    });
    dock.querySelector('.list').addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (row) this.select(Number(row.dataset.k), { scroll: false });
    });
    dock.addEventListener('keydown', (e) => this.#onKey(e));
  }

  #onKey(e) {
    const map = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
    if (e.key === 'Home') this.select(0);
    else if (e.key === 'End') this.select(this.nodes.length - 1);
    else if (map[e.key]) this.select(this.index + map[e.key]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  #layout() {
    // Nothing to measure lazily today; the CSS collapses the dock on its own.
  }

  /** Everything that depends on which steps exist. */
  #paintFrame() {
    const n = this.nodes.length;
    const at = (k) => (n > 1 ? (k / (n - 1)) * 100 : 0);

    const st = stats(this.nodes);
    this.shadow.querySelector('.badge').textContent =
      `${compact(st.users)} 指令 · ${compact(st.tools)} 工具 · ${compact(st.changes)} 改动`;
    this.shadow.querySelector('.total').textContent = String(n);
    this.selected = -1;

    // One dot per step, coloured by kind and sized by how often that kind
    // happens; the selected one grows. Built as markup rather than elements:
    // there are thousands of them.
    const dots = this.shadow.querySelector('.dots');
    dots.innerHTML = this.nodes
      .map((nd, k) => {
        const meta = NODE_META[nd.type];
        const label = esc(`${k + 1}. ${meta.label} — ${nd.summary}`);
        return `<span class="dot t${meta.tier ?? 1}" style="left:${at(k)}%;color:${meta.accent}" title="${label}"></span>`;
      })
      .join('');
    this.dotEls = dots.children;

    // A turn ruler above the rail: one number per turn, thinning out to fit.
    // The spacing follows the turns rather than the steps — there are 80 turns
    // and a few thousand steps, and steps are not evenly spread over them.
    const marks = [];
    let prevTurn = Symbol('none');
    this.nodes.forEach((nd, k) => {
      if (nd.turn === prevTurn) return;
      prevTurn = nd.turn;
      if (nd.turn != null) marks.push(k);
    });
    const width = this.shadow.querySelector('.track')?.clientWidth || 380;
    // Thinned by the space a number actually takes up, not by counting: turns
    // are unevenly spread over the steps, so dropping every n-th one still
    // leaves neighbours overlapping where a busy stretch of turns sits in a
    // narrow part of the track.
    const minPx = 26;
    let lastPx = -Infinity;
    const shown = [];
    for (const k of marks) {
      const px = (n > 1 ? k / (n - 1) : 0) * width;
      if (px - lastPx < minPx) continue;
      lastPx = px;
      shown.push(`<span class="turnmark" style="left:${at(k)}%">${this.nodes[k].turn}</span>`);
    }
    this.shadow.querySelector('.turnmarks').innerHTML = shown.join('');

    this.#buildList();
  }

  /** Everything that depends on which step is selected. Runs on every drag step. */
  #paintSelection({ scroll = false } = {}) {
    const n = this.nodes.length;
    const i = Math.max(0, Math.min(this.index, Math.max(0, n - 1)));
    const node = this.nodes[i];
    const pct = n > 1 ? (i / (n - 1)) * 100 : 0;

    this.shadow.querySelector('.fill').style.width = `${pct}%`;
    this.shadow.querySelector('.handle').style.left = `${pct}%`;
    this.shadow.querySelector('.pos .n').textContent = n ? String(i + 1) : '–';
    this.shadow.querySelector('.readout .turn').textContent = node?.turn != null ? `第 ${node.turn} 轮` : '';

    // The window follows the selection, so it is rebuilt only once a drag has
    // carried the playhead out of it — not on every step of one.
    if (this.rowFor?.size && !this.rowFor.has(i)) this.#buildList();

    if (this.selected !== i) {
      this.dotEls?.[this.selected]?.classList.remove('on');
      this.rowFor?.get(this.selected)?.classList.remove('on');
      this.dotEls?.[i]?.classList.add('on');
      this.rowFor?.get(i)?.classList.add('on');
      this.selected = i;
    }

    this.#paintDetail(node);
    if (scroll) this.#reveal(i);
    this.onSelect?.(node, i);
  }

  /**
   * Scroll the list so the selected row is on screen — but only when it is not
   * already. `scrollIntoView` is by far the most expensive thing a drag step
   * does (~9ms of the 10 it costs, against 0.2ms for the repaint), and during a
   * drag the row usually has not moved out of view yet. The comparison uses
   * offsets measured when the window was built, so nothing is measured again.
   */
  #reveal(i) {
    const row = this.rowFor?.get(i);
    if (!row) return;
    const list = this.shadow.querySelector('.list');
    const at = this.rowTop?.get(i);
    if (!list || !at) {
      row.scrollIntoView({ block: 'nearest' });
      return;
    }
    const top = at.top - list.scrollTop;
    if (top < at.margin || top + at.height > list.clientHeight - at.margin) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  #paintDetail(node) {
    const el = this.shadow.querySelector('.detail');
    if (!node) {
      el.innerHTML = '<div class="empty">没有可显示的关键节点</div>';
      return;
    }
    const meta = NODE_META[node.type];
    const full = node.type === 'file_change' ? node.fileName || '' : node.summary || '';
    const head = `<div class="dhead">
        <span class="chip" style="color:${meta.accent}">${meta.glyph} ${meta.label}</span>
        <span class="name" title="${esc(full)}">${esc(node.type === 'file_change' ? shortPath(node.fileName) : full)}</span>
        <span class="when">${esc(formatTime(node.startedAt))}${node.turn != null ? ` · run ${node.turn}` : ''}</span>
      </div>`;

    el.innerHTML = `<div class="dscroll">${head}${stepBody(node)}</div>`;
  }

  /**
   * Rows for the window of steps around the selection. Rebuilt when the steps
   * themselves change, and when the selection leaves the window.
   */
  #buildList() {
    const n = this.nodes.length;
    const at = Math.max(0, Math.min(this.index, Math.max(0, n - 1)));
    const from = Math.max(0, at - LIST_SPAN);
    const to = Math.min(n, at + LIST_SPAN + 1);

    const html = [];
    // How much of the history is off either end, so the window is not mistaken
    // for the whole task.
    if (from > 0) html.push(`<div class="turnsep edge">上方还有 ${from} 步</div>`);
    let lastTurn = Symbol('none');
    for (let k = from; k < to; k++) {
      const node = this.nodes[k];
      if (node.turn !== lastTurn) {
        lastTurn = node.turn;
        html.push(`<div class="turnsep">第 ${node.turn ?? '?'} 轮</div>`);
      }
      const meta = NODE_META[node.type];
      html.push(
        `<div class="row s${meta.tier ?? 1}" data-k="${k}">` +
          `<div class="no">${k + 1}</div>` +
          `<div class="txt"><div class="lead">` +
          `<span style="color:${meta.accent}">${meta.glyph}</span>` +
          `<span class="sum">${esc(node.summary)}</span>` +
          `<span class="time">${esc(formatTime(node.startedAt))}</span>` +
          `</div></div></div>`,
      );
    }
    if (to < n) html.push(`<div class="turnsep edge">下方还有 ${n - to} 步</div>`);
    const list = this.shadow.querySelector('.list');
    list.innerHTML = html.join('') || '';
    if (!this.nodes.length) list.replaceChildren(emptyRow());
    // Kept for the selection repaint, which must not touch the other rows.
    this.rowFor = new Map([...list.querySelectorAll('.row')].map((el) => [Number(el.dataset.k), el]));
    // Where each row sits in the list, measured once here so that revealing the
    // selected one during a drag needs no further measurement (see #reveal).
    const listTop = list.offsetTop;
    this.rowTop = new Map(
      [...this.rowFor].map(([k, el]) => [k, { top: el.offsetTop - listTop, height: el.offsetHeight, margin: 6 }]),
    );
  }
}

/** The body of the detail pane: what this step actually was. */
function stepBody(node) {
  switch (node.type) {
    case 'user_message':
    case 'assistant_message':
    case 'proposed_plan':
      return `<div class="msg${node.type === 'user_message' ? ' quote' : ''}">${esc(node.text || '（无内容）')}</div>`;

    case 'user_input_request':
      return (
        `<div class="msg quote">${esc(node.text || '（无内容）')}</div>` +
        (node.questions || [])
          .map((q) => {
            const options = (q.options || [])
              .map((o) => `<li>${esc(o.label ?? o.description ?? String(o))}</li>`)
              .join('');
            return `<div class="iohead">选项</div><div class="msg">${esc(q.header ? `${q.header} · ` : '')}${esc(q.question ?? '')}</div>${options ? `<ul class="files">${options}</ul>` : ''}`;
          })
          .join('') +
        renderAnswer(node)
      );

    case 'secret_request':
      return (
        block([
          ['用途', node.label],
          ['说明', node.reason],
          ['格式', node.placeholder],
          ['存放', node.secretStatus],
        ]) || '<div class="msg" style="color:var(--tl-fg-faint)">（无内容）</div>'
      );

    case 'dynamic_tool':
      return (
        ioBlock('调用', formatArgs(node.toolArgs), { empty: '（无参数）' }) +
        ioBlock('输出', clip(node.output), { out: true, empty: node.outputOmitted ? '输出没有随投影返回' : '（无输出）' })
      );

    case 'command_execution':
      return (
        ioBlock('命令', node.command || '', { empty: '（无命令）' }) +
        ioBlock('输出', clip(node.output), { out: true, empty: node.outputOmitted ? '输出没有随投影返回' : '（无输出）' })
      );

    case 'web_search':
      return (
        `<div class="msg">${node.patterns.map((p) => esc(p)).join('<br>') || '（无查询）'}</div>` +
        (node.results || [])
          .slice(0, 10)
          .map((r) => `<div class="io">${esc(r.title ?? r.url ?? JSON.stringify(r))}</div>`)
          .join('')
      );

    case 'subagent':
      return (
        ioBlock('任务', node.prompt || node.title || '', { empty: '（无描述）' }) +
        // A subagent still running has progress but no result yet.
        (node.result
          ? ioBlock('结果', clip(node.result), { out: true })
          : ioBlock('进展', node.progress, { out: true, empty: '（无进展）' }))
      );

    case 'file_change': {
      const deltas = `<div class="deltas"><span class="add">+${node.additions ?? '?'}</span><span class="del">−${node.deletions ?? '?'}</span></div>`;
      return deltas + renderDiff(node.diff);
    }

    case 'checkpoint': {
      const files = (node.files || []).slice(0, 40);
      const list = files.length
        ? `<ul class="files">${files.map((f) => `<li>${esc(shortPath(f.path))} <span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></li>`).join('')}</ul>`
        : '';
      // The checkpoint records a snapshot, not a diff; when it has no file list
      // of its own, the turn's changes (fetched separately, see `loadDetail`)
      // stand in for it.
      return (
        `<div class="msg">还原点 · 第 ${node.turn ?? '?'} 轮开始时的快照</div>` +
        (list || (node.diff ? '' : '<div class="msg" style="color:var(--tl-fg-faint)">没有记录文件清单</div>')) +
        (node.diff ? renderDiff(node.diff) : '')
      );
    }

    case 'notification':
      return `<div class="msg">${esc(node.notice || '（无内容）')}</div>${node.outcome ? `<div class="outcome">${esc(node.outcome)}</div>` : ''}`;

    case 'compaction':
      return block([
        ['压缩前', node.before == null ? '' : `${node.before} tokens`],
        ['压缩后', node.after == null ? '' : `${node.after} tokens`],
      ]);

    case 'run_interrupt_request':
    case 'run_interrupt_result':
      return `<div class="msg" style="color:var(--tl-del)">${esc(node.message || '打断')}</div>`;

    case 'error':
      return `<div class="msg" style="color:var(--tl-del)">${esc(node.text || '执行出错')}</div>`;

    default:
      return `<div class="msg">${esc(node.summary || '')}</div>`;
  }
}

/** A label over a monospace block; `empty` covers an absent or withheld value. */
function ioBlock(label, text, { out = false, empty = '（空）' } = {}) {
  const body = text ? esc(text) : `<span class="omit">${esc(empty)}</span>`;
  return `<div class="iohead">${esc(label)}</div><pre class="io${out ? ' out' : ''}">${body}</pre>`;
}

/** A two-column list of labelled values, skipping the ones that are not there. */
function block(rows) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return '';
  return `<div class="kv">${shown.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('')}</div>`;
}

/** Long outputs are shown clipped, with the size of the remainder said. */
function clip(text, max = 4000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… 还有 ${s.length - max} 个字符` : s;
}

function renderDiff(diff) {
  const lines = parseDiff(diff);
  if (!lines.length) return '<div class="msg" style="color:var(--tl-fg-faint)">（无 diff 文本）</div>';
  const shown = lines.slice(0, 400);
  const html = shown
    .map((l, k) => `<div class="l ${l.kind}"><span class="g">${k + 1}</span><span class="t">${esc(l.text) || ' '}</span></div>`)
    .join('');
  const more = lines.length > shown.length ? `<div class="l"><span class="g"></span><span class="t" style="color:var(--tl-fg-faint)">… 还有 ${lines.length - shown.length} 行</span></div>` : '';
  return `<div class="diff">${html}${more}</div>`;
}

function renderAnswer(node) {
  const a = node.answer;
  if (!a) return '';
  const text = a.answer ?? a.text ?? (Array.isArray(a.answers) ? a.answers.join('、') : '');
  return text ? `<div class="msg" style="margin-top:6px"><span style="color:var(--tl-add)">回答：</span>${esc(text)}</div>` : '';
}

function emptyRow() {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = '这个线程还没有可记录的步骤';
  return d;
}

/** Counts in the header: the tools alone run into four figures. */
function compact(n) {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

