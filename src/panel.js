// The timeline panel. Draws into a shadow root so nothing in T3 Code's own
// stylesheet can leak in or out, and stays usable whether it is mounted over
// the real client or on the standalone demo page.

import { markdownMarkup, plainText } from './markdown.js';
import { NODE_META, formatTime, oneLine } from './timeline-core.js';

// The panel draws exactly one kind of node — a conversation — so what a
// conversation looks like is read once here rather than looked up per row. The
// other entries in NODE_META are still worth having: a conversation's reply is
// labelled by the kind of step the agent's last word was.
const CONV = NODE_META.conversation;

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
  width: var(--t3-timeline-width, 420px);
  display: flex; flex-direction: column;
  /* Flat, like the app's own panels — no gradient of our own to clash with the
     theme's surface. The detail pane below is the one raised step. */
  background: var(--tl-surface);
  color: var(--tl-fg);
  /* T3 Code's own face and scale, not a lookalike: the app sets --font-sans on
     its root and custom properties cross the shadow boundary, so every piece of
     text here is drawn in exactly the font the app's own panels use — Inter
     Variable where it is installed, Segoe UI on Windows, and whatever a user
     theme points --font-sans at. The sizes follow the app's tokens too: 14px
     for rows (--text-sm), 12px for meta (--text-xs), 11px for the smallest
     labels (--text-2xs). --t3-timeline-font stays as the escape hatch for a
     host that has none of that (the demo harness). */
  font-family: var(--t3-timeline-font, var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif));
  font-size: var(--text-sm, 14px); line-height: 1.5;
  border-left: 1px solid var(--tl-line);
  box-shadow: -24px 0 48px rgba(0,0,0,.45);
  z-index: 2147483000;
  transition: width .18s ease;
}
/* While the edge is being dragged the width has to track the pointer with no
   easing, or the panel lags a few frames behind the cursor. */
.dock.resizing { transition: none; cursor: col-resize; user-select: none; }

/* The width grip: the panel's left edge, in both layouts — floating, the panel
   is anchored to the right, and docked it sits right of the chat, so that edge
   is the divider between the two in either case. */
.grip {
  /* Inside the panel's own edge, not straddling it: a parent with
     overflow: hidden would clip anything that reaches into the chat, and in
     the app the panel sits in exactly such a row. 12px is wide enough to hit
     without aiming. */
  position: absolute; left: 0; top: 0; bottom: 0; width: 12px; z-index: 6;
  cursor: col-resize; background: transparent; touch-action: none;
  pointer-events: auto;
}
/* The mark on the divider is the one T3 Code puts on its own split view: two
   thin bars a pixel apart, 24px tall, centred vertically — its browser pane's
   resize handles draw exactly this (BrowserViewportResizeHandles.tsx), and they
   are the app's only resize grip that is visible before the pointer arrives.
   The colours are that component's too: muted at rest, near-foreground on
   hover, foreground while dragging. Underneath, the 1px line is the divider
   from the app's side-panel handle: transparent until hover, the border colour
   then, accent while the pointer is down. */
.grip::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 1px;
  background: transparent; transition: background .15s ease;
}
.grip::after {
  content: ""; position: absolute; left: 1px; top: 50%; width: 3px; height: 24px;
  margin-top: -12px;
  background-image: linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor);
  background-size: 1px 100%, 1px 100%;
  background-position: 0 0, 2px 0;
  background-repeat: no-repeat;
  color: var(--tl-fg-dim); opacity: .55;
  transition: opacity .15s ease, color .15s ease;
}
.grip:hover::before { background: var(--tl-line); }
.grip:hover::after { opacity: .85; color: var(--tl-fg); }
.grip:focus-visible::before { background: color-mix(in srgb, var(--tl-accent) 60%, transparent); }
.grip:focus-visible::after { opacity: 1; color: var(--tl-fg); }
.dock.resizing .grip::before { background: color-mix(in srgb, var(--tl-accent) 60%, transparent); }
.dock.resizing .grip::after { opacity: 1; color: var(--tl-fg); }
.grip:focus-visible { outline: none; }
.dock.collapsed .grip { display: none; }
.dock.collapsed { width: 34px; }
.dock.collapsed .body, .dock.collapsed .head-text, .dock.collapsed .badge { display: none; }
/* Two 22px buttons do not fit side by side in a 34px strip: stack them. */
.dock.collapsed .head { flex-direction: column; gap: 6px; padding: 8px 6px; }

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
/* Collapsed, the panel is a 34px strip pinned to the same right edge that group
   hangs over, so there is no width left to dodge sideways into: the strip goes
   *under* it instead, starting below wherever the group ends. How far down that
   is, is the host's to measure — see the integration.
   The width is restated here because a bare .dock.collapsed loses to
   .dock.docked, which also sets one (equal specificity, later in the file). */
.dock.docked.collapsed { width: 34px; }
.dock.docked.collapsed .head {
  padding-right: 6px;
  padding-top: calc(8px + var(--t3-head-top, 0px));
}
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
.head h1 { margin: 0; font-size: var(--text-sm, 14px); font-weight: 600; color: var(--tl-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .sub { display: flex; align-items: center; gap: 6px; font-size: var(--text-xs, 12px); color: var(--tl-fg-faint); min-width: 0; }
.head .sub .thread { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The stats keep their width where a thread title can give up its own: a
   half-shown count is useless, and the title is legible in the page the panel
   is docked beside. On the second line they also get the width the first line
   has to share with the window buttons. */
.badge { flex: 0 0 auto; font-size: var(--text-2xs, 11px); font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--tl-fg-faint); border: 1px solid var(--tl-line); border-radius: 999px; padding: 1px 7px; }
.icobtn {
  flex: 0 0 auto; width: 22px; height: 22px; display: grid; place-items: center;
  background: transparent; color: var(--tl-fg-dim); border: 1px solid var(--tl-line);
  border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;
}
.icobtn:hover { color: var(--tl-fg); border-color: var(--tl-fg-faint); }

.body { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }

.scrub { padding: 12px 14px 10px; border-bottom: 1px solid var(--tl-line); flex: 0 0 auto; }
.readout { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 9px; }
.readout .pos { font-size: 15px; color: var(--tl-strong); font-weight: 600; font-variant-numeric: tabular-nums; }
.readout .pos small { font-size: var(--text-2xs, 11px); color: var(--tl-fg-faint); font-weight: 400; }
.readout .turn { font-size: var(--text-xs, 12px); color: var(--tl-fg-faint); }
.track { position: relative; height: 42px; cursor: pointer; touch-action: none; user-select: none; }
.inner { position: absolute; left: 7px; right: 7px; top: 0; bottom: 0; }
.turnmarks { position: absolute; left: 0; right: 0; top: 0; height: 14px; }
.turnmark { position: absolute; top: 0; font-size: var(--text-2xs, 11px); color: var(--tl-fg-faint); transform: translateX(-50%); pointer-events: none; }
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
.legend { display: flex; gap: 10px; margin-top: 8px; font-size: var(--text-2xs, 11px); color: var(--tl-fg-faint); }
.legend i { font-style: normal; }

/* One conversation, and nothing else: the selected checkpoint fills the body
   below the scrubber. The panel used to list the neighbouring conversations
   under it, which put other checkpoints' questions and answers on screen while
   one was being read. */
.detail {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  padding: 11px 14px; background: var(--tl-surface-2);
}
/* The header stays put; the reply below it is the part that scrolls. */
.detail .dscroll { flex: 1 1 auto; overflow: auto; min-height: 0; scrollbar-color: var(--tl-scroll) transparent; }
.detail .dhead { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
.detail .name { font-weight: 600; color: var(--tl-strong); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail .when { margin-left: auto; color: var(--tl-fg-faint); white-space: nowrap; font-size: var(--text-2xs, 11px); font-variant-numeric: tabular-nums; }
.chip { font-size: var(--text-2xs, 11px); padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; white-space: nowrap; flex: 0 0 auto; }
.msg { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--tl-fg); }

/* The reply is model output and usually Markdown; it is rendered rather than
   shown as source, so bold markers and hash headings read as what they mean. */
.msg.md { white-space: normal; line-height: 1.62; }
.md-p { margin: 0 0 8px; }
.md-p:last-child { margin-bottom: 0; }
.md-h { margin: 12px 0 6px; font-weight: 600; color: var(--tl-strong); }
.md-h:first-child { margin-top: 0; }
.md-h1 { font-size: 15px; }
.md-h2 { font-size: 14px; }
.md-h3 { font-size: 13px; }
.md-list { margin: 0 0 8px; padding-left: 18px; }
.md-list li { margin: 2px 0; }
.md-table { margin: 0 0 8px; border-collapse: collapse; font-size: var(--text-xs, 12px); display: block; overflow-x: auto; }
.md-table th, .md-table td { padding: 3px 8px; border-bottom: 1px solid var(--tl-line); text-align: left; vertical-align: top; white-space: nowrap; }
.md-table th { color: var(--tl-strong); font-weight: 600; border-bottom-color: var(--tl-fg-faint); }
.md-quote { margin: 0 0 8px; padding-left: 9px; border-left: 2px solid var(--tl-line); color: var(--tl-fg-dim); }
.md-rule { height: 1px; margin: 10px 0; background: var(--tl-line); }
.md-link { color: var(--tl-accent); text-decoration: underline; text-underline-offset: 2px; }
.md-ic, .md-code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: .92em; background: var(--tl-code-bg); color: var(--tl-code-fg);
}
.md-ic { padding: 1px 4px; border-radius: 4px; }
.md-code { margin: 0 0 8px; padding: 8px 10px; border-radius: 6px; overflow: auto; max-height: 260px; white-space: pre; }
.msg.md strong { color: var(--tl-strong); font-weight: 600; }
/* The two halves of a conversation in the detail pane: what was asked, then
   what came of it. A label over the message rather than a box around it — the
   reply is prose, not a diff. */
.msg.none { color: var(--tl-fg-faint); }
.outcome { margin-top: 6px; color: var(--tl-fg-faint); font-size: var(--text-2xs, 11px); }

.empty { color: var(--tl-fg-faint); padding: 20px 14px; text-align: center; }
.empty .note { display: block; margin-top: 6px; font-size: var(--text-xs, 12px); opacity: .75; word-break: break-all; white-space: pre-line; }
`;

// The dragged width lives in localStorage so it survives reloads and the
// desktop app's restarts. The stylesheet keeps the defaults, so 0 means
// "whatever the layout says": 420px floating, 410px docked.
const WIDTH_KEY = 't3timeline:width';
const MIN_WIDTH = 240;
const MAX_WIDTH = 760;

function readWidth() {
  try {
    const v = Math.round(Number(localStorage.getItem(WIDTH_KEY)));
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : 0;
  } catch {
    return 0;
  }
}

function saveWidth(width) {
  try {
    if (width) localStorage.setItem(WIDTH_KEY, String(width));
    else localStorage.removeItem(WIDTH_KEY);
  } catch {
    /* a renderer that refuses storage still resizes for this session */
  }
}

export class TimelinePanel {
  constructor({ collapsed = false } = {}) {
    this.nodes = [];
    this.index = 0;
    this.thread = null;
    // A second, smaller line under the empty state — what the host knows about
    // why there is nothing to draw (which thread, which server, how many raw
    // items arrived). Empty in the web client, where the empty state is enough.
    this.emptyNote = '';
    this.docked = false;
    this.visible = true;
    // Whether the user wants the panel, as opposed to `visible`, which is
    // whether it currently fits where the host page has put it.
    this.open = true;
    this.onOpenChange = null;
    // Fired when the panel's own footprint changes (collapsing), so the host can
    // re-measure whatever it reserves around the panel. Only the host knows.
    this.onLayoutChange = null;

    this.selected = -1; // the row and dot currently marked, for cheap repaints
    this.host = document.createElement('div');
    this.host.id = 't3-timeline-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.collapsed = collapsed;
    // The width the user dragged the edge to, if any. Stored rather than
    // recomputed so it survives reloads; the defaults stay in the CSS.
    this.width = readWidth();
    this.#render();
    this.#applyWidth();
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

  /**
   * Collapse to the narrow strip: the column hands its width back to the chat
   * and the header keeps only its two buttons, so the panel is out of the way
   * without being closed. `onLayoutChange` is the host's cue to re-measure what
   * it reserves around the panel — docked, the strip ends up under T3 Code's
   * floating controls, and only the host can measure those.
   */
  setCollapsed(collapsed) {
    if (this.collapsed === collapsed) return this;
    this.collapsed = collapsed;
    this.dock.classList.toggle('collapsed', collapsed);
    this.#syncCollapseButton();
    this.onLayoutChange?.(collapsed);
    return this;
  }

  /** Put the dragged width where the dock's CSS reads it, or take it away. */
  #applyWidth() {
    if (this.width) this.host.style.setProperty('--t3-timeline-width', `${this.width}px`);
    else this.host.style.removeProperty('--t3-timeline-width');
  }

  /**
   * Drag the panel's left edge to resize it.
   *
   * Both layouts hang the panel off its right edge — floating it is pinned to
   * the viewport's right, docked it sits right of the chat — so the left edge is
   * the divider in either case, and dragging it left widens the panel. The
   * width is clamped so the chat keeps room to be readable, persisted so it
   * survives reloads, and reported through `onLayoutChange` because the panel's
   * header has to dodge T3 Code's floating controls differently at each width.
   */
  #wireResize(grip) {
    if (!grip) return;
    const max = () => {
      const room = this.docked ? window.innerWidth - 320 : window.innerWidth - 80;
      return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, room));
    };
    const set = (width, { persist = false } = {}) => {
      const next = Math.round(Math.max(MIN_WIDTH, Math.min(max(), width)));
      if (next === this.width) return;
      this.width = next;
      this.#applyWidth();
      this.onLayoutChange?.(this.collapsed);
      if (persist) saveWidth(next);
    };

    let origin = null;
    const follow = (e) => {
      if (origin) set(origin.width - (e.clientX - origin.x));
    };
    const end = () => {
      if (!origin) return;
      origin = null;
      this.dock.classList.remove('resizing');
      if (this.width) saveWidth(this.width);
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.collapsed) return;
      // The pointer belongs to the drag now; the app must not also act on it.
      e.preventDefault();
      e.stopPropagation();
      origin = { x: e.clientX, width: this.dock.getBoundingClientRect().width };
      this.dock.classList.add('resizing');
      // Not every pointer can be captured (a synthetic or already-released one
      // throws). The window listeners below are what actually keep the drag
      // tracking, so capture is only a shortcut.
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* no capture available */
      }
      window.addEventListener('pointermove', follow);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    grip.addEventListener('lostpointercapture', end);
    // No pointer at hand: the arrows do the same thing, and a double click
    // gives the width back to the layout.
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const now = this.dock.getBoundingClientRect().width || this.width || 420;
      const step = e.shiftKey ? 48 : 16;
      set(now + (e.key === 'ArrowLeft' ? step : -step), { persist: true });
    });
    grip.addEventListener('dblclick', () => {
      this.width = 0;
      this.#applyWidth();
      saveWidth(0);
      this.onLayoutChange?.(this.collapsed);
    });
  }

  /** The collapse button is its own inverse: `⟩` collapses, `⟨` expands. */
  #syncCollapseButton() {
    const button = this.dock.querySelector('.collapse');
    if (!button) return;
    button.textContent = this.collapsed ? '⟨' : '⟩';
    button.title = this.collapsed ? '展开' : '折叠';
  }

  setThread(thread) {
    this.thread = thread;
    const title = this.shadow.querySelector('.head h1');
    const sub = this.shadow.querySelector('.head .sub .thread');
    if (title) title.textContent = 'Timeline';
    if (sub) sub.textContent = thread?.title || thread?.id || '';
    return this;
  }

  /** Text under the empty state, updated live while the panel shows nothing. */
  setEmptyNote(note) {
    this.emptyNote = note || '';
    const el = this.shadow?.querySelector('.detail .empty');
    if (el) el.innerHTML = emptyMarkup(this.emptyNote);
    return this;
  }

  setNodes(nodes) {
    // First steps in, the playhead starts at the present — the end of the task
    // — and follows the tail from there. Once the reader has scrubbed back it
    // stays where they left it: an update must not undo a look at the history.
    const wasAtEnd = this.nodes.length === 0 || this.index >= this.nodes.length - 1;
    // A re-sync usually brings the same conversations back — a reply that has
    // grown a few tokens is the common case — and redrawing every dot and row
    // for that is the most expensive thing the panel does. Same ids *and* same
    // words is the same conversation; anything else is redrawn, and that
    // includes a conversation starting or finishing work (`busy`) or gaining the
    // note about what came after it (`stop`).
    const same = nodes.length === this.nodes.length &&
      nodes.every((n, k) => {
        const was = this.nodes[k];
        return n.id === was.id && n.text === was.text && n.reply === was.reply && n.busy === was.busy && n.stop === was.stop;
      });
    this.nodes = nodes;
    this.index = wasAtEnd ? Math.max(0, nodes.length - 1) : Math.max(0, Math.min(this.index, nodes.length - 1));
    if (!same) this.#paintFrame();
    this.#paintSelection();
    return this;
  }

  select(i) {
    if (!this.nodes.length) return this;
    this.index = Math.max(0, Math.min(i, this.nodes.length - 1));
    this.#paintSelection();
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
      <div class="grip" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度"
        tabindex="0" title="拖动调整宽度，双击还原"></div>
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
            <i>◆ 有回复</i><i>■ 没有回复 · 被打断或出错</i>
          </div>
        </div>
        <div class="detail"></div>
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
    this.#syncCollapseButton();
    this.#wireResize(dock.querySelector('.grip'));

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
    // Clicks on the dots are delegated: there are a few thousand of them, and
    // one listener per element costs more to build than the rest of the panel
    // put together.
    dock.querySelector('.dots').addEventListener('click', (e) => {
      const dot = e.target.closest('.dot');
      if (!dot) return;
      this.select([...dot.parentElement.children].indexOf(dot));
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

    this.shadow.querySelector('.badge').textContent = `${n} 次对话`;
    this.shadow.querySelector('.total').textContent = `${n} 次对话`;
    this.selected = -1;

    // One dot per conversation — the whole task is only ever this many dots, so
    // unlike a per-step track there is nothing to thin. A conversation the agent
    // never answered is the one worth spotting, so it is the one that takes a
    // different colour. Built as markup rather than elements: there can be
    // hundreds.
    const dots = this.shadow.querySelector('.dots');
    dots.innerHTML = this.nodes
      .map((nd, k) => {
        const label = esc(`${k + 1}. 第 ${k + 1} 次对话 — ${nd.summary}`);
        return `<span class="dot t${CONV.tier}" style="left:${at(k)}%;color:${accentOf(nd)}" title="${label}"></span>`;
      })
      .join('');
    this.dotEls = dots.children;

    // A ruler above the rail: one number per conversation, thinning out to fit.
    // The number is the conversation's place in the thread, not a run ordinal —
    // 144 conversations here against 113 runs, since what the user sends while a
    // run works splits it.
    const marks = [];
    let prevTurn = Symbol('none');
    this.nodes.forEach((nd, k) => {
      if (nd.turn === prevTurn) return;
      prevTurn = nd.turn;
      if (nd.turn != null) marks.push(k);
    });
    const width = this.shadow.querySelector('.track')?.clientWidth || 380;
    // Thinned by the space a number actually takes up, not by counting: 144
    // numbers do not fit in a 380px track, and dropping every n-th would still
    // leave three-digit neighbours overlapping at the right-hand end.
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
  }

  /** Everything that depends on which step is selected. Runs on every drag step. */
  #paintSelection() {
    const n = this.nodes.length;
    const i = Math.max(0, Math.min(this.index, Math.max(0, n - 1)));
    const node = this.nodes[i];
    const pct = n > 1 ? (i / (n - 1)) * 100 : 0;

    this.shadow.querySelector('.fill').style.width = `${pct}%`;
    this.shadow.querySelector('.handle').style.left = `${pct}%`;
    this.shadow.querySelector('.pos .n').textContent = n ? String(i + 1) : '–';
    // The count beside it reads "57 / 144 次对话", so this line is the *when*:
    // the panel's own label for the number would only say it twice.
    this.shadow.querySelector('.readout .turn').textContent = formatTime(node?.startedAt);

    if (this.selected !== i) {
      this.dotEls?.[this.selected]?.classList.remove('on');
      this.dotEls?.[i]?.classList.add('on');
      this.selected = i;
    }

    this.#paintDetail(node);
  }

  #paintDetail(node) {
    const el = this.shadow.querySelector('.detail');
    if (!node) {
      el.innerHTML = `<div class="empty">${emptyMarkup(this.emptyNote)}</div>`;
      return;
    }
    const head = `<div class="dhead">
        <span class="chip" style="color:${accentOf(node)}">${CONV.glyph} 第 ${node.index} 次对话</span>
        <span class="name" title="${esc(plainText(node.text))}">${esc(plainText(node.summary))}</span>
        <span class="when">${esc(formatTime(node.startedAt))}</span>
      </div>`;

    el.innerHTML = `${head}<div class="dscroll">${conversationBody(node)}</div>`;
  }
}

/** A conversation's colour, everywhere it is drawn: the panel's own palette for
 *  one the agent has answered or is answering, the error colour for one it
 *  never did. */
function accentOf(node) {
  return node.reply || node.busy ? CONV.accent : 'var(--tl-stop)';
}

/**
 * Why a conversation has nothing to show, in as few words as the data allows.
 *
 * Most of them are not failures: a user message sent while a run was still
 * working opens the next conversation, and the answer that run eventually
 * produced closes *that* one — which leaves this one with nothing to show, at
 * the moment it was actually asked. So the two worth naming are the interrupt
 * and the failure, and whether one of those ended this conversation rather than
 * the next is the data's to say (see `conversations`).
 */
function whyUnanswered(node) {
  // Not unanswered — unanswerable *yet*. Checked first: the live conversation is
  // the one a reader is most likely to be looking at.
  if (node.busy) return '正在回复…';
  if (node.stop === 'run_interrupt_request' || node.stop === 'run_interrupt_result') return '这一轮被打断，没有回复';
  if (node.stop === 'error') return `这一轮出错，没有回复${tail(node)}`;
  return '没有单独的回复';
}

/** The failure's own words, when they are short enough to sit beside the note.
 *  `oneLine` and not the raw text: a failure message runs to a whole stack. */
function tail(node) {
  return node.stopText ? ` · ${esc(oneLine(node.stopText, 120))}` : '';
}

/**
 * What the reply pane shows: the agent's answer, rendered.
 *
 * The question is already in the header line above it, and repeating it — let
 * alone the questions and answers of other conversations — only pushes the
 * thing being read off the screen. So the body is the reply and nothing else;
 * an unanswered conversation shows why, because that is its reply.
 */
function conversationBody(node) {
  if (!node.reply) {
    return node.busy
      ? '<div class="msg none">正在回复…</div>'
      : `<div class="msg none">${esc(whyUnanswered(node))}</div>`;
  }
  // A turn that failed often has the failure as its last *message* as well as an
  // error item after it, and printing the same sentence twice reads as two
  // things going wrong.
  const said = node.stopText && !node.reply.includes(node.stopText) ? tail(node) : '';
  const after = node.stop ? `<div class="outcome">这之后${node.stop === 'error' ? '出错' : '被打断'}${said}</div>` : '';
  return `<div class="msg md">${markdownMarkup(node.reply)}</div>${after}`;
}

/** The empty state, plus the host's note when it has one. */
function emptyMarkup(note) {
  return `这个线程还没有可记录的对话${note ? `<span class="note">${esc(note)}</span>` : ''}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

