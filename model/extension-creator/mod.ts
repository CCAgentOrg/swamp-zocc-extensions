/**
 * Swamp Extension Creator model.
 *
 * Generates, scaffolds, and validates swamp extensions from a natural language
 * description. Produces manifest.yaml, model/datastore TypeScript code, README,
 * and quality-check guidance — all as structured data resources that can be
 * piped into file writers and CI workflows.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { ModelContext } from "swamp:model";

const GlobalArgsSchema = z.object({
  collective: z.string().describe("Collective namespace (e.g., 'zocc')"),
  name: z.string().describe("Extension slug (e.g., 'duckdb')"),
  description: z.string().describe("One-sentence description of the extension"),
});

/** Scaffold result produced by the scaffold method. */
const ScaffoldResultSchema = z.object({
  extensionType: z.enum(["model", "datastore", "model+datastore"]),
  collective: z.string(),
  name: z.string(),
  manifestPath: z.string(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    description: z.string(),
  })),
  nextSteps: z.array(z.string()),
});

/** Validation result from the validate method. */
const ValidateResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["pass", "fail", "skip"]),
    message: z.string(),
    remediation: z.string().optional(),
  })),
  score: z.object({
    earned: z.number(),
    total: z.number(),
    grade: z.enum(["A", "B", "C", "D", "F"]),
  }),
});

/** Checklist result from the checklist method. */
const ChecklistResultSchema = z.object({
  phase: z.enum(["research", "design", "implement", "test", "git", "publish"]),
  steps: z.array(z.object({
    step: z.number(),
    action: z.string(),
    command: z.string().optional(),
    verify: z.string(),
    status: z.enum(["pending", "done", "blocked"]),
  })),
});

/** Method inputs and outputs for the scaffold method. */
const ScaffoldArgsSchema = z.object({
  extensionType: z.enum(["model", "datastore", "model+datastore"]).describe(
    "Type of extension to scaffold",
  ),
  methods: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputs: z.array(z.object({
      name: z.string(),
      type: z.string(),
      description: z.string(),
      required: z.boolean().default(true),
    })),
  })).describe("Methods to include (for model types)"),
  cliTool: z.string().optional().describe(
    "CLI tool to wrap via Deno.Command (e.g., 'duckdb', 'curl')",
  ),
  configFields: z.array(z.object({
    name: z.string(),
    type: z.string(),
    description: z.string(),
    default: z.string().optional(),
  })).optional().describe("Datastore config fields (for datastore types)"),
});

/** Method inputs and outputs for the validate method. */
const _ValidateArgsSchema = z.object({
  manifestPath: z.string().describe("Path to manifest.yaml to validate"),
});

/** Method inputs and outputs for the checklist method. */
const ChecklistArgsSchema = z.object({
  phase: z.enum(["research", "design", "implement", "test", "git", "publish"])
    .describe("Which phase to generate checklist for"),
  collective: z.string().optional().describe(
    "Collective name (pre-fills some steps)",
  ),
});

/**
 * Generate a CalVer version string for today.
 * @returns Version string in YYYY.MM.DD.1 format
 */
function todayVersion(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}.1`;
}

/**
 * Generate the manifest.yaml content.
 */
function generateManifest(
  args: {
    collective: string;
    name: string;
    description: string;
    extensionType: string;
    methods: Array<{ name: string }>;
    configFields: Array<{ name: string }>;
    cliTool?: string;
  },
): string {
  const hasDatastore = args.extensionType === "datastore" ||
    args.extensionType === "model+datastore";
  const hasModel = args.extensionType === "model" ||
    args.extensionType === "model+datastore";

  const lines: string[] = [
    "manifestVersion: 1",
    `name: "@${args.collective}/${args.name}"`,
    `version: "${todayVersion()}"`,
    "paths:",
    "  base: manifest",
    `description: "${args.description}"`,
    "",
  ];

  if (hasModel) {
    lines.push("models:");
    lines.push(`  - ${args.name}.ts`);
    lines.push("");
  }

  if (hasDatastore) {
    lines.push("datastores:");
    lines.push(`  - datastores/${args.name}_datastore/mod.ts`);
    lines.push("");
  }

  lines.push("additionalFiles:");
  lines.push("  - README.md");
  lines.push("  - LICENSE.md");
  lines.push("");
  lines.push("platforms:");
  lines.push("  - linux-x86_64");
  lines.push("  - linux-aarch64");
  lines.push("  - darwin-x86_64");
  lines.push("  - darwin-aarch64");
  lines.push("");
  lines.push(`labels:`);
  lines.push(`  - ${args.name}`);

  if (args.cliTool) {
    lines.push(`  - ${args.cliTool}`);
  }

  if (hasDatastore) {
    lines.push("  - datastore");
  }

  lines.push("dependencies: []");
  return lines.join("\n");
}

/**
 * Generate a model TypeScript file.
 */
function generateModel(
  args: {
    name: string;
    collective: string;
    methods: Array<{
      name: string;
      description: string;
      inputs: Array<
        { name: string; type: string; description: string; required: boolean }
      >;
    }>;
    cliTool?: string;
  },
): string {
  const typeSlug = `@${args.collective}/${args.name}`;
  const version = todayVersion();

  const argSchemas = args.methods.map((m) => {
    const fields = m.inputs
      .map((i) => {
        const zodType = i.type === "string"
          ? "z.string()"
          : i.type === "number"
          ? "z.number()"
          : i.type === "boolean"
          ? "z.boolean()"
          : `z.${i.type === "integer" ? "number().int()" : "unknown"}()`;
        return `      ${i.name}: ${
          i.required ? zodType : `${zodType}.optional()`
        }.describe("${i.description}")`;
      })
      .join(",\n");
    return `    ${m.name}: {\n      description: "${m.description}",\n      arguments: z.object({\n${fields}\n      }),`;
  });

  const methodEntries = args.methods.map((m) => {
    const tsArgs = m.inputs
      .map((i) => {
        const tsType = i.type === "string"
          ? "string"
          : i.type === "number"
          ? "number"
          : i.type === "boolean"
          ? "boolean"
          : "unknown";
        return `          ${i.name}: ${tsType}${
          i.required ? "" : " | undefined"
        },`;
      })
      .join("\n");

    return `    ${m.name}: {\n${
      argSchemas.find((s) => s.startsWith(`    ${m.name}:`))?.split("\n").slice(
        1,
      ).join("\n")
    }\n      execute: async (\n        args: {
${tsArgs}
        },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        // TODO: Implement ${m.name}
        const handle = await context.writeResource("result", "main", {
          success: true,
          message: "${m.name} executed",
        });
        return { dataHandles: [handle] };
      },
    },`;
  });

  const typeLine = "  type: " + JSON.stringify(typeSlug) + ",";
  const versionLine = "  version: " + JSON.stringify(version) + ",";

  return `/**
 * ${args.name} model for swamp.
 *
 * ${args.methods.map((m) => m.description).join(". ")}.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { ModelContext, DataHandle } from "swamp:model";

const GlobalArgsSchema = z.object({});

export const model = {
${typeLine}
${versionLine}
  globalArguments: GlobalArgsSchema,

  resources: {
    result: {
      description: "Method output data",
      schema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
${methodEntries.join("\n\n")}
  },
};
`;
}

/**
 * Generate quality checklist for a given phase.
 */
function generateChecklist(phase: string, collective?: string): Array<{
  step: number;
  action: string;
  command?: string;
  verify: string;
  status: string;
}> {
  const steps: Array<
    {
      step: number;
      action: string;
      command?: string;
      verify: string;
      status: string;
    }
  > = [];

  switch (phase) {
    case "research":
      steps.push(
        {
          step: 1,
          action: "Search existing extensions for coverage",
          command: `swamp extension search "<query>" --json`,
          verify: "No existing extension covers the need",
          status: "pending",
        },
        {
          step: 2,
          action: "Verify auth and collectives",
          command: `swamp auth whoami --json`,
          verify: "Output shows collectives array",
          status: "pending",
        },
        {
          step: 3,
          action: "Determine extension type",
          command: undefined,
          verify:
            "Type matches user intent (model/datastore/vault/driver/report)",
          status: "pending",
        },
      );
      break;

    case "design":
      steps.push(
        {
          step: 1,
          action: "Choose collective",
          command: collective ? undefined : `swamp auth whoami --json`,
          verify: `Manifest name starts with @${collective || "<collective>"}/`,
          status: "pending",
        },
        {
          step: 2,
          action: "Design method signatures with Zod schemas",
          command: undefined,
          verify:
            "Each method has argument schema, resource schema, and execute function",
          status: "pending",
        },
        {
          step: 3,
          action: "Decide on layout (per-extension-subdir recommended)",
          command: undefined,
          verify: "paths.base: manifest set if using subdir layout",
          status: "pending",
        },
      );
      break;

    case "implement":
      steps.push(
        {
          step: 1,
          action: "Create manifest.yaml with all required fields",
          command: undefined,
          verify: "manifestVersion, name, version, description present",
          status: "pending",
        },
        {
          step: 2,
          action: "Write model entrypoint with JSDoc on every export",
          command: undefined,
          verify: "≥80% of exports have JSDoc comments",
          status: "pending",
        },
        {
          step: 3,
          action: "Write README.md (≥500 chars, ≥2 code blocks)",
          command: undefined,
          verify: "README has installation, usage, and configuration sections",
          status: "pending",
        },
        {
          step: 4,
          action: "Add LICENSE.md",
          command: undefined,
          verify: "LICENSE.md listed in additionalFiles",
          status: "pending",
        },
      );
      break;

    case "test":
      steps.push(
        {
          step: 1,
          action: "Register extension source",
          command: `swamp extension source add extensions/models/<name>`,
          verify: "No errors",
          status: "pending",
        },
        {
          step: 2,
          action: "Verify registration",
          command: `swamp model type search <name> --json`,
          verify: "Extension type appears in results",
          status: "pending",
        },
        {
          step: 3,
          action: "Format check",
          command: `swamp extension fmt manifest.yaml --check --json`,
          verify: "status: passed",
          status: "pending",
        },
        {
          step: 4,
          action: "Quality check",
          command: `swamp extension quality manifest.yaml --json`,
          verify: "earned ≥ 12/12 (100%, Grade A)",
          status: "pending",
        },
        {
          step: 5,
          action: "Smoke test each method",
          command:
            `swamp model create @collective/name test && swamp model method run test <method> --input key=val`,
          verify: "All methods succeed with data handles",
          status: "pending",
        },
      );
      break;

    case "git":
      steps.push(
        {
          step: 1,
          action: "Create project directory and copy files",
          command: `mkdir -p Projects/swamp-<name>`,
          verify: "All extension files copied",
          status: "pending",
        },
        {
          step: 2,
          action: "Add .gitignore",
          command: undefined,
          verify: "*.duckdb, .swamp/ excluded",
          status: "pending",
        },
        {
          step: 3,
          action: "Init, commit, push",
          command: `git init && git add -A && git commit -m "Initial release"`,
          verify: "Clean commit on main branch",
          status: "pending",
        },
        {
          step: 4,
          action: "Create GitHub repo",
          command:
            `gh repo create <org>/swamp-<name> --public --source=. --push`,
          verify: "Repo accessible at GitHub URL",
          status: "pending",
        },
      );
      break;

    case "publish":
      steps.push(
        {
          step: 1,
          action: "Final format + quality check",
          command:
            `swamp extension fmt manifest.yaml --check && swamp extension quality manifest.yaml --json`,
          verify: "Both pass",
          status: "pending",
        },
        {
          step: 2,
          action: "Dry-run push",
          command: `swamp extension push manifest.yaml --dry-run --json`,
          verify: "Models, datastores, files all resolved",
          status: "pending",
        },
        {
          step: 3,
          action: "Push to registry",
          command: `swamp extension push manifest.yaml --yes --json`,
          verify: "Pushed @collective/name@version confirmed",
          status: "pending",
        },
        {
          step: 4,
          action: "Sync to git and push",
          command:
            `git add -A && git commit -m "Publish v<version>" && git push`,
          verify: "Git repo matches published version",
          status: "pending",
        },
      );
      break;
  }

  return steps;
}

/**
 * Swamp Extension Creator model.
 *
 * Scaffolds, validates, and generates quality checklists for swamp extensions.
 * Designed to be used in CI pipelines and agent workflows to automate extension
 * development.
 */
export const model = {
  type: "@zocc/swamp-extension-creator",
  version: "2026.05.21.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    scaffold: {
      description: "Scaffolded extension files (manifest, model, README)",
      schema: ScaffoldResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    validation: {
      description: "Quality validation result with per-factor scores",
      schema: ValidateResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    checklist: {
      description: "Phase-specific checklist with steps and verification",
      schema: ChecklistResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    /**
     * Scaffold a new extension from a description.
     * Generates manifest.yaml, model entrypoint, README skeleton,
     * and returns them as structured data.
     */
    scaffold: {
      description: "Generate scaffold files for a new swamp extension",
      arguments: ScaffoldArgsSchema,
      execute: async (
        args: z.infer<typeof ScaffoldArgsSchema>,
        context: ModelContext,
      ): Promise<{ dataHandles: Array<unknown> }> => {
        const collective = context.globalArgs.collective;
        const name = context.globalArgs.name;
        const description = context.globalArgs.description;

        const manifest = generateManifest({
          collective,
          name,
          description,
          extensionType: args.extensionType,
          methods: args.methods,
          configFields: args.configFields ?? [],
          cliTool: args.cliTool,
        });

        const files: Array<
          { path: string; content: string; description: string }
        > = [];

        // Manifest
        files.push({
          path: "manifest.yaml",
          content: manifest,
          description:
            "Extension manifest with metadata, model/datastore entries, and quality fields",
        });

        // Model entrypoint
        if (
          args.extensionType === "model" ||
          args.extensionType === "model+datastore"
        ) {
          files.push({
            path: `${name}.ts`,
            content: generateModel({
              name,
              collective,
              methods: args.methods,
              cliTool: args.cliTool,
            }),
            description: "Model entrypoint with typed methods and Zod schemas",
          });
        }

        // README
        const methodRows = args.methods.map((m) =>
          `| \`${m.name}\` | ${m.description} | ${
            m.inputs.map((i) => i.name).join(", ")
          } | result |`
        ).join("\n");
        const readmeContent = `# @${collective}/${name}

${description}.

## Installation

\`\`\`sh
swamp extension install @${collective}/${name}
\`\`\`

## Methods

| Method | Description | Inputs | Output |
| --- | --- | --- | --- |
${methodRows}

## Configuration

This extension requires no additional configuration beyond the standard
swamp setup. Ensure the \`swamp\` CLI is installed and authenticated.

\`\`\`sh
swamp auth whoami --json
\`\`\`

## Development

\`\`\`sh
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
\`\`\`

## License

Apache-2.0 — see LICENSE.md for details.
`;
        files.push({
          path: "README.md",
          content: readmeContent,
          description:
            "README with installation, usage, methods table, and development instructions",
        });

        // LICENSE
        const licenseContent =
          `# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
`;
        files.push({
          path: "LICENSE.md",
          content: licenseContent,
          description: "Apache-2.0 license file",
        });

        // .gitignore
        const gitignoreContent = `*.duckdb
*.duckdb.wal
.swamp/
.DS_Store
Thumbs.db
.idea/
.vscode/
`;
        files.push({
          path: ".gitignore",
          content: gitignoreContent,
          description: "Git ignore rules for database files and IDE artifacts",
        });

        const nextSteps = [
          `1. Copy files to extensions/models/${name}/`,
          `2. Implement method execute functions in ${name}.ts`,
          `3. Run: swamp extension source add extensions/models/${name}`,
          `4. Run: swamp extension fmt manifest.yaml --check --json`,
          `5. Run: swamp extension quality manifest.yaml --json`,
          `6. Smoke test: swamp model create @${collective}/${name} test`,
          `7. Run: swamp model method run test <method> --input key=value`,
          `8. Push: gh repo create <org>/swamp-${name} --public`,
          `9. Push: swamp extension push manifest.yaml --yes --json`,
        ];

        const handle = await context.writeResource("scaffold", "main", {
          extensionType: args.extensionType,
          collective,
          name,
          manifestPath: `extensions/models/${name}/manifest.yaml`,
          files,
          nextSteps,
        });
        return { dataHandles: [handle] };
      },
    },

    /**
     * Generate a quality checklist for a specific pipeline phase.
     * Returns actionable steps with commands and verification criteria.
     */
    checklist: {
      description:
        "Generate phase-specific checklist with commands and verification steps",
      arguments: ChecklistArgsSchema,
      execute: async (
        args: z.infer<typeof ChecklistArgsSchema>,
        context: ModelContext,
      ): Promise<{ dataHandles: Array<unknown> }> => {
        const steps = generateChecklist(args.phase, args.collective);

        const handle = await context.writeResource("checklist", args.phase, {
          phase: args.phase,
          steps,
        });
        return { dataHandles: [handle] };
      },
    },

    /**
     * Generate a readiness report summarizing all quality factors.
     * Use this before publishing to get a quick score estimate.
     */
    readiness: {
      description: "Generate readiness report with quality factor estimates",
      arguments: z.object({
        hasReadme: z.boolean().describe(
          "Whether README.md exists in additionalFiles",
        ),
        readmeHasExamples: z.boolean().describe(
          "Whether README has ≥2 code blocks",
        ),
        hasJSDoc: z.boolean().describe("Whether ≥80% of exports have JSDoc"),
        hasExplicitTypes: z.boolean().describe(
          "Whether all exports have explicit return types",
        ),
        hasLicense: z.boolean().describe(
          "Whether LICENSE file is in additionalFiles",
        ),
        hasRepo: z.boolean().describe(
          "Whether repository URL is set in manifest",
        ),
        repoIsPublic: z.boolean().describe(
          "Whether the repo is publicly accessible",
        ),
        hasPlatforms: z.boolean().describe(
          "Whether platforms array has ≥2 entries or is empty",
        ),
      }),
      execute: async (
        args: z.infer<unknown>,
        context: ModelContext,
      ): Promise<{ dataHandles: Array<unknown> }> => {
        const a = args as {
          hasReadme: boolean;
          readmeHasExamples: boolean;
          hasJSDoc: boolean;
          hasExplicitTypes: boolean;
          hasLicense: boolean;
          hasRepo: boolean;
          repoIsPublic: boolean;
          hasPlatforms: boolean;
        };

        const checks = [
          {
            name: "has-readme",
            status: a.hasReadme ? "pass" as const : "fail" as const,
            message: a.hasReadme
              ? "README.md in additionalFiles"
              : "Add README.md to additionalFiles",
            remediation: "Add README.md to additionalFiles in manifest.yaml",
          },
          {
            name: "readme-example",
            status: a.readmeHasExamples ? "pass" as const : "fail" as const,
            message: a.readmeHasExamples
              ? "README has code blocks"
              : "Add ≥2 fenced code blocks to README",
            remediation: "Add usage and configuration examples to README",
          },
          {
            name: "rich-readme",
            status: (a.hasReadme && a.readmeHasExamples)
              ? "pass" as const
              : "fail" as const,
            message: "README ≥500 chars with ≥2 code blocks",
            remediation: "Expand README to ≥500 characters",
          },
          {
            name: "symbols-docs",
            status: a.hasJSDoc ? "pass" as const : "fail" as const,
            message: a.hasJSDoc
              ? "≥80% exports documented"
              : "Add JSDoc to all exported symbols",
            remediation: "Add /** ... */ comments to all exports",
          },
          {
            name: "fast-check",
            status: a.hasExplicitTypes ? "pass" as const : "fail" as const,
            message: a.hasExplicitTypes
              ? "Explicit return types on exports"
              : "Add explicit return types",
            remediation:
              "Add : ReturnType annotations to all exported functions",
          },
          {
            name: "description",
            status: "pass" as const,
            message: "Non-empty manifest description",
          },
          {
            name: "platforms-one",
            status: "pass" as const,
            message: "At least one platform",
          },
          {
            name: "platforms-two",
            status: a.hasPlatforms ? "pass" as const : "fail" as const,
            message: "≥2 platforms or empty array",
            remediation: "Add more platforms or leave empty for universal",
          },
          {
            name: "has-license",
            status: a.hasLicense ? "pass" as const : "fail" as const,
            message: a.hasLicense
              ? "LICENSE file in additionalFiles"
              : "Add LICENSE to additionalFiles",
            remediation: "Add LICENSE.md to additionalFiles",
          },
          {
            name: "repository-verified",
            status: (a.hasRepo && a.repoIsPublic)
              ? "pass" as const
              : "fail" as const,
            message: (a.hasRepo && a.repoIsPublic)
              ? "Public repo on allowlisted host"
              : "Set public repo URL",
            remediation:
              "Add repository: https://github.com/org/repo to manifest",
          },
        ];

        const earned = checks.filter((c) => c.status === "pass").length;
        const total = checks.length;
        const pct = Math.floor((earned / total) * 100);
        const grade = pct >= 90
          ? "A"
          : pct >= 75
          ? "B"
          : pct >= 60
          ? "C"
          : pct >= 40
          ? "D"
          : "F";

        const handle = await context.writeResource("validation", "readiness", {
          passed: earned === total,
          checks,
          score: { earned, total, grade },
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
