import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { RecentTranscripts } from '../public/recent-transcripts.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('recent transcripts are bounded, LRU, and oversized images are not retained', () => {
  const cache = new RecentTranscripts(2, 12);
  const snapshot = (text) => ({ entries: [{ text }] });
  cache.put('a', snapshot('aaa'));
  cache.put('b', snapshot('bbbb'));
  cache.put('a', cache.take('a')); // a is now most recent
  cache.put('c', snapshot('ccccc'));
  assert.equal(cache.take('b'), undefined);
  assert.equal(cache.take('a').entries[0].text, 'aaa');
  cache.put('big', { entries: [{ images: [{ data: 'x'.repeat(13) }] }] });
  assert.equal(cache.take('big'), undefined);
  cache.put('d', snapshot('123456789'));
  cache.put('e', snapshot('1234')); // combined size exceeds 12
  assert.equal(cache.take('d'), undefined);
  assert.equal(cache.take('e').entries[0].text, '1234');
  cache.delete('c');
  assert.equal(cache.take('c'), undefined);
});

test('cached transcript remains visible until replay completes; stale streams cannot mutate it', () => {
  const code = source.slice(source.indexOf('function connectStream(id) {'), source.indexOf('async function refreshThreadUsageDetails'));
  const streams = [];
  class EventSource {
    constructor() { this.handlers = new Map(); streams.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    emit(type, data) { this.handlers.get(type)?.({ data: JSON.stringify(data) }); }
    close() {}
  }
  const state = { stream: null, entries: ['cached'], configOptions: [], progressTurns: [], currentId: 'a', modelFavorites: [] };
  const rendered = [], processed = [];
  const context = { state, EventSource, clearTimeout, setTimeout, JSON, console,
    setConnection() {}, hydrateProgress: x => x, applyModelFavorites: x => x,
    renderUsageLabel() {}, refreshThreadUsageDetails() {}, refreshSubscriptionUsage() {}, applyConfigLabels() {},
    showToast() {}, finishProgress() {},
    resetTranscript() { state.entries = []; },
    handleHydra(data) { state.entries.push(data.text); processed.push(data.text); },
    addPermission() {}, handleConsole() {},
    renderTranscript() { rendered.push([...state.entries]); }
  };
  vm.runInNewContext(`let replayingHistory = false; ${code}\nthis.connectStream = connectStream;`, context);
  context.connectStream('a');
  streams[0].emit('hydra', { text: 'history' });
  assert.deepEqual(state.entries, ['cached']);
  assert.deepEqual(rendered, []);
  streams[0].emit('ready', { configOptions: [], turnTimeline: [] });
  assert.deepEqual(state.entries, ['history']);
  assert.deepEqual(processed, ['history']);
  assert.deepEqual(rendered, [['history']]);
  state.entries = ['other chat'];
  context.connectStream('b');
  streams[0].emit('hydra', { text: 'stale' });
  streams[0].emit('ready', { configOptions: [] });
  assert.deepEqual(state.entries, ['other chat']);
  streams[1].emit('hydra', { text: 'new history' });
  assert.deepEqual(state.entries, ['other chat']);
  streams[1].emit('ready', { configOptions: [] });
  assert.deepEqual(state.entries, ['new history']);
});

test('switching away preserves message indexes and expanded groups for a cached return', () => {
  const cacheCode = source.slice(source.indexOf('function cacheCurrentTranscript()'), source.indexOf('const ui = {'));
  const resetCode = source.slice(source.indexOf('function resetTranscript()'), source.indexOf('function selectSession('));
  const entry = { type: 'message', text: 'previous answer' };
  const state = { currentId: 'a', entries: [entry], byMessage: new Map([['m1', entry]]), byTool: new Map(),
    openActivityGroups: new Set(['turn-1']), openToolCalls: new Set(), expandedProgressTools: new Set(['0:tool-1']), progressTurns: [], liveProgress: null,
    usage: {}, configOptions: [], modelFavorites: [], running: false, promptRequests: 0, taskError: '' };
  const context = { state, recentTranscripts: new RecentTranscripts(), Map, Set,
    closeProgressPanel() {}, renderTranscript() {}, renderUsageLabel() {} };
  vm.runInNewContext(`${cacheCode}\n${resetCode}\nthis.cache = cacheCurrentTranscript; this.reset = resetTranscript; this.restore = restoreTranscript;`, context);
  context.cache();
  context.reset();
  assert.equal(state.entries.length, 0);
  assert.equal(state.expandedProgressTools.size, 0);
  context.restore(context.recentTranscripts.take('a'));
  assert.equal(state.byMessage.get('m1'), entry);
  assert.equal(state.entries[0], entry);
  assert.equal(state.openActivityGroups.has('turn-1'), true);
});
