# genealogy-flow

Browser-based GEDCOM particle-flow animation viewer plus offline TypeScript
tooling for parsing, geocoding, biography generation, and migration analysis.

## Viewer

`index.html` is a single-file browser app. No build step. Three ways to use it:

1. **Hosted**: open https://derrickburns.github.io/genealogy-flow/. Drop your
   GEDCOM. The file never leaves your browser.
2. **Local**: clone the repo and open `index.html` directly.
3. **Self-host**: copy `index.html` to any static host.

GitHub Pages is wired up via `.github/workflows/pages.yml` and redeploys
automatically on every push to `main` that touches `index.html`. Enable it
once under repo Settings -> Pages -> Source: GitHub Actions.

## Tools

Seven offline CLIs published as `@derrickburns/genealogy-flow`.

### Use (no clone)

```sh
npx @derrickburns/genealogy-flow parse-gedcom my.ged individuals.json
npx @derrickburns/genealogy-flow biographer my.ged --mode standard
```

Or install globally:

```sh
npm i -g @derrickburns/genealogy-flow
parse-gedcom my.ged individuals.json
```

### Develop

```sh
pnpm install
pnpm parse-gedcom my.ged individuals.json
```

| Command                                    | Purpose                                      |
| ------------------------------------------ | -------------------------------------------- |
| `pnpm parse-gedcom <ged> <out.json>`       | Per-individual dated location events.        |
| `pnpm build-gazetteer [minPop=1000]`       | GeoNames -> compact `gazetteer.json`.        |
| `pnpm geocode <ind.json> <places.json>`    | Resolve place strings -> lat/lon/level.      |
| `pnpm build-timeline <ind> <pl> <out>`     | Pack individuals + places into timeline JSON.|
| `pnpm migrations <ged> [--out X]`          | Classify moves against historical patterns.  |
| `pnpm summarize-gedcom <ged>`              | 1-3 sentence Claude summaries (cached).      |
| `pnpm biographer <ged> [--mode ...]`       | Source-cited biographical prose.             |

`summarize-gedcom` and `biographer` require `ANTHROPIC_API_KEY`. They use
prompt caching and resume-safe JSON sidecars (existing entries are kept;
SIGINT persists progress).

### Gazetteer source data

`build-gazetteer` and `geocode` need GeoNames dumps in the project root.
Fetch them with:

```sh
./download_geonames.sh
```

Files (`cities500.zip`, `US.zip`, `admin1.txt`, `countryInfo.txt`) are
gitignored.

### End-to-end

```sh
./download_geonames.sh
pnpm build-gazetteer
pnpm parse-gedcom my.ged individuals.json
pnpm geocode individuals.json places.json
pnpm build-timeline individuals.json places.json timeline.json
pnpm migrations my.ged
pnpm biographer my.ged --mode standard
```

## Notes

- TypeScript port replaces the prior Python tools. `parse-gedcom` and the
  parser produce byte-identical output to the Python version on the same
  input. Geocoded centroid coords differ from the Python output at the
  14th decimal (centroid sum order); rounded coords match.
- Migration extraction sorts events by `(year, place)` for deterministic
  output; the Python version sorted by `year` only with set-hash tiebreaker,
  so a few migrations may differ at year collisions.
- The base GEDCOM parser (`src/gedcom/parser.ts`) is shared by the
  biographer, the migration extractor, and the simple per-individual
  exporter.

## Typecheck

```sh
pnpm typecheck
```
