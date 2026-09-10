/**
 * @zocc/claimbook — breach-claim ledger and verification state machine.
 *
 * Persistence layer of the breach-verification bench. One DuckDB file
 * (the "bench") holds incidents, claims, evidence, snapshots, onion
 * watch-state, and observed inventories. Methods:
 *
 *  - init:              create the bench schema
 *  - file-claim:        register an asserted claim (level L0–L5)
 *  - link-evidence:     attach an artifact to a claim
 *  - score:             derive the verified level of a claim from evidence
 *  - reconcile:         compare an asserted dump profile against an observed inventory
 *  - record-disclosure: register a victim/operator public statement
 *  - record-snapshot:   persist a capture (sha256 + bytes) to the bench
 *  - record-state:      persist onion watch-state and diff against the previous check
 *  - report:            structured verification status for an incident
 *
 * Network capture lives in @zocc/onion; this model never touches the wire.
 *
 * @example
 * swamp model create @zocc/claimbook bench;
 * swamp model method run bench init --input bench=/path/bench.duckdb;
 * swamp model method run bench file-claim --input bench=/path/bench.duckdb \
 *   --input incident=dodo --input text="Actor published 60.8GB dump" \
 *   --input level=L1 --input assertedBy=DireWolf;
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { ModelContext } from "swamp:model";

const GlobalArgsSchema = z.object({});

const LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;

const ARTIFACT_TYPES = [
  "snapshot",
  "listing",
  "recon",
  "sample",
  "reconcile",
  "disclosure",
  "press",
  "gov",
  "published",
] as const;

const ClaimSchema = z.object({
  id: z.number(),
  incident: z.string(),
  text: z.string(),
  level: z.string(),
  status: z.string(),
  assertedBy: z.string(),
  assertedAt: z.string().nullable(),
  evidenceCount: z.number(),
});

const InitResultSchema = z.object({
  bench: z.string(),
  tables: z.array(z.string()),
});

const ClaimResultSchema = z.object({
  claimId: z.number(),
  incident: z.string(),
  level: z.string(),
});

const EvidenceResultSchema = z.object({
  evidenceId: z.number(),
  claimId: z.number(),
  artifactType: z.string(),
});

const ScoreResultSchema = z.object({
  claimId: z.number(),
  assertedLevel: z.string(),
  verifiedLevel: z.string(),
  basis: z.array(z.string()),
  evidenceCount: z.number(),
});

const AssertionCheckSchema = z.object({
  field: z.string(),
  asserted: z.string().nullable(),
  observed: z.string().nullable(),
  verdict: z.enum(["match", "mismatch", "partial", "unverifiable"]),
});

const ReconcileResultSchema = z.object({
  claimId: z.number(),
  verdicts: z.array(AssertionCheckSchema),
  overall: z.enum(["consistent", "partial", "inconsistent", "inconclusive"]),
});

const SnapshotResultSchema = z.object({
  snapshotId: z.number(),
  sha256: z.string().nullable(),
  bytes: z.number().nullable(),
});

const StateResultSchema = z.object({
  changed: z.boolean(),
  previous: z
    .object({
      status: z.string(),
      httpCode: z.number().nullable(),
      bytes: z.number().nullable(),
      checkedAt: z.string(),
    })
    .nullable(),
  current: z.object({
    status: z.string(),
    httpCode: z.number().nullable(),
    bytes: z.number().nullable(),
    checkedAt: z.string(),
  }),
});

const ReportResultSchema = z.object({
  bench: z.string(),
  incident: z.string().nullable(),
  incidents: z.number(),
  claims: z.array(ClaimSchema),
  staleClaims: z.array(z.number()),
  snapshots: z.number(),
  generatedAt: z.string(),
});

/** Escape single quotes for SQL string literals. */
export function esc(value: string): string {
  return value.replace(/'/g, "''");
}

/** Compare two onion watch-states and decide whether an alert is due. */
export function stateChanged(
  prev:
    | { status: string; httpCode: number | null; bytes: number | null }
    | null,
  next: { status: string; httpCode: number | null; bytes: number | null },
): boolean {
  if (prev === null) return true;
  if (prev.status !== next.status) return true;
  if (prev.httpCode !== next.httpCode) return true;
  if (prev.bytes !== null && next.bytes !== null && prev.bytes !== next.bytes) {
    return true;
  }
  return false;
}

/** Derive a claim's verified level from its evidence artifact types. */
export function deriveLevel(artifactTypes: string[]): {
  level: string;
  basis: string[];
} {
  const basis: string[] = [];
  let level = "L0";
  const bump = (
    target: string,
    type: string,
    reason: string,
  ) => {
    if (artifactTypes.includes(type) && target > level) {
      level = target;
      basis.push(reason);
    }
  };
  bump("L1", "snapshot", "captured artifact with sha256");
  bump("L1", "listing", "captured listing with sha256");
  bump("L1", "recon", "independent recon artifact");
  bump("L2", "reconcile", "inventory reconciliation recorded");
  bump("L3", "sample", "sample from dump verified");
  bump("L4", "disclosure", "public statement on record");
  bump("L4", "press", "independent press corroboration");
  bump("L4", "gov", "regulator/gov action on record");
  bump("L5", "published", "published verification write-up");
  return { level, basis };
}

/** Normalize a human size ("13.7 MB", "2,005,462") to bytes. */
export function toBytes(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const s = v.trim();
  const plain = Number(s.replace(/,/g, ""));
  if (Number.isFinite(plain)) return Math.round(plain);
  const m = s.match(/^([\d.,]+)\s*([KMGTP]?i?B)$/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  const unit = m[2].toUpperCase().replace("I", "");
  const mult: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    PB: 1e15,
  };
  return Number.isFinite(value) ? Math.round(value * (mult[unit] ?? 1)) : null;
}

async function runDuckDB(
  database: string,
  sql: string,
): Promise<{ stdout: string; success: boolean; stderr: string }> {
  const command = new Deno.Command("duckdb", {
    args: ["-noheader", "-csv", database, sql],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  const output = await command.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    success: output.success,
    stderr: new TextDecoder().decode(output.stderr),
  };
}

function parseCsvRows(stdout: string): string[][] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const cells: string[] = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (inQ) {
          if (c === '"' && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (c === '"') inQ = false;
          else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ",") {
          cells.push(cur);
          cur = "";
        } else cur += c;
      }
      cells.push(cur);
      return cells;
    });
}

const SCHEMA_SQL = `
CREATE SEQUENCE IF NOT EXISTS seq_claims;
CREATE SEQUENCE IF NOT EXISTS seq_evidence;
CREATE SEQUENCE IF NOT EXISTS seq_snapshots;
CREATE SEQUENCE IF NOT EXISTS seq_state;
CREATE TABLE IF NOT EXISTS incidents(
  incident VARCHAR PRIMARY KEY,
  name VARCHAR,
  actor VARCHAR,
  first_seen VARCHAR,
  status VARCHAR DEFAULT 'open',
  notes VARCHAR
);
CREATE TABLE IF NOT EXISTS claims(
  id BIGINT PRIMARY KEY DEFAULT nextval('seq_claims'),
  incident VARCHAR,
  text VARCHAR,
  level VARCHAR DEFAULT 'L0',
  status VARCHAR DEFAULT 'open',
  asserted_by VARCHAR,
  asserted_at VARCHAR,
  tags VARCHAR[],
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evidence(
  id BIGINT PRIMARY KEY DEFAULT nextval('seq_evidence'),
  claim_id BIGINT,
  incident VARCHAR,
  artifact_type VARCHAR,
  ref VARCHAR,
  sha256 VARCHAR,
  note VARCHAR,
  confidence VARCHAR DEFAULT 'normal',
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS snapshots(
  id BIGINT PRIMARY KEY DEFAULT nextval('seq_snapshots'),
  incident VARCHAR,
  artifact_type VARCHAR DEFAULT 'snapshot',
  source_url VARCHAR,
  file_path VARCHAR,
  sha256 VARCHAR,
  bytes BIGINT,
  http_code INTEGER,
  note VARCHAR,
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS onion_state(
  id BIGINT PRIMARY KEY DEFAULT nextval('seq_state'),
  incident VARCHAR,
  target VARCHAR,
  status VARCHAR,
  http_code INTEGER,
  bytes BIGINT,
  sha256 VARCHAR,
  note VARCHAR,
  checked_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory_files(
  id BIGINT PRIMARY KEY DEFAULT nextval('seq_evidence'),
  incident VARCHAR,
  db_name VARCHAR,
  path VARCHAR,
  size_bytes BIGINT,
  size_human VARCHAR,
  mtime VARCHAR,
  captured_at VARCHAR,
  capture_sha256 VARCHAR
);
`;

export const model = {
  type: "@zocc/claimbook",
  version: "2026.09.10.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    report: {
      description: "Verification status report for an incident",
      schema: ReportResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    init: {
      description: "Create the bench schema (idempotent)",
      arguments: z.object({
        bench: z.string().describe("Path to the bench DuckDB file"),
      }),
      execute: async (
        args: { bench: string },
        context: ModelContext,
      ) => {
        const r = await runDuckDB(args.bench, SCHEMA_SQL);
        if (!r.success) throw new Error(`init failed: ${r.stderr}`);
        context.logger.info("Bench schema ready at {bench}", {
          bench: args.bench,
        });
        return {
          dataHandles: [],
          output: {
            bench: args.bench,
            tables: [
              "incidents",
              "claims",
              "evidence",
              "snapshots",
              "onion_state",
              "inventory_files",
            ],
          },
        };
      },
    },

    "file-claim": {
      description:
        "Register an asserted claim with its asserted level (L0 rumor → L5 published)",
      arguments: z.object({
        bench: z.string(),
        incident: z.string(),
        text: z.string().describe("Claim text, no PII"),
        level: z.enum(LEVELS).default("L0").describe("Asserted level"),
        assertedBy: z.string().default("unknown"),
        assertedAt: z.string().optional(),
        tags: z.array(z.string()).default([]),
      }),
      execute: async (
        args: {
          bench: string;
          incident: string;
          text: string;
          level: string;
          assertedBy: string;
          assertedAt?: string;
          tags: string[];
        },
        _context: ModelContext,
      ) => {
        const tags = `{${args.tags.map((t) => `"${esc(t)}"`).join(",")}}`;
        const r = await runDuckDB(
          args.bench,
          `INSERT INTO claims(incident, text, level, asserted_by, asserted_at, tags) VALUES ('${
            esc(args.incident)
          }', '${esc(args.text)}', '${args.level}', '${
            esc(args.assertedBy)
          }', ${
            args.assertedAt ? `'${esc(args.assertedAt)}'` : "NULL"
          }, '${tags}') RETURNING id;`,
        );
        if (!r.success) throw new Error(`file-claim failed: ${r.stderr}`);
        const id = Number(parseCsvRows(r.stdout)[0]?.[0]);
        if (!Number.isFinite(id)) {
          throw new Error("file-claim returned no id");
        }
        return {
          dataHandles: [],
          output: {
            claimId: id,
            incident: args.incident,
            level: args.level,
          },
        };
      },
    },

    "link-evidence": {
      description: "Attach an artifact (ref + sha256) to a claim",
      arguments: z.object({
        bench: z.string(),
        claimId: z.number(),
        artifactType: z.enum(ARTIFACT_TYPES),
        ref: z.string().describe("Path or URL of the artifact"),
        sha256: z.string().optional(),
        note: z.string().optional(),
        confidence: z.enum(["low", "normal", "high"]).default("normal"),
      }),
      execute: async (
        args: {
          bench: string;
          claimId: number;
          artifactType: string;
          ref: string;
          sha256?: string;
          note?: string;
          confidence: string;
        },
        _context: ModelContext,
      ) => {
        const r = await runDuckDB(
          args.bench,
          `INSERT INTO evidence(claim_id, incident, artifact_type, ref, sha256, note, confidence) SELECT ${args.claimId}, incident, '${
            esc(args.artifactType)
          }', '${esc(args.ref)}', ${
            args.sha256 ? `'${esc(args.sha256)}'` : "NULL"
          }, ${
            args.note ? `'${esc(args.note)}'` : "NULL"
          }, '${args.confidence}' FROM claims WHERE id=${args.claimId} RETURNING id;`,
        );
        if (!r.success) throw new Error(`link-evidence failed: ${r.stderr}`);
        const id = Number(parseCsvRows(r.stdout)[0]?.[0]);
        if (!Number.isFinite(id)) {
          throw new Error(`claim ${args.claimId} not found`);
        }
        return {
          dataHandles: [],
          output: {
            evidenceId: id,
            claimId: args.claimId,
            artifactType: args.artifactType,
          },
        };
      },
    },

    score: {
      description:
        "Derive a claim's verified level from its evidence (rubric L0–L5)",
      arguments: z.object({
        bench: z.string(),
        claimId: z.number().optional().describe(
          "Score one claim; omit to score every claim in the bench",
        ),
      }),
      execute: async (
        args: { bench: string; claimId?: number },
        _context: ModelContext,
      ) => {
        const where = args.claimId ? `WHERE id=${args.claimId}` : "";
        const claims = await runDuckDB(
          args.bench,
          `SELECT id, level FROM claims ${where} ORDER BY id;`,
        );
        if (!claims.success) throw new Error(claims.stderr);
        const results: {
          claimId: number;
          assertedLevel: string;
          verifiedLevel: string;
          basis: string[];
          evidenceCount: number;
        }[] = [];
        for (const [id, asserted] of parseCsvRows(claims.stdout)) {
          const ev = await runDuckDB(
            args.bench,
            `SELECT artifact_type FROM evidence WHERE claim_id=${id};`,
          );
          const types = parseCsvRows(ev.stdout).map((r) => r[0]);
          const { level, basis } = deriveLevel(types);
          results.push({
            claimId: Number(id),
            assertedLevel: asserted,
            verifiedLevel: level,
            basis,
            evidenceCount: types.length,
          });
        }
        return { dataHandles: [], output: { claims: results } };
      },
    },

    reconcile: {
      description:
        "Compare an asserted dump profile against an observed inventory; records a reconcile evidence row",
      arguments: z.object({
        bench: z.string(),
        claimId: z.number(),
        asserted: z.string().describe(
          'JSON object, e.g. {"totalBytes":65293448396,"fileCount":1342,"dbs":["A","B"]}',
        ),
        observed: z.string().describe(
          'JSON object, e.g. {"totalBytes":123,"fileCount":1205,"dbs":["A"]}',
        ),
        note: z.string().optional(),
      }),
      execute: async (
        args: {
          bench: string;
          claimId: number;
          asserted: string;
          observed: string;
          note?: string;
        },
        _context: ModelContext,
      ) => {
        const a = JSON.parse(args.asserted) as Record<string, unknown>;
        const o = JSON.parse(args.observed) as Record<string, unknown>;
        const verdicts: {
          field: string;
          asserted: string | null;
          observed: string | null;
          verdict: "match" | "mismatch" | "partial" | "unverifiable";
        }[] = [];
        const fieldPairs: [string, string][] = [
          ["totalBytes", "totalBytes"],
          ["fileCount", "fileCount"],
          ["dbNames", "dbNames"],
        ];
        for (const [af, of_] of fieldPairs) {
          const av = a[af];
          const ov = o[of_];
          if (av === undefined || ov === undefined) {
            verdicts.push({
              field: af,
              asserted: av === undefined ? null : JSON.stringify(av),
              observed: ov === undefined ? null : JSON.stringify(ov),
              verdict: "unverifiable",
            });
            continue;
          }
          if (af === "totalBytes") {
            const ab = toBytes(av as string | number);
            const ob = toBytes(ov as string | number);
            if (ab === null || ob === null) {
              verdicts.push({
                field: af,
                asserted: String(av),
                observed: String(ov),
                verdict: "unverifiable",
              });
            } else {
              const ratio = Math.min(ab, ob) / Math.max(ab, ob);
              verdicts.push({
                field: af,
                asserted: String(ab),
                observed: String(ob),
                verdict: ratio >= 0.98
                  ? "match"
                  : ratio >= 0.8
                  ? "partial"
                  : "mismatch",
              });
            }
          } else if (af === "dbNames") {
            const as = new Set((av as string[]).map((s) => s.toLowerCase()));
            const os = new Set((ov as string[]).map((s) => s.toLowerCase()));
            const allFound = [...as].every((s) => os.has(s));
            const extras = [...os].filter((s) => !as.has(s));
            verdicts.push({
              field: af,
              asserted: JSON.stringify([...as].sort()),
              observed: JSON.stringify([...os].sort()),
              verdict: allFound
                ? extras.length > 0 ? "partial" : "match"
                : "mismatch",
            });
          } else {
            const an = Number(av);
            const on = Number(ov);
            const ratio = Math.min(an, on) / Math.max(an, on);
            verdicts.push({
              field: af,
              asserted: String(av),
              observed: String(ov),
              verdict: ratio >= 0.98
                ? "match"
                : ratio >= 0.8
                ? "partial"
                : "mismatch",
            });
          }
        }
        const hasMismatch = verdicts.some((v) => v.verdict === "mismatch");
        const hasPartial = verdicts.some((v) => v.verdict === "partial");
        const anyObserved = verdicts.some((v) => v.verdict !== "unverifiable");
        const overall = hasMismatch
          ? "inconsistent"
          : hasPartial
          ? "partial"
          : anyObserved
          ? "consistent"
          : "inconclusive";
        const detail = `${overall}|` +
          verdicts
            .map((v) =>
              `${v.field}:${v.verdict}(${v.asserted} vs ${v.observed})`
            )
            .join("; ") +
          (args.note ? `|${esc(args.note)}` : "");
        const r = await runDuckDB(
          args.bench,
          `INSERT INTO evidence(claim_id, incident, artifact_type, ref, note) SELECT ${args.claimId}, incident, 'reconcile', 'bench-reconcile', '${
            esc(detail)
          }' FROM claims WHERE id=${args.claimId} RETURNING id;`,
        );
        if (!r.success) throw new Error(`reconcile failed: ${r.stderr}`);
        const evId = Number(parseCsvRows(r.stdout)[0]?.[0]);
        if (!Number.isFinite(evId)) {
          throw new Error(`claim ${args.claimId} not found`);
        }
        return {
          dataHandles: [],
          output: { claimId: args.claimId, verdicts, overall },
        };
      },
    },

    "record-disclosure": {
      description:
        "Register a public statement (victim/operator/regulator) as corroboration evidence",
      arguments: z.object({
        bench: z.string(),
        claimId: z.number(),
        statement: z.string().describe("Statement text or excerpt"),
        source: z.string().describe("URL or citation of the statement"),
        date: z.string().optional(),
      }),
      execute: async (
        args: {
          bench: string;
          claimId: number;
          statement: string;
          source: string;
          date?: string;
        },
        _context: ModelContext,
      ) => {
        const note = `disclosure ${args.date ?? "undated"}: ${
          esc(args.statement)
        }`;
        const r = await runDuckDB(
          args.bench,
          `INSERT INTO evidence(claim_id, incident, artifact_type, ref, note) SELECT ${args.claimId}, incident, 'disclosure', '${
            esc(args.source)
          }', '${
            esc(note)
          }' FROM claims WHERE id=${args.claimId} RETURNING id;`,
        );
        if (!r.success) {
          throw new Error(`record-disclosure failed: ${r.stderr}`);
        }
        const id = Number(parseCsvRows(r.stdout)[0]?.[0]);
        if (!Number.isFinite(id)) {
          throw new Error(`claim ${args.claimId} not found`);
        }
        return {
          dataHandles: [],
          output: {
            evidenceId: id,
            claimId: args.claimId,
            artifactType: "disclosure",
          },
        };
      },
    },

    "record-snapshot": {
      description:
        "Persist a capture (fetch/listing/recon) with sha256 + byte attribution",
      arguments: z.object({
        bench: z.string(),
        incident: z.string(),
        artifactType: z.enum(["snapshot", "listing", "recon", "sample"])
          .default("snapshot"),
        sourceUrl: z.string().optional(),
        filePath: z.string().optional(),
        sha256: z.string().optional(),
        bytes: z.number().optional(),
        httpCode: z.number().optional(),
        note: z.string().optional(),
      }),
      execute: async (
        args: {
          bench: string;
          incident: string;
          artifactType: string;
          sourceUrl?: string;
          filePath?: string;
          sha256?: string;
          bytes?: number;
          httpCode?: number;
          note?: string;
        },
        _context: ModelContext,
      ) => {
        const r = await runDuckDB(
          args.bench,
          `INSERT INTO snapshots(incident, artifact_type, source_url, file_path, sha256, bytes, http_code, note) VALUES ('${
            esc(args.incident)
          }', '${esc(args.artifactType)}', ${
            args.sourceUrl ? `'${esc(args.sourceUrl)}'` : "NULL"
          }, ${args.filePath ? `'${esc(args.filePath)}'` : "NULL"}, ${
            args.sha256 ? `'${esc(args.sha256)}'` : "NULL"
          }, ${args.bytes ?? "NULL"}, ${args.httpCode ?? "NULL"}, ${
            args.note ? `'${esc(args.note)}'` : "NULL"
          }) RETURNING id;`,
        );
        if (!r.success) throw new Error(`record-snapshot failed: ${r.stderr}`);
        const id = Number(parseCsvRows(r.stdout)[0]?.[0]);
        return {
          dataHandles: [],
          output: {
            snapshotId: id,
            sha256: args.sha256 ?? null,
            bytes: args.bytes ?? null,
          },
        };
      },
    },

    "record-state": {
      description:
        "Persist an onion watch-state check and diff against the previous one (alert trigger)",
      arguments: z.object({
        bench: z.string(),
        incident: z.string(),
        target: z.string().describe(
          "Watched target (article page, file browser, key)",
        ),
        status: z.enum(["up", "down", "changed", "hijacked"]),
        httpCode: z.number().optional(),
        bytes: z.number().optional(),
        sha256: z.string().optional(),
        note: z.string().optional(),
      }),
      execute: async (
        args: {
          bench: string;
          incident: string;
          target: string;
          status: string;
          httpCode?: number;
          bytes?: number;
          sha256?: string;
          note?: string;
        },
        _context: ModelContext,
      ) => {
        const prevRows = await runDuckDB(
          args.bench,
          `SELECT status, http_code, bytes, checked_at FROM onion_state WHERE incident='${
            esc(args.incident)
          }' AND target='${
            esc(args.target)
          }' ORDER BY checked_at DESC LIMIT 1;`,
        );
        if (!prevRows.success) throw new Error(prevRows.stderr);
        const prev = parseCsvRows(prevRows.stdout)[0];
        const previous = prev
          ? {
            status: prev[0],
            httpCode: prev[1] ? Number(prev[1]) : null,
            bytes: prev[2] ? Number(prev[2]) : null,
            checkedAt: prev[3],
          }
          : null;
        const next = {
          status: args.status,
          httpCode: args.httpCode ?? null,
          bytes: args.bytes ?? null,
        };
        const changed = stateChanged(previous, next);
        const r = await runDuckDB(
          args.bench,
          `INSERT INTO onion_state(incident, target, status, http_code, bytes, sha256, note) VALUES ('${
            esc(args.incident)
          }', '${esc(args.target)}', '${args.status}', ${
            args.httpCode ?? "NULL"
          }, ${args.bytes ?? "NULL"}, ${
            args.sha256 ? `'${esc(args.sha256)}'` : "NULL"
          }, ${args.note ? `'${esc(args.note)}'` : "NULL"});`,
        );
        if (!r.success) throw new Error(`record-state failed: ${r.stderr}`);
        return {
          dataHandles: [],
          output: {
            changed,
            previous,
            current: { ...next, checkedAt: new Date().toISOString() },
          },
        };
      },
    },

    report: {
      description:
        "Verification status: claims with asserted vs verified levels",
      arguments: z.object({
        bench: z.string(),
        incident: z.string().optional(),
      }),
      execute: async (
        args: { bench: string; incident?: string },
        context: ModelContext,
      ) => {
        const where = args.incident
          ? `WHERE incident='${esc(args.incident)}'`
          : "";
        const claimsRows = await runDuckDB(
          args.bench,
          `SELECT id, incident, text, level, status, asserted_by, asserted_at FROM claims ${where} ORDER BY id;`,
        );
        if (!claimsRows.success) throw new Error(claimsRows.stderr);
        const claims: {
          id: number;
          incident: string;
          text: string;
          level: string;
          status: string;
          assertedBy: string;
          assertedAt: string | null;
          evidenceCount: number;
        }[] = [];
        const stale: number[] = [];
        for (const row of parseCsvRows(claimsRows.stdout)) {
          const ev = await runDuckDB(
            args.bench,
            `SELECT count(*) FROM evidence WHERE claim_id=${row[0]};`,
          );
          const count = Number(parseCsvRows(ev.stdout)[0]?.[0] ?? 0);
          const typesRaw = count === 0 ? "" : (await runDuckDB(
            args.bench,
            `SELECT artifact_type FROM evidence WHERE claim_id=${row[0]};`,
          )).stdout;
          const { level } = deriveLevel(
            typesRaw.trim().split("\n").filter(Boolean).map((l: string) =>
              l.replace(/^"|"$/g, "")
            ),
          );
          const assertedAt = row[6] && row[6] !== "" ? row[6] : null;
          const olderThan14d = assertedAt
            ? (Date.now() - new Date(assertedAt).getTime()) > 14 * 864e5
            : false;
          if (olderThan14d && level === "L0") stale.push(Number(row[0]));
          claims.push({
            id: Number(row[0]),
            incident: row[1],
            text: row[2],
            level,
            status: row[4],
            assertedBy: row[5],
            assertedAt,
            evidenceCount: count,
          });
        }
        const snapCount = await runDuckDB(
          args.bench,
          `SELECT count(*) FROM snapshots ${where};`,
        );
        const incidentCount = await runDuckDB(
          args.bench,
          `SELECT count(*) FROM incidents;`,
        );
        const result = {
          bench: args.bench,
          incident: args.incident ?? null,
          incidents: Number(parseCsvRows(incidentCount.stdout)[0]?.[0] ?? 0),
          claims,
          staleClaims: stale,
          snapshots: Number(parseCsvRows(snapCount.stdout)[0]?.[0] ?? 0),
          generatedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "report",
          `${args.incident ?? "all"}-${Date.now()}`,
          result,
        );
        return { dataHandles: [handle], output: result };
      },
    },
  },
};
