# @zocc Swamp Extensions

Monorepo for all `@zocc`-scoped swamp extensions — built in **factory mode** (Zo autonomously creates, tests, and publishes).

Mirrors the layout of the official [systeminit/swamp-extensions](https://github.com/systeminit/swamp-extensions) monorepo.

## Extensions

| Extension | Scope | Type | Description |
|-----------|-------|------|-------------|
| [datastore/duckdb](datastore/duckdb/) | `@zocc/duckdb` | datastore + model | DuckDB integration: ad-hoc SQL query model + embedded datastore backend with row-level locking |
| [model/extension-creator](model/extension-creator/) | `@zocc/swamp-extension-creator` | model | Autonomous pipeline for scaffolding, testing, and publishing new extensions |
| [vault/sops-age](vault/sops-age/) | `@zocc/sops-age` | vault | SOPS + age encryption for local secret management |

## Modes

| Mode | Scope | Who builds | Repo |
|------|-------|------------|------|
| **Factory** | `@zocc/*` | Zo (autonomous) | This repo |
| **Manual** | `@cashlessconsumer/*` | You (hands-on) | Separate repo |

## Quality Gates (CI)

Every PR runs on all changed extensions:

- `deno check` — type checking
- `deno lint` — lint rules
- `deno fmt --check` — formatting
- `deno test --allow-all` — unit tests
- Manifest validation — required fields + `@zocc` scope

## Publishing

Pushing a `manifest.yaml` version bump to `main` triggers auto-publish after quality gates pass.

## Quality Fixes (this refactor)

| Issue | Fix |
|-------|-----|
| SQL injection in `@zocc/duckdb` | Added `escId()` — all 11 table-name interpolations now escaped |
| Version mismatch (manifest `2026.05.21.6` vs model `2026.05.21.2`) | Aligned to `2026.05.21.7` |
| `@cashlessconsumer/sops-age` scope | Re-scoped to `@zocc/sops-age` for monorepo consistency |
| Fragmented repos (3 separate GitHub repos) | Consolidated into single monorepo |
| No CI/CD | Added `ci.yml` + `publish.yml` with matrix strategy per extension |
| No quality enforcement | CLAUDE.md rules + CI gates |

## License

Apache-2.0 (per extension)
