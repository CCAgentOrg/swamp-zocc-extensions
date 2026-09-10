# @zocc/onion

Tor onion-service observability model for the breach-verification bench.
Stateless by design: it brings up Tor, probes onion endpoints, captures
sha256-attributed evidence snapshots, and parses dump-inventory listings —
while persistence, claim scoring, and change-detection live in
[`@zocc/claimbook`](../claimbook/).

Part of the [`@zocc`](https://github.com/CCAgentOrg/swamp-zocc-extensions)
collective. Apache-2.0.

## Methods

| Method | What it does |
| --- | --- |
| `bootstrap` | Idempotently ensure a Tor SOCKS daemon is listening (spawns `tor --SocksPort N` if absent, polls until bootstrapped) |
| `probe` | Availability check for an onion URL through Tor; returns up/httpCode/bytes/duration |
| `fetch` | Evidence snapshot: downloads via Tor to an absolute local path, records sha256 + byte count, enforces a size cap |
| `crawl-listing` | Parses a dump listing — DireWolf-style filebrowser item-card HTML or `{files:[{path,size,mtime}]}` enumeration JSON — into entries with PII-bearing filename masking |

## Usage

```bash
swamp model create @zocc/onion dodo-watch;

swamp model method run dodo-watch bootstrap --input socksPort=9150;

swamp model method run dodo-watch probe \
  --input url=http://<onion>/ --input socksPort=9150;

swamp model method run dodo-watch fetch \
  --input url="http://<onion>/api/download?path=DodoPayments%2F" \
  --input destination=/home/workspace/Projects/incident/source/listing.html;

swamp model method run dodo-watch crawl-listing \
  --input source=/home/workspace/Projects/incident/source/listing.html;
```

## PII masking

Filenames are screened for digit-runs ≥9, digit-glued stems, PAN-like
tokens, embedded emails, and sensitive stems (kyc/pan/upi/customer…).
Flagged names are bullet-masked before they appear in any result; the
flag reasons stay so auditors know *why* a name was masked. Directory
names and file extensions survive masking.

## Bench discipline

- Every capture carries `sha256` + `bytes` + timestamp — that is the
  citation unit for downstream claim evidence.
- `probe` writes no state; the caller decides what to persist.
- Never fetch customer-data archives by default: the bench verifies
  metadata (listings, profiles, statements), not PII payloads.

## Safety notes

- Tor access only; nothing here touches clearnet.
- `bootstrap` spawns a long-lived daemon on the given SOCKS port with
  `ControlPort 0`; kill with the `force` flag or `pkill -f SocksPort`.
- Requires the `tor` and `curl` binaries on PATH.
