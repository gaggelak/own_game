// Every static asset (models, music, sfx) lives in public/ and is fetched at
// runtime by a path written absolute-from-root (e.g. "/models/unicorn_base.glb").
// Vite rewrites the paths it can see in index.html and the JS bundle, but these
// are runtime strings it can't — so a root-absolute path would 404 the moment
// the game isn't served from the domain root (GitHub Pages' /own_game/ subpath,
// an itch.io iframe, …).
//
// Route them through here instead. With `base: "./"` in vite.config, BASE_URL is
// "./", so this yields a path relative to the page — which resolves correctly
// under any prefix: Pages, itch, Netlify's root, and Tauri's tauri://localhost,
// all from one build.
export function asset(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, "");
}
