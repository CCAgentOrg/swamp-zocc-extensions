<!-- BEGIN swamp managed section - DO NOT EDIT -->
# Project

This repository is managed with [swamp](https://github.com/systeminit/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search community extensions with `swamp extension search <query>` — prefer `@swamp/*` official extensions first, (b) search local/installed types with `swamp model type search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) extend an existing type if it covers the domain but lacks the method you need, (e) only create a custom extension model in `extensions/models/` as a last resort. Use the `swamp-extension` skill for guidance. The `command/shell` model is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp model type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a model (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp model get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp model method run` calls against the same model. Multiple parallel calls against the same model contend on the per-model lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check `swamp model type describe` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled, not lockfile-tracked.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. `deno.lock` and `package.json` do NOT cover extension model dependencies — this is by design. Always pin explicit versions in `npm:` import specifiers (e.g., `npm:lodash-es@4.17.21`).
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze model output (security reports, cost analysis, compliance checks, summaries), create a report extension. Use the `swamp-report` skill for guidance.

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- `swamp-getting-started` - Interactive onboarding for new swamp users
- `swamp-model` - Work with swamp models (creating, editing, validating)
- `swamp-workflow` - Work with workflows (creating, editing, running)
- `swamp-vault` - Manage secrets and credentials
- `swamp-data` - Manage model data lifecycle and query with CEL
- `swamp-report` - Run and configure reports for models and workflows
- `swamp-repo` - Repository management
- `swamp-extension` - Create custom extensions (models, vaults, drivers, datastores, reports)
- `swamp-extension-publish` - Publish extensions to the registry
- `swamp-issue` - Submit bug reports and feature requests
- `swamp-troubleshooting` - Diagnose swamp problems and verify swamp's health

## Getting Started

**IMPORTANT:** At the start of every conversation, run
`swamp model search --json`. If no models are returned (empty result), you MUST
immediately invoke the `swamp-getting-started` skill before doing anything else.
This walks new users through an interactive onboarding tutorial.

If models already exist, start by using the `swamp-model` skill to work with
swamp models.

## Commands

Use `swamp --help` to see available commands. For a machine-readable JSON
schema of the CLI (commands, options, arguments) intended for agent
consumption, run `swamp help [<command>...]` — e.g. `swamp help` returns
the full tree, and `swamp help model method run` scopes to a subtree.
<!-- END swamp managed section -->

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
