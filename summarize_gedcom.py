#!/usr/bin/env python3
"""Generate per-individual markdown summaries for a GEDCOM using the Anthropic API.

Usage:
    python3 summarize_gedcom.py PATH_TO.ged [--model claude-opus-4-7] [--limit N]

Writes a sidecar JSON at PATH_TO.summaries.json mapping each individual id
(e.g. "@I123@") to a 1-3 sentence markdown summary. Resume-safe: existing
entries are preserved and skipped on subsequent runs. Persists incrementally
and on SIGINT so partial progress is never lost.

Prompt caching is enabled on the system prompt (shared across every call),
so per-request token cost drops sharply after the first individual.
"""
import argparse
import json
import re
import signal
import sys
import time
from pathlib import Path

import anthropic

SYSTEM_PROMPT = """You are summarizing a single person's life from a GEDCOM record. Output ONLY the summary text; no preamble, no closing remarks, no headings.

Constraints:
- 1 to 3 sentences, factual, no speculation.
- Markdown allowed: **bold** for the person's full name on first mention, *italics* sparingly, and [link text](url) for any URLs that appear in source citations within the GEDCOM (e.g. PAGE/URL fields in SOUR blocks).
- Lead with the person's name in bold, then their lifespan in parentheses if dates are known (e.g. "(b. 1850 in Norfolk, VA - d. 1922 in Richmond, VA)" or "(1850-1922)" if places aren't given), then a brief life summary drawn from the record's events.
- Preserve at most two source URLs as markdown links if they appear in the record.
- Do NOT invent facts, occupations, relationships, or events not present in the record.

Format examples:
- **Mary Smith** (b. 1850 in Norfolk, VA - d. 1922 in Richmond, VA) married John Doe in 1875 and lived in Hertford County for the 1900 census.
- **Unknown Reid** (no dates recorded) appears as a child in family F1234; no further events on file.
- **John Abner Collins** (b. abt. 1852 in Hertford Co, NC - d. 1931) is recorded with wife Bettie in the 1900 and 1910 censuses; his father is unknown per the [death record](https://www.ancestry.com/...)."""

USER_TEMPLATE = """GEDCOM record for one individual:

```
{gedcom}
```

Write the summary now."""

INDI_RE = re.compile(r"^0 (@[^@]+@)\s+INDI\s*$")
TOPLEVEL_RE = re.compile(r"^0 ")


def parse_indi_blocks(path: Path):
    """Yield (id, raw_block_text) for every INDI record in the GEDCOM."""
    cur_id = None
    buf: list[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n").rstrip("\r")
            if not line:
                continue
            m = INDI_RE.match(line)
            if m:
                if cur_id is not None:
                    yield cur_id, "\n".join(buf)
                cur_id = m.group(1)
                buf = [line]
                continue
            if TOPLEVEL_RE.match(line):
                if cur_id is not None:
                    yield cur_id, "\n".join(buf)
                cur_id = None
                buf = []
                continue
            if cur_id is not None:
                buf.append(line)
    if cur_id is not None:
        yield cur_id, "\n".join(buf)


def has_dated_event(block: str) -> bool:
    return "2 DATE" in block


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ged", type=Path, help="Path to .ged file")
    ap.add_argument(
        "--model",
        default="claude-opus-4-7",
        help="Anthropic model id (default claude-opus-4-7; "
             "use claude-haiku-4-5 to cut cost ~5x on large files)",
    )
    ap.add_argument("--limit", type=int, default=None, help="Max individuals to summarize this run")
    ap.add_argument("--out", type=Path, default=None, help="Output JSON path (default: <ged>.summaries.json)")
    ap.add_argument("--max-tokens", type=int, default=400)
    args = ap.parse_args()

    out_path = args.out or args.ged.with_suffix(args.ged.suffix + ".summaries.json")
    existing: dict[str, str] = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text())
        except json.JSONDecodeError:
            print(f"Warning: existing {out_path} is malformed; starting fresh", file=sys.stderr)
            existing = {}

    print(f"Reading {args.ged}")
    blocks = [(iid, blk) for iid, blk in parse_indi_blocks(args.ged) if has_dated_event(blk)]
    pending = [(iid, blk) for iid, blk in blocks if iid not in existing]
    print(f"Total individuals with dated events: {len(blocks)}")
    print(f"Already summarized: {len(existing)}")
    print(f"Pending: {len(pending)}")
    if args.limit is not None:
        pending = pending[: args.limit]
        print(f"Limiting this run to {len(pending)}")

    if not pending:
        print("Nothing to do.")
        return 0

    client = anthropic.Anthropic()

    interrupted = {"flag": False}

    def _handle_sigint(signum, frame):
        interrupted["flag"] = True
        print("\nInterrupt received; finishing current request and saving...", file=sys.stderr)

    signal.signal(signal.SIGINT, _handle_sigint)

    save_every = 25
    written_since_save = 0
    start = time.time()
    cache_reads = 0
    cache_writes = 0
    input_tokens = 0
    output_tokens = 0

    def persist():
        out_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False))

    for i, (iid, block) in enumerate(pending):
        if interrupted["flag"]:
            break
        try:
            resp = client.messages.create(
                model=args.model,
                max_tokens=args.max_tokens,
                system=[
                    {
                        "type": "text",
                        "text": SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[{"role": "user", "content": USER_TEMPLATE.format(gedcom=block)}],
            )
        except anthropic.APIStatusError as e:
            print(f"[{iid}] API error {e.status_code}: {e.message} - skipping", file=sys.stderr)
            continue
        except Exception as e:
            print(f"[{iid}] Unexpected error: {e} - skipping", file=sys.stderr)
            continue

        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "").strip()
        if text:
            existing[iid] = text
            written_since_save += 1

        u = resp.usage
        cache_reads += getattr(u, "cache_read_input_tokens", 0) or 0
        cache_writes += getattr(u, "cache_creation_input_tokens", 0) or 0
        input_tokens += u.input_tokens or 0
        output_tokens += u.output_tokens or 0

        if (i + 1) % 10 == 0:
            elapsed = time.time() - start
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            print(
                f"[{i + 1}/{len(pending)}] {iid:30s} | "
                f"cache_r {cache_reads:,} cache_w {cache_writes:,} in {input_tokens:,} out {output_tokens:,} | {rate:.1f}/s"
            )

        if written_since_save >= save_every:
            persist()
            written_since_save = 0

    persist()
    print(
        f"\nSaved {len(existing)} summaries to {out_path}\n"
        f"Cache reads:  {cache_reads:,}\n"
        f"Cache writes: {cache_writes:,}\n"
        f"Input tokens: {input_tokens:,}\n"
        f"Output tokens:{output_tokens:,}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
