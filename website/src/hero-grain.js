import { ShaderMount, grainGradientFragmentShader, getShaderColorFromString, getShaderNoiseTexture, GrainGradientShapes, ShaderFitOptions } from '@paper-design/shaders';

const host = document.getElementById('hero-grain');
const root = document.documentElement;
function palette() {
  const dark = root.classList.contains('dark');
  const colors = dark
    ? ['#211c32', '#544984', '#827be6', '#aaa0e8']
    : ['#f4f0fb', '#ded5f3', '#a79cde', '#827be6'];
  return {
    u_colorBack: getShaderColorFromString(dark ? '#0d0d0f' : '#ffffff'),
    u_colors: colors.map(color => getShaderColorFromString(color)),
    u_colorsCount: colors.length,
  };
}
// A fixed frame, not an animation. Paper stops its render loop at speed 0;
// only resize and theme changes redraw. CSS remains underneath as fallback.
async function initializeGrain() {
try {
  const noise = getShaderNoiseTexture();
  // Avoid exposing an untextured frame or a resize caused by font loading.
  await Promise.all([noise.decode(), document.fonts.ready]);
  const mount = new ShaderMount(host, grainGradientFragmentShader, {
    ...palette(),
    u_shape: GrainGradientShapes.wave,
    u_softness: 0.96,
    u_intensity: 0.1,
    u_noise: 0.23,
    u_noiseTexture: noise,
    u_fit: ShaderFitOptions.cover,
    u_scale: 1.35,
    u_rotation: 0,
    u_offsetX: 0,
    u_offsetY: 0,
    u_originX: 0.5,
    u_originY: 0.5,
    u_worldWidth: 0,
    u_worldHeight: 0,
  }, undefined, 0, 0, 2, 8_294_400);
  // The mount sizes its canvas through ResizeObserver. Keep it hidden until
  // that first layout and an explicit static render have both completed.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    mount.setFrame(0);
    host.classList.add('is-ready');
  }));
  new MutationObserver(() => mount.setUniforms(palette()))
    .observe(root, { attributes: true, attributeFilter: ['class'] });
} catch {
  // An unavailable graphics context must not affect the rest of the page.
  host.replaceChildren();
}

}
void initializeGrain();
