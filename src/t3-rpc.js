// Minimal T3 Code client for the orchestration RPC, over the same WebSocket
// the official client uses.
//
// T3 Code v0.1.7 speaks effect-RPC with JSON serialization (content-type
// `application/json`, no framing) on `/ws`. A browser cannot set custom
// headers on a WebSocket, so the protocol version travels in the query string
// and the credential is exchanged for a one-time ticket over HTTP first:
//
//   POST /api/auth/websocket-ticket   -> { ticket }
//   ws://host/ws?orchestrationProtocol=2&wsTicket=<ticket>
//
// Frames are plain JSON:
//   -> { _tag: "Request", id, tag, payload, headers: [] }
//   <- { _tag: "Chunk", requestId, values: [...] }   (streaming)
//   <- { _tag: "Exit",  requestId, exit: { _tag: "Success"|"Failure", ... } }
//   <- { _tag: "Defect", requestId, defect }

export const ORCHESTRATION_PROTOCOL = 2;

/**
 * Exchange the session for a one-time socket ticket.
 *
 * In the web client everything is same-origin: a relative path and the cookie
 * the browser already holds. In the desktop app the renderer is local and the
 * server is remote, and it authenticates with a bearer token instead, so the
 * caller passes the address, the ticket route and the headers the app itself
 * used (`transport` in t3-timeline.js).
 */
async function websocketTicket({ base = '', ticketPath = '/api/auth/websocket-ticket', headers = {} } = {}) {
  const res = await fetch(`${base}${ticketPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`websocket ticket failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const { ticket } = await res.json();
  if (!ticket) throw new Error('websocket ticket missing');
  return ticket;
}

export class T3Client extends EventTarget {
  constructor(transport = {}) {
    super();
    this.transport = transport;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const { base = '' } = this.transport;
    // A renderer loaded from the app bundle has no host of its own; without a
    // captured server address there is nothing to talk to yet.
    if (!base && !location.host) throw new Error('还没有拿到服务器地址');
    const ticket = await websocketTicket(this.transport);
    // Same origin when no base is given; the desktop app's remote server
    // otherwise. `new URL` keeps any path the base carries.
    const socket = new URL('/ws', base || `${location.protocol}//${location.host}`);
    socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    const url =
      `${socket.origin}${socket.pathname}` +
      `?orchestrationProtocol=${ORCHESTRATION_PROTOCOL}` +
      `&wsTicket=${encodeURIComponent(ticket)}`;

    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket connection failed'));
    });

    ws.onmessage = (e) => this.#onFrame(JSON.parse(e.data));
    ws.onclose = (e) => this.dispatchEvent(new CustomEvent('closed', { detail: e }));
    return this;
  }

  #onFrame(frame) {
    if (Array.isArray(frame)) {
      for (const f of frame) this.#onFrame(f);
      return;
    }
    const entry = this.pending.get(frame.requestId);
    if (!entry) return;
    if (frame._tag === 'Chunk') {
      for (const value of frame.values ?? []) entry.push(value);
      return;
    }
    if (frame._tag === 'Exit') {
      this.pending.delete(frame.requestId);
      if (frame.exit._tag === 'Failure') {
        entry.fail(new Error(frame.exit.cause?.[0]?.error?.message ?? 'rpc failed'));
      } else {
        entry.finish(frame.exit.value);
      }
      return;
    }
    if (frame._tag === 'Defect') {
      this.pending.delete(frame.requestId);
      entry.fail(new Error(String(frame.defect)));
    }
  }

  /** One request; resolves with the final Exit value. */
  call(tag, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { push: () => {}, finish: resolve, fail: reject });
      this.ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    });
  }

  /**
   * A streaming request as an async iterable of chunk values. The generator
   * finishes when the server sends Exit.
   */
  async *stream(tag, payload) {
    const id = this.nextId++;
    const queue = [];
    let wake = null;
    let done = false;
    let error = null;
    const signal = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    this.pending.set(id, {
      push: (v) => {
        queue.push(v);
        signal();
      },
      finish: () => {
        done = true;
        signal();
      },
      fail: (e) => {
        error = e;
        done = true;
        signal();
      },
    });
    this.ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    while (!done || queue.length) {
      if (!queue.length) await new Promise((r) => (wake = r));
      if (error) throw error;
      while (queue.length) yield queue.shift();
    }
    if (error) throw error;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

// --- the parts of the orchestration API this panel needs -------------------

export const rpc = {
  getThreadProjection: 'orchestration.getThreadProjection',
  subscribeThread: 'orchestration.subscribeThread',
};

export function subscribeThread(client, threadId) {
  return client.stream(rpc.subscribeThread, { threadId });
}
