import { defineConfig } from 'vite';

// The game ships as a static site to GitHub Pages at
// https://br3nt.github.io/tribal-gods/ — a *project* page, so every asset
// URL must be prefixed with the repo name or the browser 404s them off the
// domain root. `base` does exactly that at build time. For local `npm run
// dev` Vite ignores base, so development is unaffected.
export default defineConfig({
  base: '/tribal-gods/',
});
