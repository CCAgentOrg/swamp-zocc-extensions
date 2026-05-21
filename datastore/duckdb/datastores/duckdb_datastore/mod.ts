// DuckDB Datastore Extension for Swamp
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
}

interface LockOptions {
  lockKey?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  resolveDatastorePath(repoDir: string): string;
  resolveCachePath(repoDir: string): string | undefined;
}

const ConfigSchema = z.object({
  database: z.string().describe(
    "Path to the DuckDB database file. Use ':memory:' for an in-memory database.",
  ),
  schema: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message:
      "Schema must be a valid SQL identifier (letters, digits, underscores)",
  }).default("swamp").describe(
    "DuckDB schema for swamp tables",
  ),
  accessMode: z.enum(["read_write", "read_only"]).default("read_write")
    .describe(
      "Database access mode: read_write (default) or read_only",
    ),
});

type DuckDBConfig = z.output<typeof ConfigSchema>;

/**
 * Execute a SQL command via the duckdb CLI and return parsed output.
 */
async function runDuckDB(
  dbPath: string,
  sql: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const cmd = new Deno.Command("duckdb", {
    args: ["--csv", dbPath, "-c", sql],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  return { stdout, stderr, success: output.success };
}

/**
 * Ensure required tables exist in the DuckDB database.
 */
async function ensureSchema(
  dbPath: string,
  schema: string,
): Promise<void> {
  await runDuckDB(dbPath, `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await runDuckDB(
    dbPath,
    `CREATE TABLE IF NOT EXISTS ${schema}.locks (
      key       VARCHAR PRIMARY KEY,
      holder    VARCHAR NOT NULL,
      hostname  VARCHAR NOT NULL,
      pid       INTEGER NOT NULL,
      acquired_at TIMESTAMP NOT NULL,
      ttl_ms    INTEGER NOT NULL,
      nonce     VARCHAR
    )`,
  );
}

/**
 * Create a file-based distributed lock backed by DuckDB rows.
 *
 * Uses a two-step acquire pattern compatible with DuckDB:
 * 1. Try INSERT — succeeds if no lock exists.
 * 2. If conflict, check for stale lock and DELETE it for retry.
 */
function createDuckDBLock(
  dbPath: string,
  schema: string,
  datastorePath: string,
  options?: LockOptions,
): DistributedLock {
  const key = options?.lockKey ?? datastorePath;
  const locksTable = `${schema}.locks`;
  const ttlMs = options?.ttlMs ?? 30_000;
  const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  let nonce: string | undefined;
  let heartbeatId: number | undefined;

  function esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  function startHeartbeat(escapedKey: string, acquiredNonce: string): void {
    heartbeatId = setInterval(async () => {
      try {
        await runDuckDB(
          dbPath,
          `UPDATE ${locksTable} SET acquired_at = now() WHERE key = '${escapedKey}' AND nonce = '${acquiredNonce}'`,
        );
      } catch {
        // DB may be busy — lock expires via TTL
      }
    }, ttlMs / 3);
  }

  const acquire = async () => {
    if (nonce !== undefined) {
      throw new Error("Lock already acquired; call release() first");
    }

    const start = Date.now();
    nonce = crypto.randomUUID();

    try {
      await ensureSchema(dbPath, schema);
      const holder = `${Deno.env.get("USER") ?? "unknown"}@${Deno.hostname()}`;
      const hostname = Deno.hostname();
      const pid = Deno.pid;

      while (Date.now() - start < maxWaitMs) {
        const ek = esc(key);
        const eh = esc(holder);
        const ehn = esc(hostname);

        // Step 1: Try to insert a new lock row.
        const insertResult = await runDuckDB(
          dbPath,
          `INSERT INTO ${locksTable} (key, holder, hostname, pid, acquired_at, ttl_ms, nonce)
           VALUES ('${ek}', '${eh}', '${ehn}', ${pid}, now(), ${ttlMs}, '${nonce}')`,
        );

        if (insertResult.success) {
          // Fresh insert — lock acquired.
          startHeartbeat(ek, nonce!);
          return;
        }

        // Step 2: Lock row exists — check if stale.
        const staleSeconds = Math.floor(ttlMs / 1000);
        const staleResult = await runDuckDB(
          dbPath,
          `SELECT nonce FROM ${locksTable}
           WHERE key = '${ek}'
             AND acquired_at + INTERVAL '${staleSeconds} seconds' < now()`,
        );

        if (
          staleResult.success &&
          staleResult.stdout.trim().split("\n").length >= 2
        ) {
          // Stale — delete so next iteration can insert fresh.
          await runDuckDB(
            dbPath,
            `DELETE FROM ${locksTable} WHERE key = '${ek}'`,
          );
        }

        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    } catch (e) {
      nonce = undefined;
      throw e;
    }
    nonce = undefined;
    throw new Error(`Lock timeout after ${maxWaitMs}ms on key: ${key}`);
  };

  const release = async () => {
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
    if (nonce) {
      try {
        await runDuckDB(
          dbPath,
          `DELETE FROM ${locksTable} WHERE key = '${esc(key)}' AND nonce = '${
            esc(nonce)
          }'`,
        );
      } catch {
        // DB may be busy — lock expires via TTL
      }
      nonce = undefined;
    }
  };

  return {
    acquire,
    release,

    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await fn();
      } finally {
        await release();
      }
    },

    inspect: async () => {
      try {
        const { stdout, success } = await runDuckDB(
          dbPath,
          `SELECT holder, hostname, pid, acquired_at, ttl_ms, nonce FROM ${locksTable} WHERE key = '${
            esc(key)
          }'`,
        );
        if (!success || !stdout.trim()) return null;

        const lines = stdout.trim().split("\n");
        if (lines.length < 2) return null;

        const values = lines[1].split(",");
        return {
          holder: values[0]?.replace(/^"|"$/g, "") ?? "",
          hostname: values[1]?.replace(/^"|"$/g, "") ?? "",
          pid: parseInt(values[2] ?? "0", 10),
          acquiredAt: values[3]?.replace(/^"|"$/g, "") ?? "",
          ttlMs: parseInt(values[4] ?? "30000", 10),
          nonce: values[5]?.replace(/^"|"$/g, ""),
        };
      } catch {
        return null;
      }
    },

    forceRelease: async (expectedNonce: string) => {
      try {
        const { success } = await runDuckDB(
          dbPath,
          `DELETE FROM ${locksTable} WHERE key = '${esc(key)}' AND nonce = '${
            esc(expectedNonce)
          }'`,
        );
        return success;
      } catch {
        return false;
      }
    },
  };
}

/**
 * DuckDB datastore provider for swamp.
 *
 * Stores swamp runtime data in a DuckDB database file with row-based
 * distributed locking. Since DuckDB is embedded, this is a local-only
 * datastore — no sync service needed.
 *
 * @example
 * ```yaml
 * # .swamp.yaml
 * datastore:
 *   type: "@zocc/duckdb-datastore"
 *   config:
 *     database: "/path/to/swamp.duckdb"
 *     schema: "swamp"
 * ```
 *
 * @example
 * ```bash
 * # Environment variable
 * export SWAMP_DATASTORE='@zocc/duckdb-datastore:{"database":"/data/swamp.duckdb"}'
 * ```
 */
export const datastore = {
  type: "@zocc/duckdb-datastore",
  name: "DuckDB Datastore",
  description:
    "Stores swamp runtime data in a DuckDB database file with row-based distributed locking. Embedded, local-only — no network dependency.",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>): DatastoreProvider => {
    const parsed = ConfigSchema.parse(config);

    return {
      createLock: (
        datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        return createDuckDBLock(
          parsed.database,
          parsed.schema,
          datastorePath,
          options,
        );
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            await ensureSchema(parsed.database, parsed.schema);

            const { success, stderr } = await runDuckDB(
              parsed.database,
              `SELECT 1 AS ok`,
            );

            if (!success) {
              return {
                healthy: false,
                message: `DuckDB query failed: ${stderr.trim()}`,
                latencyMs: Math.round(performance.now() - start),
                datastoreType: "@zocc/duckdb-datastore",
                details: { database: parsed.database, schema: parsed.schema },
              };
            }

            const dbInfo = parsed.database === ":memory:"
              ? "in-memory"
              : parsed.database;

            return {
              healthy: true,
              message: "OK",
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@zocc/duckdb-datastore",
              details: {
                database: dbInfo,
                schema: parsed.schema,
                accessMode: parsed.accessMode,
              },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@zocc/duckdb-datastore",
            };
          }
        },
      }),

      resolveDatastorePath: (_repoDir: string): string =>
        parsed.database === ":memory:" ? ":memory:" : parsed.database,

      resolveCachePath: (_repoDir: string): string | undefined => undefined,
    };
  },
};
