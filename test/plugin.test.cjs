// Logic checks for the plugin's fold: what opens, what must not.
// Run with: node test/plugin.test.js
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const clientPath = path.join(__dirname, '..', 'client.js');
const code = fs.readFileSync(clientPath, 'utf8');

let registration;
const sandbox = {
  window: { __ModuleLoader__: { load(r) { registration = r; } } },
  console,
  encodeURIComponent,
  JSON,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
assert.ok(registration, 'client.js must register a module');

const plugin = registration.factory(() => { throw new Error('unexpected require'); });

/** A console face just wide enough for what the plugin uses. */
function harness() {
  const calls = [];
  const listeners = new Set();
  const tabs = [];
  let mounted;
  const ctx = {
    effect(fn) { fn(); },
    get: () => ctx.sidebarRight,
    sessions: { binding: () => ({ eventSource: ctx.__src }) },
    sidebarRight: {
      mounted: {
        getSnapshot: () => mounted,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      },
      openTabs: { getSnapshot: () => tabs },
      openResource(address, options) {
        calls.push({ address, options });
        tabs.push({ sessionId: 's1', tabId: 'tab' + calls.length, kind: 'text', contentId: address });
      },
    },
    __calls: calls,
    __setMounted(id) { mounted = id; for (const fn of listeners) fn(); },
  };
  return ctx;
}

/** A fake event source publishing the same window/change shape the real one does. */
function source(initial = []) {
  const entries = [...initial];
  const subs = new Set();
  let change = { kind: 'replace', entries };
  return {
    getSnapshot: () => ({ entries, change, hasMore: false, revision: 0 }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    append(event, seq) {
      const added = [{ type: 'event', event: { ...event, seq } }];
      entries.push(...added);
      change = { kind: 'append', entries: added };
      for (const fn of subs) fn();
    },
    replaceAll(list) {
      entries.length = 0;
      entries.push(...list);
      change = { kind: 'replace', entries };
      for (const fn of subs) fn();
    },
    get subscriberCount() { return subs.size; },
  };
}

const call = (seq, id, filePath) => ({
  type: 'tool/call', seq,
  data: { callId: id, name: 'read_image', arguments: JSON.stringify({ file_path: filePath }) },
});
const otherCall = (seq, id, name, filePath) => ({
  type: 'tool/call', seq,
  data: { callId: id, name, arguments: JSON.stringify({ file_path: filePath }) },
});
const result = (seq, id, isError) => ({
  type: 'tool/result', seq, data: { message: { isError: !!isError, source: { callId: id } } },
});

const fail = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
  if (!ok) fail.push(label);
}

// --- A successful read opens the image, at the Session-scoped address.
{
  const ctx = harness();
  ctx.__src = source([]);
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  check('watches the viewed Session', ctx.__src.subscriberCount, 1);

  ctx.__src.append(call(1, 'c1', 'C:\\pics\\a.png'), 1);
  ctx.__src.append(result(2, 'c1', false), 2);
  check('opens on success', ctx.__calls.length, 1);
  check('address', ctx.__calls[0].address, 'dsh-resource://file/session/s1/C:/pics/a.png');
}

// --- A failed read opens nothing.
{
  const ctx = harness();
  ctx.__src = source([]);
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  ctx.__src.append(call(1, 'c1', 'missing.png'), 1);
  ctx.__src.append(result(2, 'c1', true), 2);
  check('failed read opens nothing', ctx.__calls.length, 0);
}

// --- Only image extensions count, and only from read_image.
{
  const ctx = harness();
  ctx.__src = source([]);
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  ctx.__src.append(call(1, 'c1', 'notes.txt'), 1);
  ctx.__src.append(result(2, 'c1', false), 2);
  ctx.__src.append(otherCall(3, 'c2', 'read', 'x.png'), 3);
  ctx.__src.append(result(4, 'c2', false), 4);
  check('non-image and other tools ignored', ctx.__calls.length, 0);
}

// --- A second image replaces the first tab.
{
  const ctx = harness();
  ctx.__src = source([]);
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  ctx.__src.append(call(1, 'c1', 'a.png'), 1);
  ctx.__src.append(result(2, 'c1', false), 2);
  ctx.__src.append(call(3, 'c2', 'sub/b.JPEG'), 3);
  ctx.__src.append(result(4, 'c2', false), 4);
  check('second open replaces the first', JSON.stringify(ctx.__calls[1].options), JSON.stringify({ replaceTab: 'tab1' }));
  check('uppercase extension accepted', ctx.__calls[1].address, 'dsh-resource://file/session/s1/sub/b.JPEG');
}

// --- A Session whose history already holds a read_image must not replay it.
{
  const ctx = harness();
  ctx.__src = source([
    { type: 'event', event: call(1, 'old', 'past.png') },
    { type: 'event', event: result(2, 'old', false) },
  ]);
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  check('history does not replay', ctx.__calls.length, 0);
  ctx.__src.append(call(3, 'new', 'fresh.png'), 3);
  ctx.__src.append(result(4, 'new', false), 4);
  check('live read after history opens', ctx.__calls.length, 1);
}

// --- A reloaded window is history, not news.
{
  const ctx = harness();
  ctx.__src = source([]);
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  ctx.__src.replaceAll([
    { type: 'event', event: call(1, 'h', 'loaded.png') },
    { type: 'event', event: result(2, 'h', false) },
  ]);
  check('reloaded window opens nothing', ctx.__calls.length, 0);
}

// --- Switching Sessions releases the old watcher.
{
  const ctx = harness();
  const first = source([]);
  const second = source([]);
  ctx.sessions = { binding: (id) => ({ eventSource: id === 's1' ? first : second }) };
  ctx.__src = first;
  plugin.apply(ctx);
  ctx.__setMounted('s1');
  ctx.__setMounted('s2');
  check('old Session released', first.subscriberCount, 0);
  first.append(call(1, 'z1', 'x.png'), 1);
  first.append(result(2, 'z1', false), 2);
  check('hidden Session opens nothing', ctx.__calls.length, 0);
  second.append(call(3, 'z2', 'y.png'), 3);
  second.append(result(4, 'z2', false), 4);
  check('visible Session opens', ctx.__calls.length, 1);
}

if (fail.length > 0) {
  console.error(`\n${fail.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
