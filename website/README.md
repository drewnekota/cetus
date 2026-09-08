# Cetus website

Marketing website deployed at https://cetus.run, with automatic light/dark themes, PP Kyoto serif accents, and coded product scenes. The official website source lives in `website/`, alongside the desktop app.

## Preview

```sh
cd website
npm ci
npm run build
npm run dev
```

Open http://127.0.0.1:4178. The included `main.js` is already built.

## Product scenes

The hero has Chat, Kanban, Automations, and Quick Launcher tabs. The smaller feature scenes depict the launcher, screenshot attachment, dictation, screen history, meetings, automations, quick replies, memory, workspaces, and runtime conversations. All use local example content; no agent runtime is called.

- `index.html`: copy and SVG/HTML scene markup.
- `styles.css`: marketing layout and theme.
- `product-demo.css` / `src/product-demo.js`: main app preview and sample interactions.
- `feature-scenes.css` / `src/feature-scenes.js`: detailed feature crops, scaled together to preserve alignment.
- `src/main.js`: site theme and runtime switching.
- `src/hero-grain.js`: Paper Grain Gradient, static frame 0 with speed 0, purple wave, noise 0.23. CSS supplies a fallback.
- `assets/brands/`: app runtime marks. Interface icons are rendered from the official `lucide` package at build time by `scripts/icons.mjs`, pinned to the app's icon version. Set `data-lucide` to an exported icon name and run the build; no handwritten paths or icon runtime are needed.

Image placeholders have been replaced by coded UI; the previous `media.json` is retained but is no longer loaded. To customize visuals, edit the scene markup and styles.

Shortcut copy distinguishes holding both Command keys, holding both Option keys for the screenshot launcher, and double-tapping right Option for Quick Reply. These actions can be assigned in app Settings; the screenshot launcher is not enabled by default in the current source.

Run `npm run build` after JavaScript changes and `npm run check` for syntax, references, and local resources.

## Deployment

Run `npm run deploy` with an authenticated Wrangler CLI. `scripts/stage.mjs` copies public assets to `dist`; `wrangler.jsonc` serves them through the existing proxied `cetus.run/*` zone route. Existing DNS records are preserved. Credentials stay in the local Wrangler login and are not included in the project.

## Separation from desktop releases

This directory has its own npm dependencies and build. The desktop app exports `src/app` to `out/`; Tauri bundles that export and `src-tauri/pi-install`, not `website/`. Website changes do not require an app version bump or an app release. GitHub’s automatic source archives do include tracked website source.

Only source, public assets, the lockfile, and the prebuilt browser bundle are tracked. `node_modules/`, `dist/`, `.wrangler/`, and local credentials remain ignored. Website deployment is independent of the desktop release workflows.
