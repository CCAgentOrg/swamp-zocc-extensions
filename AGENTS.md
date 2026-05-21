# Swamp Extensions (@zocc)

Monorepo for `@zocc`-scoped swamp extensions. Mirrors [systeminit/swamp-extensions](https://github.com/systeminit/swamp-extensions) layout.

GitHub: https://github.com/CCAgentOrg/swamp-zocc-extensions

## Structure

```
datastore/<name>/   — Datastores (may also ship models)
model/<name>/       — Model-only extensions
vault/<name>/       — Vault integrations
```

Each extension dir contains:
- `manifest.yaml` — package metadata
- `extensions/`    — source code (models/, datastores/, vaults/)
- `README.md`      — usage docs
- `LICENSE.md`     — Apache-2.0

## Modes

| Mode | Scope | Who builds |
|------|-------|-----------|
| Factory | `@zocc` | Zo creates autonomously |
| Manual | `@cashlessconsumer` | Cashless builds by hand |

This repo is **factory mode only**. Manual-scope extensions go in separate repos.

## Current Extensions

| Extension | Type | Scope | Status |
|-----------|------|-------|--------|
| `datastore/duckdb` | model + datastore | `@zocc/duckdb` | Published |
| `model/extension-creator` | model | `@zocc/swamp-extension-creator` | Published |
| `vault/sops-age` | vault | `@zocc/sops-age` | Published |

## CI

- **ci.yml** — on PR: deno check + lint + fmt per changed extension
- **publish.yml** — on push to main: auto-detect manifest changes, quality gate, `swamp extension publish`

## Adding a New Extension

1. Create dir under the appropriate type group (`datastore/`, `model/`, `vault/`)
2. Add `manifest.yaml`, `extensions/`, `README.md`, `LICENSE.md`
3. Run `deno check && deno lint && deno fmt` locally
4. PR → CI validates → merge → publish workflow auto-deploys
