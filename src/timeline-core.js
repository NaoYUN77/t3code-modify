// The substance of the timeline: which turn items become steps, and how to shape
// them for the panel. Kept free of DOM so it is trivially testable and shared by
// both the live client and the demo fixture.

// Everything the model *did* or *decided*, except its private reasoning.
// Reasoning is the one type left out: it is the model talking to itself, and it
// outnumbers everything else — 1379 of the thread's 3907 items.
export const KEY_TYPES = [
  'user_message',
  'user_input_request',
  'secret_request',
  'proposed_plan',
  'approval_request',
  'assistant_message',
  'subagent',
  'dynamic_tool',
  'command_execution',
  'web_search',
  'file_change',
  'checkpoint',
  'notification',
  'compaction',
  'run_interrupt_request',
  'run_interrupt_result',
  'error',
];

// `tier` is how much a step is worth reading versus how often it happens:
//   0  a decision, an answer, or a boundary — the bright dots on the track
//   1  a detail of one (a diff, a reply, a subagent)
//   2  texture: the tool calls, of which there are hundreds
//
// `accent` names a colour *role*, not a colour: the stylesheet decides what the
// role is worth, which is what lets the panel take T3 Code's theme (a theme
// names one accent, and the roles that have one in it follow it).
export const NODE_META = {
  conversation: { label: '对话', glyph: '◆', accent: 'var(--tl-user)', tier: 0 },
  user_message: { label: '用户消息', glyph: '◆', accent: 'var(--tl-user)', tier: 0 },
  user_input_request: { label: '提问', glyph: '?', accent: 'var(--tl-ask)', tier: 0 },
  secret_request: { label: '密钥', glyph: '⚿', accent: 'var(--tl-secret)', tier: 0 },
  proposed_plan: { label: '计划', glyph: '▤', accent: 'var(--tl-plan)', tier: 0 },
  approval_request: { label: '授权', glyph: '⚿', accent: 'var(--tl-apr)', tier: 0 },
  compaction: { label: '上下文压缩', glyph: '⇲', accent: 'var(--tl-terse)', tier: 0 },
  run_interrupt_request: { label: '打断', glyph: '■', accent: 'var(--tl-stop)', tier: 0 },
  run_interrupt_result: { label: '已打断', glyph: '■', accent: 'var(--tl-stop)', tier: 0 },
  checkpoint: { label: '还原点', glyph: '⏱', accent: 'var(--tl-ckpt)', tier: 0 },
  error: { label: '错误', glyph: '✕', accent: 'var(--tl-err)', tier: 0 },
  assistant_message: { label: '回答', glyph: '▸', accent: 'var(--tl-answer)', tier: 1 },
  subagent: { label: '子代理', glyph: '⧉', accent: 'var(--tl-sub)', tier: 1 },
  file_change: { label: '文件改动', glyph: '✎', accent: 'var(--tl-file)', tier: 1 },
  notification: { label: '通知', glyph: '⚑', accent: 'var(--tl-note)', tier: 1 },
  dynamic_tool: { label: '工具', glyph: '⚙', accent: 'var(--tl-tool)', tier: 2 },
  command_execution: { label: '命令', glyph: '›', accent: 'var(--tl-cmd)', tier: 2 },
  web_search: { label: '搜索', glyph: '⌕', accent: 'var(--tl-search)', tier: 2 },
};

export function isKeyType(type) {
  return KEY_TYPES.includes(type);
}

/** `run:thread:<tid>:ordinal:<N>` -> N (the turn count getTurnDiff uses). */
export function turnFromRunId(runId) {
  if (!runId) return null;
  const n = Number(String(runId).split(':').pop());
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one item into a timeline node.
 * Accepts either a projected item `{ position, visibility, item }` (what the
 * server sends) or an already-flattened fixture node.
 */
export function toNode(raw) {
  const item = raw.item ?? raw;
  const type = item.type;
  if (!isKeyType(type)) return null;
  const node = {
    // The ordinal is global to the thread, so steps from a full snapshot and
    // from a re-sync's window stay comparable (see `mergeNodes`).
    position: item.ordinal ?? raw.position ?? 0,
    id: item.id ?? raw.sourceItemId,
    type,
    status: item.status,
    runId: item.runId ?? null,
    turn: turnFromRunId(item.runId),
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? null,
    title: item.title ?? null,
    raw: item,
  };
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      node.text = item.text ?? '';
      break;
    case 'proposed_plan':
      node.text = item.markdown ?? '';
      break;
    case 'file_change': {
      node.fileName = item.fileName;
      node.diff = item.diffStr ?? '';
      // The server often leaves the counts out; the diff text always has them.
      const counts = countDiff(node.diff);
      node.additions = item.additions ?? counts.additions;
      node.deletions = item.deletions ?? counts.deletions;
      break;
    }
    case 'checkpoint':
      node.files = item.files ?? [];
      node.filesTotal = item.filesTotal ?? null;
      // The host fetches the turn's diff and hands it back in through here, as
      // it does for a file change. The snapshot's own file list is usually
      // empty (5 of 79 on the thread this was built against), so when it is,
      // the turn's changes stand in for it — flagged, because they are a
      // different thing and the summary says so.
      if (item.diffStr) {
        node.diff = item.diffStr;
        if (!node.files.length && !node.filesTotal) {
          node.files = filesFromDiff(item.diffStr);
          node.filesFromDiff = true;
        }
      }
      break;
    case 'user_input_request':
      node.questions = item.questions ?? [];
      node.answer = item.questionAnswer ?? null;
      node.text = firstQuestion(item);
      break;
    case 'secret_request':
      node.label = item.label ?? item.title ?? '';
      node.reason = item.reason ?? '';
      node.placeholder = item.placeholder ?? '';
      node.secretStatus = item.secretStatus ?? item.status ?? '';
      // A turn can end on this ask, so it needs a line of its own text the way
      // an answer does — `label` and `reason` are the two that say what was
      // asked for and why.
      node.text = [node.label, node.reason].filter(Boolean).join(' — ');
      break;
    case 'approval_request':
      node.text = item.prompt ?? item.reason ?? '';
      break;
    case 'dynamic_tool':
      node.toolName = item.toolName ?? item.title ?? '工具';
      node.toolArgs = toolArgs(item);
      node.output = outputText(item.output);
      node.outputOmitted = item.outputOmitted === true;
      break;
    case 'command_execution':
      node.command = item.input ?? '';
      node.output = outputText(item.output);
      node.outputOmitted = item.outputOmitted === true;
      break;
    case 'web_search':
      node.patterns = item.patterns ?? [];
      node.results = item.results ?? [];
      break;
    case 'subagent':
      node.prompt = item.prompt ?? '';
      node.result = item.result ?? '';
      node.progress = item.progress ?? '';
      break;
    case 'notification':
      // `summary` is this node's row label, so the notice's own text goes apart.
      node.notice = item.summary ?? item.message ?? '';
      node.outcome = item.outcome ?? '';
      break;
    case 'compaction':
      node.before = item.beforeTokenCount ?? null;
      node.after = item.afterTokenCount ?? null;
      break;
    case 'run_interrupt_request':
    case 'run_interrupt_result':
      node.message = item.message ?? '';
      break;
    case 'error':
      node.text = item.failure?.message ?? item.failure?.code ?? '执行出错';
      break;
    default:
      break;
  }
  node.summary = summarise(node);
  return node;
}

function firstQuestion(item) {
  const q = item.questions?.[0];
  if (!q) return '';
  return q.question ?? q.header ?? q.text ?? '';
}

/** A tool call's arguments. The projection sends them as JSON text, the store as
 *  an object; both are normalised to an object so the detail pane can lay them
 *  out, with the raw text kept when it will not parse. */
function toolArgs(item) {
  const raw = item.input ?? item.arguments ?? null;
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { input: raw };
  } catch {
    return { input: String(raw) };
  }
}

/**
 * A tool's output is not always text. Some tools hand back a structured result
 * — a file read comes back as `{ type, file: { filePath, content } }`, an
 * MCP tool as a list of content blocks — and rendering the object itself gets
 * the reader `[object Object]`. Pull the text out of the shapes in use and fall
 * back to pretty JSON for anything else.
 */
export function outputText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map(outputText).filter(Boolean).join('\n\n');
  if (typeof out === 'object') {
    if (typeof out.text === 'string') return out.text;
    if (out.content != null) return outputText(out.content);
    if (out.file && typeof out.file.content === 'string') return out.file.content;
    if (typeof out.message === 'string') return out.message;
    try {
      return JSON.stringify(out, null, 2);
    } catch {
      return String(out);
    }
  }
  return String(out);
}

// The argument that says what a call acted on, most specific first.
const ARG_HINT_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'command',
  'query',
  'url',
  'description',
  'prompt',
  'skill',
  'agent',
];

export function argHint(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ARG_HINT_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v) return v;
  }
  const firstString = Object.values(args).find((v) => typeof v === 'string' && v);
  return typeof firstString === 'string' ? firstString : '';
}

export function summarise(node) {
  switch (node.type) {
    // A conversation is its user message: what was asked is the row, and the
    // answer gets its own line under it.
    case 'conversation':
      return oneLine(node.text, 90) || '（空消息）';
    case 'user_message':
    case 'assistant_message':
    case 'proposed_plan':
      return oneLine(node.text, 90);
    case 'file_change': {
      const name = shortPath(node.fileName);
      // The counts are only known once the diff has been fetched, and " +0 −0"
      // on a change nobody has read yet looks like a change that did nothing.
      if (!node.diff && !node.additions && !node.deletions) return name;
      return `${name}  +${node.additions ?? '?'} −${node.deletions ?? '?'}`;
    }
    case 'checkpoint': {
      const n = node.filesTotal?.count ?? node.files?.length ?? 0;
      // Which list it is matters: the snapshot's, or the turn's changes standing
      // in for a snapshot that recorded none.
      return node.filesFromDiff
        ? `第 ${node.turn ?? '?'} 轮快照 · 本轮改动 ${n} 个文件`
        : `第 ${node.turn ?? '?'} 轮快照 · ${n} 个文件`;
    }
    case 'user_input_request':
      return oneLine(node.text, 90) || '向用户提问';
    case 'secret_request':
      return `密钥 · ${oneLine(node.label, 70)}`;
    case 'approval_request':
      return oneLine(node.text, 90) || '请求授权';
    case 'dynamic_tool': {
      const hint = argHint(node.toolArgs);
      return `${shortTool(node.toolName)}${hint ? `  ${oneLine(hint, 70)}` : ''}`;
    }
    case 'command_execution':
      return oneLine(stripCd(node.command), 90) || '命令';
    case 'web_search':
      return `搜索 ${node.patterns.map((p) => oneLine(p, 30)).join(' / ') || ''}`.trim();
    case 'subagent':
      return `子代理 · ${oneLine(node.title || node.prompt, 70)}`;
    case 'notification':
      return oneLine(node.notice, 90) || '通知';
    case 'compaction':
      return `上下文压缩 ${tokens(node.before)} → ${tokens(node.after)}`;
    case 'run_interrupt_request':
    case 'run_interrupt_result':
      return node.message || '打断';
    case 'error':
      return oneLine(node.text, 90) || '执行出错';
    default:
      return node.type;
  }
}

/**
 * Commands almost always open with `cd <project> &&`, which is the same
 * directory every time and eats the whole width of a one-line row. Only the
 * summary has it taken off; the detail pane still shows what was run.
 */
export function stripCd(command) {
  return String(command ?? '').replace(/^\s*cd\s+[^&;|\n]+?\s*(?:&&|;)\s*/, '');
}

/** `mcp__server__tool` is too long for a row; the tool is the last segment. */
export function shortTool(name) {
  const s = String(name ?? '工具');
  return s.includes('__') ? s.split('__').slice(-2).join(' · ') : s;
}

function tokens(n) {
  return n == null ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function oneLine(text, max = 100) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function shortPath(p) {
  if (!p) return '(未知文件)';
  const parts = String(p).split('/').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * The kinds of step that put something in front of the user: the agent's answer,
 * the question it stopped to ask, the key or the permission it asked for. The
 * last of these in a conversation is what the agent had to say — which is not
 * always an `assistant_message`, because a turn can end on a question.
 */
export const AGENT_TAILS = ['assistant_message', 'user_input_request', 'secret_request', 'approval_request'];

/**
 * Group a thread's steps into conversations.
 *
 * A conversation is bounded by what the user said: one user message opens one,
 * the next user message closes it. Everything the agent did in between — its
 * tool calls, its file changes, its asides on the way — is counted and dropped,
 * because what a reader wants back from a task is what they asked for and what
 * came of it. The answer is the *last* thing the agent put in front of them
 * before the next thing the user said.
 *
 * Steps before the first user message (a run woken by a notification, say) have
 * no conversation to belong to and are left out; so is `node.steps`, which is
 * only ever used to say how much was skipped.
 *
 * `turn` on the result counts *conversations*, not runs. The run ordinal is what
 * diffs and restore points are keyed by (`run:thread:<id>:ordinal:<N>`), and the
 * two are not the same number: everything the user sends while a run is still
 * working splits that run into more than one conversation.
 */
export function conversations(nodes) {
  const groups = [];
  let current = null;
  for (const node of nodes) {
    if (node.type === 'user_message') {
      current = { user: node, tail: null, stop: null, last: node, steps: 0, busy: false };
      groups.push(current);
    } else if (current) {
      current.steps += 1;
      current.last = node;
      if (AGENT_TAILS.includes(node.type)) current.tail = node;
      else if (node.type === 'run_interrupt_request' || node.type === 'run_interrupt_result' || node.type === 'error') {
        current.stop = node;
      }
    } else {
      continue;
    }
    // A turn item still `running` means this conversation has no last word *yet*
    // — the work is in flight and the reply is on its way. Marked only on the
    // last conversation: one run works at a time, so an item left `running` in an
    // older conversation is stale (a run killed mid-item leaves one) and saying
    // "still working" about it forever would be worse than saying nothing.
    if (node.status === 'running') current.busy = true;
  }

  return groups.map((g, k) => {
    // An interrupt or a failure only ends the conversation if it came after the
    // agent's last word — otherwise it is what the *next* answer interrupted.
    const stop = g.stop && (!g.tail || g.stop.position > g.tail.position) ? g.stop : null;
    const node = {
      position: g.user.position,
      id: `conversation:${g.user.id}`,
      type: 'conversation',
      index: k + 1,
      turn: k + 1,
      text: g.user.text ?? '',
      // Every tail kind carries its own text; `summary` is the fallback for one
      // that does not, so a turn can never read as unanswered when it was not.
      reply: g.tail ? g.tail.text || g.tail.summary || '' : '',
      replyKind: g.tail?.type ?? null,
      stop: stop?.type ?? null,
      stopText: stop ? stop.message ?? stop.text ?? '' : '',
      busy: g.busy && k === groups.length - 1,
      steps: g.steps,
      startedAt: g.user.startedAt ?? null,
      endedAt: g.last.completedAt ?? g.last.startedAt ?? null,
      raw: g.user.raw,
    };
    node.summary = summarise(node);
    return node;
  });
}

export function stats(nodes) {
  const count = (types) => nodes.filter((n) => types.includes(n.type)).length;
  return {
    nodes: nodes.length,
    users: count(['user_message']),
    tools: count(['dynamic_tool', 'command_execution', 'web_search', 'subagent']),
    changes: count(['file_change']),
    checkpoints: count(['checkpoint']),
    turns: new Set(nodes.map((n) => n.turn).filter((t) => t != null)).size,
  };
}

/** Count added/removed lines in a unified diff (ignoring the +++/--- headers). */
export function countDiff(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/**
 * A unified diff's per-file changes, in the shape a checkpoint lists files in.
 *
 * A checkpoint's own `files` is a snapshot and is usually empty — 5 of the 79
 * on the thread this was built against — so the file list is read back out of
 * the turn diff instead.
 */
export function filesFromDiff(diff) {
  const files = [];
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      current = { path: m ? m[1] : line.slice('diff --git '.length), additions: 0, deletions: 0 };
      files.push(current);
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      // the file headers themselves, not content
    } else if (!current) {
      continue;
    } else if (line.startsWith('+')) {
      current.additions += 1;
    } else if (line.startsWith('-')) {
      current.deletions += 1;
    }
  }
  return files;
}
