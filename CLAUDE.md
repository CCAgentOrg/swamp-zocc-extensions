# Rules

- **Never hand-edit files under `extensions/` within an extension directory.** They are managed by `swamp model method run` and the extension-creator pipeline. If a model needs changes, run the scaffold or edit pipeline.
- **One extension per directory.** Each extension lives under its type group (`datastore/`, `model/`, `vault/`). Follow the official `systeminit/swamp-extensions` layout.
- **All extensions must be `@zocc` scoped.** Factory-mode extensions are scoped `@zocc/`. Manual/personal extensions live in a separate repo scoped `@cashlessconsumer/`.
- **Search before you build.** Run `swamp extension search <query>` and `swamp model type search <query>` before creating new extensions. If a community extension exists, install it instead.
- **Extend, don't bypass.** When an existing model covers the domain but lacks a method, extend it with `export const extension` — don't wrap it in shell scripts.
- **Escape SQL identifiers.** Always use `escId()` when interpolating table/column names into SQL. Never interpolate user input directly into SQL strings.
- **Pin all imports.** Use explicit version pins in `npm:` import specifiers (e.g., `npm:zod@3.23.8`). Never use bare `npm:zod`.
- **Validate manifests.** Every extension must have a `manifest.yaml` with required fields: `manifestVersion`, `name` (under `@zocc/`), `version`, `description`, `repository`, `license`.
- **Run quality gates before merge.** `deno check`, `deno lint`, `deno fmt --check`, and `deno test` must pass. CI enforces these on every PR.
- **Version bumps are publish triggers.** The publish workflow detects changes to `manifest.yaml` on the `main` branch. Bump `version` in the manifest to trigger a publish.

# Architecture

```
swamp-zocc-extensions/
├── datastore/           # Datastore-type extensions
│   └── duckdb/          # @zocc/duckdb (model + datastore)
├── model/               # Model-type extensions
│   └── extension-creator/  # @zocc/swamp-extension-creator
├── vault/               # Vault-type extensions
│   └── sops-age/        # @zocc/sops-age
├── .github/workflows/   # CI + Publish
├── CLAUDE.md            # This file
└── README.md            # Monorepo overview
```

## Adding a New Extension

1. Pick the right type group: `datastore/`, `model/`, `vault/`
2. Create `<type>/<name>/` with `manifest.yaml` and `extensions/` dir
3. Scope the name as `@zocc/<name>`
4. Set `repository` to `https://github.com/CCAgentOrg/swamp-zocc-extensions/tree/main/<type>/<name>`
5. Run `deno check`, `deno lint`, `deno fmt` on the new extension
6. Open PR — CI will validate

## Publishing

1. Bump `version` in the extension's `manifest.yaml`
2. Merge to `main`
3. The publish workflow auto-detects the change and runs quality gates before publishing
