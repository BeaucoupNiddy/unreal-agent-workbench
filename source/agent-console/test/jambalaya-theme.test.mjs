import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { applyJambalayaCopy } from '../public/jambalaya-theme.js';

function element(text, dataset = {}) {
  return { textContent: text, dataset, children: [], listener: null,
    addEventListener(_type, listener) { this.listener = listener; } };
}

test('Jambalaya copy toggles only explicitly annotated leaf labels and round-trips in place', () => {
  const icon = element('＋'), label = element('New chat', { default: 'New chat', jambalaya: 'Start a pot' });
  const kbd = element('⌘ K'), button = element('', {}); button.children = [icon, label, kbd];
  const browser = element('Browser', { default: 'Browser', jambalaya: 'Bayou view' });
  const dot = element('', {}); dot.className = 'browser-dot';
  const browserButton = element('', {}); browserButton.children = [browser, dot];
  const projectTitle = element('My project'), chatTitle = element('A real chat'), userText = element('Keep this exact message'), command = element('npm test'), permission = element('Read only');
  const annotatedParent = element('Terminal', { default: 'Terminal', jambalaya: 'Cast-iron terminal' });
  annotatedParent.children = [icon];
  const nodes = [label, browser, annotatedParent];
  globalThis.document = { querySelectorAll(selector) { assert.equal(selector, '[data-jambalaya][data-default]'); return nodes; } };
  const listener = () => 'clicked'; button.addEventListener('click', listener);
  try {
    applyJambalayaCopy(true);
    assert.equal(label.textContent, 'Start a pot'); assert.equal(browser.textContent, 'Bayou view');
    applyJambalayaCopy(false);
    assert.equal(label.textContent, 'New chat'); assert.equal(browser.textContent, 'Browser');
    assert.deepEqual(button.children, [icon, label, kbd]); assert.deepEqual(browserButton.children, [browser, dot]);
    assert.equal(annotatedParent.textContent, 'Terminal'); assert.deepEqual(annotatedParent.children, [icon]);
    assert.equal(button.listener, listener); assert.equal(dot.className, 'browser-dot');
    assert.deepEqual([projectTitle.textContent, chatTitle.textContent, userText.textContent, command.textContent, permission.textContent], ['My project', 'A real chat', 'Keep this exact message', 'npm test', 'Read only']);
  } finally { delete globalThis.document; }
});

test('theme assets cover default/light/dark/system and Jambalaya light/dark palettes', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /name="theme" value="system"/); assert.match(html, /name="theme" value="light"/); assert.match(html, /name="theme" value="dark"/);
  assert.match(html, /name="theme-color"/);
  assert.match(app, /#faf4e8/); assert.match(app, /#101d19/); assert.match(app, /#f4f5f2/); assert.match(app, /#0f100e/);
  assert.match(app, /state\.prefs\.theme === "system"/);
  assert.match(css, /data-brand="jambalaya"/); assert.match(css, /data-theme="light"/); assert.match(css, /data-theme="dark"/);
});

test('branding updates preserve actual project/chat names and drafts', async () => {
  const { themeText } = await import('../public/jambalaya-theme.js');
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function renderBrandContext() {'), source.indexOf('function relativeTime('));
  const title = element('User’s custom project <not HTML>'), path = element('/workspace/my-project');
  const prompt = { value: 'Do not send or erase this draft' };
  const welcome = element(''), welcomeCopy = element(''), strong = element(''), small = element(''), progressName = element('');
  const state = { prefs: { jambalayaMode: true }, currentProjectPath: '/workspace/my-project', currentId: null };
  const project = { path: state.currentProjectPath, name: title.textContent };
  const ui = { taskTitle: title, taskPath: path, prompt, composerContext: element(''), liveProgressPanel: { querySelector: () => progressName } };
  const $ = selector => ({ '#welcomeTitle': welcome, '#welcomeCopy': welcomeCopy, '#starterNewChat': { querySelector: selector => selector === 'strong' ? strong : small } })[selector];
  const render = new Function('state', 'ui', '$', 'projectViews', 'louisiana', 'brand', `${body}; return renderBrandContext;`)(
    state, ui, $, () => [project], (normal, spicy) => themeText(normal, spicy, state.prefs.jambalayaMode), () => ({ name: state.prefs.jambalayaMode ? 'Jambalaya Agent' : 'Unreal Agent' }));
  render();
  assert.equal(title.textContent, project.name); assert.equal(welcome.textContent, project.name);
  state.prefs.jambalayaMode = false; render();
  assert.equal(title.textContent, project.name); assert.equal(path.textContent, project.path);
  assert.equal(small.textContent, `Work in ${project.name}`);
  state.currentId = 'chat'; title.textContent = 'A user-named chat'; path.textContent = '/different/chat-folder';
  state.prefs.jambalayaMode = true; render(); state.prefs.jambalayaMode = false; render();
  assert.equal(title.textContent, 'A user-named chat'); assert.equal(path.textContent, '/different/chat-folder');
  assert.equal(prompt.value, 'Do not send or erase this draft');
});
