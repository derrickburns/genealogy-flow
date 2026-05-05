# genealogy-flow

Browser-based GEDCOM particle-flow animation viewer plus offline TypeScript
tooling for parsing, geocoding, biography generation, and migration analysis.

## Viewer

The browser app is served from `public/`. The root `index.html` is a source
shell; `pnpm run predeploy` injects the generated runtime bundle into
`public/index.html`.

Local development:

```sh
pnpm install
pnpm run dev
```

Local DEMO data is stored in Wrangler's local R2 state. If `/api/demo`
returns `503 Demo data not seeded yet`, seed the local bucket from a private
GEDCOM first:

```sh
pnpm run seed-demo:local -- "Golden - Rosenberg.normalized.ged" gazetteer.json golden-rosenberg
pnpm run dev
pnpm run smoke:demo:local
```

`pnpm run dev` uses the D1 and R2 bindings from `wrangler.toml`; do not pass
`--r2 STORAGE` for local DEMO testing, because that creates a separate
binding-named local bucket instead of the configured `genealogy-flow` bucket.

Static build:

```sh
pnpm run predeploy
```

Then serve or deploy the `public/` directory.

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
| `pnpm audience <ged> [--living-only]`      | Rank individuals by ancestor coverage.       |

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

### Picking the audience

`pnpm audience my.ged --top 50 --living-only` ranks individuals by
ancestor coverage. For each candidate it walks up to N generations
(default 6) and computes:

- **Score** = Σ over ancestors of `(1 / 2^gen) × richness(ancestor)`
  where richness counts dated events plus source citations.
- **PCI** (Pedigree Completeness Index) = ancestors found / 2^N expected.

`--living-only` keeps individuals with no death year and a birth year
within 110 years of `--as-of` (default current year). `--leaves-only`
keeps individuals with no recorded marriages. `--format csv|json|table`
controls output.

The top of the list is whom this GEDCOM is most "about" — the people
whose direct ancestor chain is most thoroughly documented. Distribute
the viewer URL to them.

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
