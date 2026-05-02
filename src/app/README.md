# Browser App Fragments

Files in this directory are ordered bundle fragments, not standalone browser
modules. `scripts/prepare-public.mjs` concatenates every `NN-domain-name.js`
file in lexical order into `public/app.js`, preserving the shared ESM scope
that the original inline script relied on.

Rules:

- Add new browser code as `NN-domain-name.js` so load order is explicit.
- Do not import these files directly from HTML; use `pnpm run predeploy`.
- Do not edit `public/app.js` directly. It is generated from this directory.
