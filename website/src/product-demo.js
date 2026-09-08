// Local sample scenes built from Cetus component structure; no backend calls.
const demo = document.getElementById('product-demo');
const stage = document.getElementById('demo-stage');
const app = demo.querySelector('.demo-app');
const menu = document.getElementById('demo-runtime-menu');
const picker = document.getElementById('demo-runtime-toggle');
const sceneTabs = [...demo.querySelectorAll('[data-demo-scene]')];
const names = { home: '', chat: 'Launch meeting recap', board: '', automations: '', quick: '' };
const storyNames = { meeting: 'Turn a meeting into next steps', screen: 'Find what I was looking at', briefing: 'Start my day with a briefing' };
let scale = 1;
function closePicker(focus = false) {
  menu.hidden = true;
  picker.setAttribute('aria-expanded', 'false');
  if (focus) picker.focus();
}
function showView(view, story = 'meeting') {
  if (!(view in names)) return;
  const scene = view === 'chat' ? 'home' : view;
  demo.querySelectorAll('[data-demo-panel]').forEach(panel => { panel.hidden = panel.dataset.demoPanel !== view; });
  demo.querySelector('.demo-sidebar').hidden = view === 'quick';
  demo.querySelector('.demo-workspace').hidden = view === 'quick';
  demo.querySelectorAll('[data-demo-view][aria-pressed]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.demoView === scene)));
  sceneTabs.forEach(tab => {
    tab.setAttribute('aria-selected', String(tab.dataset.demoScene === scene));
    tab.tabIndex = tab.dataset.demoScene === scene ? 0 : -1;
  });
  stage.setAttribute('aria-labelledby', `scene-${scene}`);
  document.getElementById('demo-breadcrumb').textContent = view === 'chat' ? storyNames[story] : names[view];
  demo.querySelectorAll('[data-demo-story]').forEach(content => {
    content.hidden = content.dataset.demoStory !== story;
    content.scrollTop = 0;
  });
  demo.querySelectorAll('.demo-conversation').forEach(button => {
    if (view === 'chat' && button.dataset.demoChat === story) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  stage.scrollLeft = 0;
  closePicker();
}
demo.querySelectorAll('[data-demo-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.demoView)));
sceneTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => showView(tab.dataset.demoScene));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % sceneTabs.length;
    if (event.key === 'ArrowLeft') next = (index + sceneTabs.length - 1) % sceneTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = sceneTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault(); sceneTabs[next].focus(); showView(sceneTabs[next].dataset.demoScene);
  });
});
function positionPicker() {
  const boundary = demo.querySelector('.demo-workspace').getBoundingClientRect();
  const trigger = picker.getBoundingClientRect();
  const below = (boundary.bottom - trigger.bottom) / scale - 16;
  const above = (trigger.top - boundary.top) / scale - 16;
  const up = below < 260 && above > below;
  menu.dataset.side = up ? 'above' : 'below';
  menu.style.maxHeight = `${Math.max(0, Math.min(260, up ? above : below))}px`;
}
new ResizeObserver(() => {
  const mobile = window.matchMedia("(max-width: 700px)").matches;
  scale = mobile ? 1 : stage.clientWidth / 1440;
  app.style.zoom = String(scale);
  stage.style.height = mobile ? "" : `${788 * scale}px`;
  if (!menu.hidden) positionPicker();
}).observe(stage);
picker.addEventListener('click', () => {
  positionPicker(); menu.hidden = !menu.hidden;
  picker.setAttribute('aria-expanded', String(!menu.hidden));
});
const models = { cetus: 'Built-in · Balanced', 'claude-code': 'Opus · Medium', codex: 'GPT-6-Astra · Medium', dsh: 'DeepSeek · High', opencode: 'Default model', grok: 'Grok · Default', kimi: 'Kimi · Default' };
const colors = { cetus: 'var(--app-brand)', 'claude-code': '#d97757', codex: '#10a37f', dsh: 'var(--app-ink)', opencode: '#7f7f7f', grok: '#71717a', kimi: '#1783ff' };
menu.querySelectorAll('[data-demo-runtime]').forEach(button => button.addEventListener('click', () => {
  const key = button.dataset.demoRuntime;
  app.style.setProperty('--demo-runtime', colors[key]);
  document.getElementById('demo-runtime-name').textContent = button.dataset.name;
  const image = document.getElementById('demo-runtime-icon');
  image.src = `assets/brands/${key}.svg`; image.classList.toggle('dsh-icon', key === 'dsh');
  document.getElementById('demo-model').textContent = models[key];
  menu.querySelectorAll('[data-demo-runtime]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  closePicker(true);
}));
document.addEventListener('click', event => { if (!event.target.closest('.demo-picker-wrap')) closePicker(); });
demo.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closePicker(true); } });
demo.querySelector('[data-demo-approve]').addEventListener('click', event => {
  const card = event.currentTarget.closest('.demo-task');
  card.querySelector('.demo-review-note').remove(); card.querySelector('.demo-review-actions').remove();
  demo.querySelector('[data-column=done] .demo-column-cards').append(card);
  demo.querySelectorAll('.demo-column').forEach(column => { column.querySelector('header small').textContent = column.querySelectorAll('.demo-task').length; });
});
// Real document browsing over the sample files shown in the preview.
const fileDialog = demo.querySelector('.demo-file-dialog:not(.demo-artifacts-dialog)');
const artifactsDialog = demo.querySelector('.demo-artifacts-dialog');
const fileCard = demo.querySelector('[data-demo-open-file]');
const meetingBody = fileCard.querySelector('.demo-file-markdown').cloneNode(true);
const meetingMarkdown = "# Launch next steps\n\nDecisions from the launch planning meeting.\n\n## Next steps\n\n- **Website** \u2014 finish the product walkthrough.\n- **Feedback** \u2014 group early user notes by workflow.\n- **Release** \u2014 review the checklist before publishing.\n\n## Ready for review\n\nShare the updated walkthrough with the team and collect final feedback.\n";
const briefingMarkdown = '# Morning briefing\n\n## Today’s priorities\n\n- Review the updated product walkthrough.\n- Confirm the feedback window for launch.\n- Prepare for product planning at 10:30 AM.\n\nBased on recent conversations and meeting notes.\n';
const briefingBody = document.createElement('div');
briefingBody.className = 'demo-file-markdown';
for (const [tag, text] of [['h4','Morning briefing'],['h5','Today’s priorities'],['p','Review the updated product walkthrough.'],['p','Confirm the feedback window for launch.'],['p','Prepare for product planning at 10:30 AM.'],['p','Based on recent conversations and meeting notes.']]) {
  const element = document.createElement(tag); element.textContent = text;
  if (tag === 'h4') element.className = 'demo-md-title';
  briefingBody.append(element);
}
const files = {
  meeting: { name: 'launch-next-steps.md', text: meetingMarkdown, body: meetingBody },
  briefing: { name: 'morning-briefing.md', text: briefingMarkdown, body: briefingBody },
};
const storyFiles = { meeting: ['meeting'], screen: [], briefing: ['briefing'] };
let currentFile = 'meeting';
let fileTrigger = fileCard;
let artifactsTrigger;
function metadata(file) { return `Markdown · ${new TextEncoder().encode(file.text).length} B`; }
function openFile(key, trigger) {
  const file = files[key]; if (!file) return;
  currentFile = key; fileTrigger = trigger;
  fileDialog.querySelector('h3').textContent = file.name;
  fileDialog.querySelector('header p').textContent = metadata(file);
  fileDialog.querySelector('.demo-file-scroll').replaceChildren(file.body.cloneNode(true));
  fileDialog.querySelector('[data-demo-copy-file] span').textContent = 'Copy';
  fileDialog.showModal();
}
function openArtifacts(key, trigger) {
  artifactsTrigger = trigger;
  const ids = storyFiles[key];
  document.getElementById('demo-artifacts-title').textContent = `Artifacts · ${storyNames[key]}`;
  document.getElementById('demo-artifacts-count').textContent = `${ids.length} ${ids.length === 1 ? 'artifact' : 'artifacts'}`;
  const grid = artifactsDialog.querySelector('.demo-artifacts-grid'); grid.replaceChildren();
  if (!ids.length) {
    const empty = document.createElement('p'); empty.className = 'demo-artifacts-empty'; empty.textContent = 'No artifacts in this conversation.'; grid.append(empty);
  }
  for (const id of ids) {
    const file = files[id], card = fileCard.cloneNode(true);
    card.dataset.demoOpenFile = id;
    card.setAttribute('aria-label', `Open ${file.name}`);
    card.querySelector('.demo-artifact-thumb').replaceChildren(file.body.cloneNode(true));
    card.querySelector('.demo-artifact-meta p').textContent = file.name;
    card.querySelector('.demo-artifact-meta span').textContent = metadata(file);
    grid.append(card);
  }
  artifactsDialog.showModal();
}
demo.addEventListener('click', event => {
  const collection = event.target.closest('[data-demo-artifacts]');
  if (collection) openArtifacts(collection.dataset.demoArtifacts, collection);
  const file = event.target.closest('[data-demo-open-file]');
  if (file) openFile(file.dataset.demoOpenFile, file);
});
demo.addEventListener('keydown', event => {
  const file = event.target.closest('[data-demo-open-file]');
  if (file && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openFile(file.dataset.demoOpenFile, file); }
});
demo.querySelector('[data-demo-close-file]').addEventListener('click', () => fileDialog.close());
demo.querySelector('[data-demo-close-artifacts]').addEventListener('click', () => artifactsDialog.close());
fileDialog.addEventListener('close', () => fileTrigger?.focus());
artifactsDialog.addEventListener('close', () => artifactsTrigger?.focus());
for (const dialog of [fileDialog, artifactsDialog]) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
demo.querySelector('[data-demo-copy-file]').addEventListener('click', async event => {
  const label = event.currentTarget.querySelector('span');
  try { await navigator.clipboard.writeText(files[currentFile].text); label.textContent = 'Copied'; }
  catch { label.textContent = 'Copy unavailable'; }
});

// All conversation entry points, including smaller website scenes, share the
// same sample stories. Delegation also covers newly added automation cards.
document.addEventListener('click', event => {
  const button = event.target.closest('[data-demo-chat]');
  if (!button || !(button.dataset.demoChat in storyNames)) return;
  showView('chat', button.dataset.demoChat);
  if (!demo.contains(button)) {
    demo.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    demo.querySelector('.demo-conversation[aria-current=true]').focus({ preventScroll: true });
  }
});
