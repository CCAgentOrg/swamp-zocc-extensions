# @zocc/swamp-extension-creator

> 🤖 **Agent-developed** — Built by AI agents following the [OpenFlaw Manifesto](https://ccagentorg.github.io/OpenFlaw/). Human-directed, machine-executed.

Autonomous pipeline for creating, testing, and publishing swamp extensions.
Generates scaffolds, quality checklists, and readiness reports as structured
data resources.

## Installation

```sh
swamp extension install @zocc/swamp-extension-creator
```

## Methods

### scaffold

Generate scaffold files for a new swamp extension. Produces manifest.yaml,
model entrypoint, README.md, LICENSE.md, and .gitignore as a structured data
resource.

```sh
swamp model create @zocc/swamp-extension-creator creator
swamp model method run creator scaffold \
  --input extensionType="model" \
  --input methods='[{"name":"run","description":"Execute a query","inputs":[{"name":"query","type":"string","description":"SQL query","required":true}]}]'
```

### checklist

Generate a phase-specific checklist with commands and verification steps.
Phases: research, design, implement, test, git, publish.

```sh
swamp model method run creator checklist \
  --input phase="publish" \
  --input collective="zocc"
```

### readiness

Generate a readiness report estimating quality score before publishing.
Pass each factor as a boolean flag.

```sh
swamp model method run creator readiness \
  --input hasReadme=true \
  --input readmeHasExamples=true \
  --input hasJSDoc=true \
  --input hasExplicitTypes=true \
  --input hasLicense=true \
  --input hasRepo=true \
  --input repoIsPublic=true \
  --input hasPlatforms=true
```

## How it works

This model generates structured data resources (not files) that can be piped
into file writers, CI workflows, or agent pipelines. The scaffold method
produces a `files` array with path/content pairs that can be written to disk.

## Quality Factors

| Factor | Earned | Requirement |
| --- | --- | --- |
| has-readme | ✅ | README.md in additionalFiles |
| readme-example | ✅ | ≥2 code blocks in README |
| rich-readme | ✅ | ≥500 chars + ≥2 code blocks |
| symbols-docs | ✅ | All exports have JSDoc |
| fast-check | ✅ | Explicit return types |
| description | ✅ | Non-empty description |
| platforms-one | ✅ | 4 platforms listed |
| platforms-two | ✅ | 4 platforms listed |
| has-license | ✅ | LICENSE.md in additionalFiles |
| repository-verified | ✅ | Public GitHub URL |

## License

Apache-2.0 — see LICENSE.md for details.
