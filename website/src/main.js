import './feature-scenes.js';
import './hero-grain.js';
import './product-demo.js';
const root = document.documentElement;
const themeButton = document.querySelector('.theme-toggle');
const themeLabel = document.getElementById('theme-label');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themeModes = ['system', 'light', 'dark'];
let themeMode = 'system';
try {
  const saved = localStorage.getItem('cetus-site-theme-mode');
  if (themeModes.includes(saved)) themeMode = saved;
} catch {}
function syncTheme() {
  const dark = themeMode === 'system' ? systemTheme.matches : themeMode === 'dark';
  root.classList.toggle('dark', dark);
  themeLabel.textContent = themeMode === 'system' ? `Auto · ${dark ? 'Dark' : 'Light'}` : dark ? 'Dark' : 'Light';
  const next = themeModes[(themeModes.indexOf(themeMode) + 1) % themeModes.length];
  themeButton.setAttribute('aria-label', `Theme: ${themeMode === 'system' ? 'automatic' : themeMode}. Switch to ${next === 'system' ? 'automatic' : next} theme`);
  themeButton.title = 'Theme: Auto → Light → Dark';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0d0d0f' : '#ffffff';
}
syncTheme();
systemTheme.addEventListener('change', syncTheme);
themeButton.addEventListener('click', () => {
  themeMode = themeModes[(themeModes.indexOf(themeMode) + 1) % themeModes.length];
  try { localStorage.setItem('cetus-site-theme-mode', themeMode); } catch {}
  syncTheme();
});

const runtimeTabs = [...document.querySelectorAll('.runtime-options [role="tab"]')];
const panel = document.getElementById('runtime-panel');

function chooseRuntime(tab, focus = false) {
  runtimeTabs.forEach(item => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  panel.setAttribute('aria-labelledby', tab.id);
  const key = tab.dataset.runtime;
  const label = tab.querySelector('strong').textContent;
  panel.querySelectorAll('[data-runtime-label]').forEach(item => { item.textContent = label; });
  panel.querySelectorAll('.mini-runtime img').forEach(image => {
    image.src = `assets/brands/${key}.svg`;
    image.classList.toggle('dsh-icon', key === 'dsh');
  });
  panel.querySelector('.feature-visual').setAttribute('aria-label', `${label} conversation preview. Example content.`);
  if (focus) tab.focus();
}
runtimeTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => chooseRuntime(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % runtimeTabs.length;
    if (event.key === 'ArrowUp') next = (index - 1 + runtimeTabs.length) % runtimeTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = runtimeTabs.length - 1;
    if (next !== undefined) { event.preventDefault(); chooseRuntime(runtimeTabs[next], true); }
  });
});
