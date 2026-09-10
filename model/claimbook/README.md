# @zocc/claimbook

Breach-claim ledger and verification state machine — the persistence layer
of the breach-verification bench. One DuckDB file (the *bench*) holds every
incident, claim, and piece of evidence. Network capture is delegated to
[`@zocc/onion`](../onion/); this model never touches the wire.

Part of the [`@zocc`](https://github.com/CCAgentOrg/swamp-zocc-extensions)
collective. Apache-2.0.

## The rubric

| Level | Meaning | Unlocked by evidence |
| --- | --- | --- |
| L0 | Rumor — asserted, nothing captured | — |
| L1 | Captured — artifact on disk with sha256 | `snapshot`, `listing`, `recon` |
| L2 | Inventory-consistent — asserted profile matches observed listing | `reconcile` |
| L3 | Sample-verified — a file from the dump verified | `sample` |
| L4 | Corroborated — public statement / press / regulator on record | `disclosure`, `press`, `gov` |
| L5 | Published — verification write-up public | `published` |

A claim's verified level is the highest level unlocked by its evidence.
`score` recomputes it; `report` shows asserted vs verified side by side.

## Methods

| Method | What it does |
| --- | --- |
| `init` | Create the bench schema (idempotent) |
| `file-claim` | Register an asserted claim with its asserted level |
| `link-evidence` | Attach an artifact (ref + sha256) to a claim |
| `score` | Derive verified level(s) from evidence |
| `reconcile` | Compare asserted dump profile vs observed inventory, record verdict |
| `record-disclosure` | Register a public statement as corroboration |
| `record-snapshot` | Persist a capture with sha256 + bytes |
| `record-state` | Persist onion watch-state and diff vs previous (alert trigger) |
| `report` | Structured verification status, stale-claim detection |

## Usage

```bash
swamp model create @zocc/claimbook bench;

swamp model method run bench init --input bench=/path/bench.duckdb;

swamp model method run bench file-claim \
  --input bench=/path/bench.duckdb --input incident=dodo \
  --input text="Actor claims 60.8GB across 1,342 files" --input level=L2;

swamp model method run bench reconcile \
  --input bench=/path/bench.duckdb --input claimId=7 \
  --input asserted='{"totalBytes":60800000000,"fileCount":1342}' \
  --input observed='{"totalBytes":60000000000,"fileCount":1205}';

swamp model method run bench report --input bench=/path/bench.duckdb;
```

## Bench discipline

- Every claim cites evidence; every evidence row cites a sha256 or a
  first-party path. No exceptions — this is what makes the bench
  defensible in print.
- Reconciliation is arithmetic, not vibes: byte ratios ≥0.98 match,
  ≥0.8 partial, below that a mismatch.
- `record-state` returns `changed:true` only on real deltas (status,
  HTTP code, byte count) — that boolean is the Discord-alert trigger.
- Stale claims (L0, older than 14 days) surface in `report` so open
  rumors get resolved or dropped.
