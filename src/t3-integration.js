// Fit the timeline into T3 Code's own thread page, rather than floating over
// it.
//
// Two insertion points, both found from the live DOM (T3 ships no test hooks,
// so these are structural selectors with fallbacks):
//
//   1. the thread page's layout row      -> the panel becomes a column beside
//      `main[data-slot="sidebar-inset"] > div > div`   the chat, so the chat
//                                                      makes room for it
//   2. the thread header's control group -> our toggle button, *cloned from
//      `button[aria-label="Toggle thread details panel"]`  T3's own toggle so
//                                                      it inherits its styling
//
// React owns both parents, so anything it removes is re-inserted by the
// observer below.

const PANEL_HOST_ID = 't3-timeline-host';
const BUTTON_ATTR = 'data-t3-timeline-toggle';
const log = (...a) => window.__T3_TIMELINE_DEBUG && console.log('[timeline]', ...a);

function layoutRow() {
  const main = document.querySelector('main[data-slot="sidebar-inset"]') ?? document.querySelector('main');
  if (!main) return null;
  const row = main.querySelector(':scope > div');
  if (!row) return null;

  // The chat column is the one that owns the thread toolbar — identified by
  // walking up from a control inside it, not by position. "First div in the
  // row" breaks as soon as the client opens one of its own right-hand panels,
  // and it also matches our own host once that is in the row, which would make
  // the placement depend on its own previous result.
  const ref = controlsRef();
  let chat = null;
  for (let el = ref?.parentElement; el && el !== row; el = el.parentElement) chat = el;
  if (!chat || chat.parentElement !== row) {
    chat = row.querySelector(':scope > div:not([id="t3-timeline-host"])');
  }
  return chat ? { main, row, chat } : null;
}

function controlsRef() {
  return (
    document.querySelector('button[aria-label="Toggle thread details panel"]') ??
    document.querySelector('button[aria-label="Toggle right panel"]') ??
    document.querySelector('button[aria-label="Toggle terminal drawer"]')
  );
}

function toolbarAnchor() {
  const ref = controlsRef();
  return ref ? ref.closest('[data-slot="tooltip-trigger"]') ?? ref : null;
}

/** The fixed, z-50 box T3 floats over the viewport's top-right corner. */
function controlsGroup() {
  const ref = controlsRef();
  return ref ? ref.closest('div[class*="fixed"]') ?? ref : null;
}

/**
 * Everything floating in that corner, as one box.
 *
 * The controls live in more than one such container — the panel toggles sit in
 * one and "Maximize panel" in a sibling — and each is positioned by the same
 * custom property, so that property is what identifies them.
 */
function controlsStrip() {
  const containers = [...document.querySelectorAll('[class*="workspace-controls-right"]')];
  if (!containers.length) {
    const group = controlsGroup();
    if (group) containers.push(group);
  }
  const boxes = [];
  for (const el of containers) {
    for (const node of [el, ...el.querySelectorAll('button')]) {
      const r = node.getBoundingClientRect();
      // A button can sit outside its container's own box: "Maximize panel" is
      // hung off the group with `absolute right-full`, and the container's
      // rect does not cover it.
      if (r.width && r.height) boxes.push(r);
    }
  }
  if (!boxes.length) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    right: Math.max(...boxes.map((b) => b.right)),
    top: Math.min(...boxes.map((b) => b.top)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/**
 * How light a colour is, 0..1 — or null if the browser will not read it.
 *
 * Through a canvas, because the app's colours are `oklch(...)` as often as they
 * are hex, and a computed value keeps the colour space it was written in, so
 * there is nothing to parse without rendering it. The colour is assigned over a
 * sentinel: if the assignment is refused the sentinel is still there and the
 * answer is "cannot tell".
 */
function lightness(color) {
  if (!color) return null;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = 'rgb(1, 2, 3)';
  ctx.fillStyle = color;
  if (ctx.fillStyle === '#010203') return null;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Which appearance the app is in, asked of the app.
 *
 * How the app says it: it toggles a `dark` class on the root element — the same
 * switch its own `useTheme` uses, and the one its stylesheet is written against
 * (`.dark`, `.dark *`) — so that class is the first answer. Failing that, the
 * canvas colour says it by its lightness, through the canvas above. Failing
 * that, the system preference does, which is the app's own last resort too.
 */
export function readAppearance(root = document.documentElement) {
  if (root.classList.contains('dark')) return 'dark';
  const cs = getComputedStyle(root);
  // A theme writes --app-theme-canvas; with no theme the page's own --background
  // is the canvas. Either says the appearance by how light it is.
  const canvas = cs.getPropertyValue('--app-theme-canvas').trim() || cs.getPropertyValue('--background').trim();
  const canvasLightness = lightness(canvas);
  if (canvasLightness != null) return canvasLightness > 0.5 ? 'light' : 'dark';
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4">' +
  '<path d="M3 12h4l2.5-6 3 12 2.5-6h6"/></svg>';

export class Integration {
  constructor(panel) {
    this.panel = panel;
    this.active = false;
    this.pending = false;
    this.observer = null;
    this.button = null;
    this.tries = 0;
    this.retryTimer = null;
  }

  start() {
    this.observer = new MutationObserver(() => this.#schedule());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.onResize = () => this.#schedule();
    window.addEventListener('resize', this.onResize);
    // The panel's own close button changes the same state the toggle shows.
    this.panel.onOpenChange = () => this.#sync();
    // Collapsing changes the panel's footprint, and docked that decides where
    // its two buttons have to sit to stay clear of the app's floating controls
    // — a measurement only this side can make.
    this.panel.onLayoutChange = () => this.#reserveControlsSpace();

    // The theme is the app's business and it can change under us — a user theme,
    // the appearance setting, or the system. The colours themselves arrive by
    // inheritance, so there is nothing to copy; what has to be passed on is
    // which appearance they are, for the handful of choices T3 Code has no token
    // for. Watching the root element's own attributes is what the app watches
    // too, and it is where a theme is applied.
    this.themeObserver = new MutationObserver(() => this.#syncAppearance());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    this.onScheme = () => this.#syncAppearance();
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', this.onScheme);

    this.#syncAppearance();
    this.#sync();
    return this;
  }

  setActive(active) {
    this.active = active;
    this.#sync();
    return this;
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    if (this.onScheme) matchMedia('(prefers-color-scheme: light)').removeEventListener('change', this.onScheme);
  }

  #syncAppearance() {
    this.panel.setAppearance(readAppearance());
  }

  // A timer, not requestAnimationFrame: frames stop being produced when the
  // window is not visible, which would strand the retry loop below.
  #schedule() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.#sync();
    }, 0);
  }

  #sync() {
    if (!this.active) {
      this.#removeButton();
      this.panel.setVisible(false);
      return;
    }
    // The toggle has to survive the panel being closed — it is what reopens it.
    this.#placePanel();
    this.#placeButton();
  }

  #placePanel() {
    const layout = layoutRow();
    if (!layout) {
      // The client renders the thread page asynchronously, and a page that has
      // already settled produces no more mutations to wake the observer — so
      // retry on a timer until the layout shows up.
      this.panel.setVisible(false);
      if (this.active && this.tries < 120) {
        this.tries += 1;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.#sync(), 250);
      }
      return;
    }
    this.tries = 0;
    clearTimeout(this.retryTimer);
    const host = this.panel.host;
    if (host.parentElement !== layout.row || host.previousSibling !== layout.chat) {
      layout.row.insertBefore(host, layout.chat.nextSibling);
      log('docked panel beside chat');
    }
    this.panel.setDocked(true);
    this.panel.setVisible(this.panel.open);
    this.#reserveControlsSpace();
  }

  /**
   * Hand our header's overlap with T3's floating thread controls to CSS.
   *
   * That group is `position: fixed` against the viewport's top-right, so a
   * panel docked at the right edge is always underneath it — measured rather
   * than assumed, since the group also moves when a sidebar opens or the window
   * narrows, and a hard-coded width would then be wrong in both directions.
   */
  #reserveControlsSpace() {
    const host = this.panel.host;
    const g = controlsStrip();
    if (!g) return;
    const h = host.getBoundingClientRect();
    if (!h.width) return;

    const GAP = 8;
    // Collapsed, the strip is 34px against the same right edge the controls
    // hang over, so it cannot dodge sideways: it goes under them instead, and
    // its header starts below wherever they end.
    if (this.panel.collapsed) {
      host.style.setProperty('--t3-head-inset', '0px');
      host.style.setProperty('--t3-head-top', `${Math.max(0, Math.round(g.bottom - h.top + GAP))}px`);
      return;
    }
    host.style.setProperty('--t3-head-top', '0px');
    const overlap = Math.min(h.right, g.right) - Math.max(h.left, g.left);
    if (overlap <= 0) {
      host.style.setProperty('--t3-head-inset', '0px');
      return;
    }
    // Measured from our own right edge: the group need not reach it, and the
    // slack to its right would otherwise be double-counted.
    const reserved = Math.min(h.width, h.right - Math.max(g.left, h.left) + GAP);
    host.style.setProperty('--t3-head-inset', `${Math.round(reserved)}px`);
  }

  #placeButton() {
    const anchor = toolbarAnchor();
    if (!anchor) {
      this.#removeButton();
      return;
    }
    if (this.button?.parentElement && this.button.previousSibling === anchor) {
      this.#syncButtonState();
      return;
    }
    const clone = anchor.cloneNode(true);
    clone.removeAttribute('id');
    clone.setAttribute(BUTTON_ATTR, '');
    clone.removeAttribute('data-popover-trigger');
    const button = clone.matches('button') ? clone : clone.querySelector('button');
    if (!button) return;
    button.setAttribute('data-slot', 'toggle');
    button.setAttribute('aria-label', 'Toggle timeline');
    button.setAttribute('title', 'Timeline');
    button.removeAttribute('popover-trigger');
    button.removeAttribute('aria-haspopup');
    button.removeAttribute('aria-expanded');
    button.querySelector('svg')?.replaceWith(document.createRange().createContextualFragment(ICON));
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.panel.setOpen(!this.panel.open);
      this.#sync();
    });
    anchor.after(clone);
    this.button = clone;
    this.#syncButtonState();
  }

  #syncButtonState() {
    const btn = this.button?.matches('button') ? this.button : this.button?.querySelector('button');
    // The app's own panel toggles use aria-pressed to carry "open", which is
    // what gives the filled, active look.
    btn?.setAttribute('aria-pressed', String(this.panel.open));
  }

  #removeButton() {
    this.button?.remove();
    this.button = null;
  }
}
