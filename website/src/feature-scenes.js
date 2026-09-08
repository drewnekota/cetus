// Scale each detailed native-size scene as a unit, preserving icon/text alignment.
const scenes = [...document.querySelectorAll('.feature-scene')];
function sizeScene(scene) {
  const width = Number(scene.dataset.sceneWidth);
  scene.querySelector('.mini-canvas').style.transform = `scale(${scene.clientWidth / width})`;
}
const observer = new ResizeObserver(entries => entries.forEach(entry => sizeScene(entry.target)));
scenes.forEach(scene => { sizeScene(scene); observer.observe(scene); });
