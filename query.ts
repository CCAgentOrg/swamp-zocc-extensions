/**
 * DuckDB query model for swamp.
 *
 * Run SQL queries against local DuckDB databases, list tables, inspect
 * schemas, and export query results as structured data resources.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({});

const ColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
});

const TableSchema = z.object({
  name: z.string(),
  columns: z.array(ColumnSchema),
  columnCount: z.number(),
});

const TableListSchema = z.object({
  database: z.string(),
  tables: z.array(TableSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const QueryResultRow = z.record(z.unknown());
type QueryResultRow = z.infer<typeof QueryResultRow>;

const QueryResultSchema = z.object({
  database: z.string(),
  query: z.string(),
  columns: z.array(z.string()),
  rows: z.array(QueryResultRow),
  rowCount: z.number(),
  truncated: z.boolean(),
  truncatedAt: z.number().optional(),
  durationMs: z.number(),
  fetchedAt: z.string(),
});

const SummaryRow = z.object({
  table: z.string(),
  columnCount: z.number().optional(),
  estimatedRows: z.string().optional(),
});

const SummarySchema = z.object({
  database: z.string(),
  tables: z.array(SummaryRow),
  totalTables: z.number(),
  fetchedAt: z.string(),
});

const ImportResultSchema = z.object({
  database: z.string(),
  source: z.string(),
  table: z.string(),
  format: z.string(),
  rowsLoaded: z.number(),
  columns: z.array(z.string()),
  durationMs: z.number(),
  fetchedAt: z.string(),
});

const ExportResultSchema = z.object({
  database: z.string(),
  sql: z.string(),
  destination: z.string(),
  format: z.string(),
  rowsExported: z.number(),
  fileSize: z.number(),
  durationMs: z.number(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helper Functions
// =============================================================================

function detectFormat(pathOrUrl: string): string {
  const lower = pathOrUrl.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return "ndjson";
  if (lower.endsWith(".parquet")) return "parquet";
  return "csv";
}

async function runDuckDB(
  dbPath: string,
  sql: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const args = ["-csv", "-c", sql, dbPath];
  const cmd = new Deno.Command("duckdb", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.success,
  };
}

function parseCSV(csv: string): { columns: string[]; rows: QueryResultRow[] } {
  const lines = csv.trim().split("\n");
  if (lines.length < 1) return { columns: [], rows: [] };

  const columns = parseCSVLine(lines[0]);
  const rows: QueryResultRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row: QueryResultRow = {};
    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = values[j] ?? null;
    }
    rows.push(row);
  }
  return { columns, rows };
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

/**
 * DuckDB query model for running SQL against local .duckdb files.
 *
 * Provides three methods: list_tables (schema inspection), query (arbitrary SQL),
 * and summarize (quick overview with row counts).
 *
 * @example
 * // Create the model
 * swamp model create @zocc/duckdb mydb;
 *
 * // Query a database
 * swamp model method run mydb query \
 *   --input database=/path/to/data.duckdb \
 *   --input sql="SELECT * FROM my_table LIMIT 10";
 */
export const model = {
  type: "@zocc/duckdb",
  version: "2026.05.21.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    tables: {
      description: "List of tables and their column schemas in a database",
      schema: TableListSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    query_result: {
      description: "Results of a SQL query against a DuckDB database",
      schema: QueryResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    summary: {
      description: "High-level summary of all tables in a database",
      schema: SummarySchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    import_result: {
      description: "Result of importing data into a DuckDB table",
      schema: ImportResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    export_result: {
      description: "Result of exporting data from a DuckDB database",
      schema: ExportResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_tables: {
      description:
        "List all tables with their column names and types in a DuckDB database",
      arguments: z.object({
        database: z.string().describe("Path to the DuckDB database file"),
      }),
      execute: async (
        args: { database: string },
        context: ModelContext,
      ) => {
        const { stdout, success, stderr } = await runDuckDB(
          args.database,
          "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='main' ORDER BY table_name, ordinal_position",
        );
        if (!success) {
          throw new Error(`Failed to list tables: ${stderr}`);
        }

        const { rows } = parseCSV(stdout);
        const tableMap = new Map<string, typeof TableSchema._type>();

        for (const row of rows) {
          const tableName = String(row["table_name"] ?? "");
          if (!tableMap.has(tableName)) {
            tableMap.set(tableName, {
              name: tableName,
              columns: [],
              columnCount: 0,
            });
          }
          const table = tableMap.get(tableName)!;
          table.columns.push({
            name: String(row["column_name"] ?? ""),
            type: String(row["data_type"] ?? ""),
            nullable: String(row["is_nullable"] ?? "").toUpperCase() === "YES",
          });
          table.columnCount = table.columns.length;
        }

        const tables = Array.from(tableMap.values());

        context.logger.info("Found {count} tables in {db}", {
          count: tables.length,
          db: args.database,
        });

        const handle = await context.writeResource(
          "tables",
          args.database.replace(/[\/\.]/g, "-"),
          {
            database: args.database,
            tables,
            count: tables.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    query: {
      description:
        "Execute a SQL query against a DuckDB database and return structured results",
      arguments: z.object({
        database: z.string().describe("Path to the DuckDB database file"),
        sql: z.string().describe("SQL query to execute"),
        limit: z.number().default(100).describe(
          "Maximum number of rows to return (0 = unlimited)",
        ),
      }),
      execute: async (
        args: { database: string; sql: string; limit: number },
        context: ModelContext,
      ) => {
        let sql = args.sql.trim().replace(/;+\s*$/, "");
        let truncated = false;
        let truncatedAt: number | undefined;

        if (args.limit > 0 && !sql.toUpperCase().includes("LIMIT")) {
          sql += ` LIMIT ${args.limit}`;
          truncatedAt = args.limit;
        }

        const start = performance.now();
        const { stdout, success, stderr } = await runDuckDB(args.database, sql);
        const durationMs = Math.round(performance.now() - start);

        if (!success) {
          throw new Error(`Query failed: ${stderr}`);
        }

        const { columns, rows } = parseCSV(stdout);
        if (args.limit > 0 && rows.length === args.limit) {
          truncated = true;
        }

        context.logger.info("Query returned {rows} rows in {ms}ms from {db}", {
          rows: rows.length,
          ms: durationMs,
          db: args.database,
        });

        const instanceName = `query-${Date.now()}`;
        const handle = await context.writeResource(
          "query_result",
          instanceName,
          {
            database: args.database,
            query: args.sql,
            columns,
            rows,
            rowCount: rows.length,
            truncated,
            truncatedAt,
            durationMs,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    summarize: {
      description:
        "Get a high-level summary of all tables in a DuckDB database with row counts",
      arguments: z.object({
        database: z.string().describe("Path to the DuckDB database file"),
      }),
      execute: async (
        args: { database: string },
        context: ModelContext,
      ) => {
        const { stdout, success, stderr } = await runDuckDB(
          args.database,
          `SELECT table_name, COUNT(*) AS column_count FROM information_schema.columns WHERE table_schema='main' GROUP BY table_name ORDER BY table_name`,
        );
        if (!success) {
          throw new Error(`Failed to summarize: ${stderr}`);
        }

        const { rows } = parseCSV(stdout);

        const tables: typeof SummaryRow[] = [];
        for (const row of rows) {
          const tableName = String(row["table_name"] ?? "");
          const colCount = Number(row["column_count"] ?? 0);

          let estimatedRows: string | undefined;
          try {
            const countResult = await runDuckDB(
              args.database,
              `SELECT COUNT(*)::VARCHAR AS cnt FROM "${tableName}"`,
            );
            if (countResult.success) {
              const countRows = parseCSV(countResult.stdout);
              if (countRows.rows.length > 0) {
                estimatedRows = String(countRows.rows[0]["cnt"] ?? "");
              }
            }
          } catch {
            estimatedRows = undefined;
          }

          tables.push({
            table: tableName,
            columnCount: colCount,
            estimatedRows,
          });
        }

        context.logger.info("Summarized {count} tables in {db}", {
          count: tables.length,
          db: args.database,
        });

        const handle = await context.writeResource(
          "summary",
          args.database.replace(/[\/\.]/g, "-"),
          {
            database: args.database,
            tables,
            totalTables: tables.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    import_data: {
      description:
        "Import data from a file (CSV, JSON, Parquet) into a DuckDB table",
      arguments: z.object({
        database: z.string().describe("Path to the DuckDB database file"),
        source: z.string().describe(
          "Path or URL to the source file (CSV, JSON, NDJSON, or Parquet)",
        ),
        table: z.string().describe("Target table name to import into"),
        format: z.string().default("auto").describe(
          "Source format: csv, json, ndjson, parquet, or auto (detect from extension)",
        ),
        create_table: z.boolean().default(true).describe(
          "CREATE TABLE IF NOT EXISTS before importing",
        ),
        delimiter: z.string().default(",").describe(
          "Column delimiter for CSV files (default: comma)",
        ),
        header: z.boolean().default(true).describe(
          "Whether the source CSV has a header row",
        ),
      }),
      execute: async (
        args: {
          database: string;
          source: string;
          table: string;
          format: string;
          create_table: boolean;
          delimiter: string;
          header: boolean;
        },
        context: ModelContext,
      ) => {
        const fmt = args.format === "auto"
          ? detectFormat(args.source)
          : args.format.toLowerCase();
        const start = performance.now();

        let sql: string;

        switch (fmt) {
          case "parquet": {
            if (args.create_table) {
              sql =
                `CREATE TABLE IF NOT EXISTS "${args.table}" AS SELECT * FROM read_parquet('${args.source}')`;
            } else {
              sql =
                `INSERT INTO "${args.table}" SELECT * FROM read_parquet('${args.source}')`;
            }
            break;
          }
          case "json": {
            if (args.create_table) {
              sql =
                `CREATE TABLE IF NOT EXISTS "${args.table}" AS SELECT * FROM read_json_auto('${args.source}')`;
            } else {
              sql =
                `INSERT INTO "${args.table}" SELECT * FROM read_json_auto('${args.source}')`;
            }
            break;
          }
          case "ndjson": {
            if (args.create_table) {
              sql =
                `CREATE TABLE IF NOT EXISTS "${args.table}" AS SELECT * FROM read_ndjson('${args.source}')`;
            } else {
              sql =
                `INSERT INTO "${args.table}" SELECT * FROM read_ndjson('${args.source}')`;
            }
            break;
          }
          case "csv":
          default: {
            const delim = args.delimiter === "\\t" ? "\\t" : args.delimiter;
            if (args.create_table) {
              sql =
                `CREATE TABLE IF NOT EXISTS "${args.table}" AS SELECT * FROM read_csv_auto('${args.source}', header=${args.header}, delim='${delim}')`;
            } else {
              sql =
                `INSERT INTO "${args.table}" SELECT * FROM read_csv_auto('${args.source}', header=${args.header}, delim='${delim}')`;
            }
            break;
          }
        }

        const { success, stderr } = await runDuckDB(args.database, sql);
        const durationMs = Math.round(performance.now() - start);

        if (!success) {
          throw new Error(`Import failed: ${stderr}`);
        }

        const columns: string[] = [];
        let rowsLoaded = 0;

        const colResult = await runDuckDB(
          args.database,
          `SELECT column_name FROM information_schema.columns WHERE table_schema='main' AND table_name='${args.table}' ORDER BY ordinal_position`,
        );
        if (colResult.success) {
          const colRows = parseCSV(colResult.stdout);
          columns.push(
            ...colRows.rows.map((r) => String(r["column_name"] ?? "")),
          );
        }

        const countResult = await runDuckDB(
          args.database,
          `SELECT COUNT(*)::VARCHAR AS cnt FROM "${args.table}"`,
        );
        if (countResult.success) {
          const countRows = parseCSV(countResult.stdout);
          rowsLoaded = Number(countRows.rows[0]?.["cnt"] ?? 0);
        }

        context.logger.info(
          "Imported {rows} rows into {table} from {source} ({fmt}) in {ms}ms",
          {
            rows: rowsLoaded,
            table: args.table,
            source: args.source,
            fmt,
            ms: durationMs,
          },
        );

        const handle = await context.writeResource(
          "import_result",
          `${args.table}-${Date.now()}`,
          {
            database: args.database,
            source: args.source,
            table: args.table,
            format: fmt,
            rowsLoaded,
            columns,
            durationMs,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    export_data: {
      description:
        "Export query results or an entire table to CSV, JSON, or Parquet",
      arguments: z.object({
        database: z.string().describe("Path to the DuckDB database file"),
        destination: z.string().describe(
          "Output file path (extension determines format: .csv, .json, .parquet)",
        ),
        sql: z.string().optional().describe(
          "SQL query to export (use instead of table)",
        ),
        table: z.string().optional().describe(
          "Table name to export (use instead of sql)",
        ),
        format: z.string().default("auto").describe(
          "Output format: csv, json, parquet, or auto (detect from destination extension)",
        ),
        delimiter: z.string().default(",").describe(
          "Column delimiter for CSV output (default: comma)",
        ),
        header: z.boolean().default(true).describe(
          "Whether to include header row in CSV output",
        ),
      }),
      execute: async (
        args: {
          database: string;
          destination: string;
          sql?: string;
          table?: string;
          format: string;
          delimiter: string;
          header: boolean;
        },
        context: ModelContext,
      ) => {
        const destination = args.destination!;
        const fmt = args.format === "auto"
          ? detectFormat(destination)
          : args.format.toLowerCase();

        if (!args.sql && !args.table) {
          throw new Error("Must provide either 'sql' or 'table' to export");
        }

        const query = args.sql
          ? args.sql.trim().replace(/;+\s*$/, "")
          : `SELECT * FROM "${args.table}"`;

        const start = performance.now();
        let sql: string;
        const delim = args.delimiter === "\\t" ? "\\t" : args.delimiter;

        switch (fmt) {
          case "parquet": {
            sql = `COPY (${query}) TO '${destination}' (FORMAT PARQUET)`;
            break;
          }
          case "json": {
            sql =
              `COPY (${query}) TO '${destination}' (FORMAT JSON, ARRAY true)`;
            break;
          }
          case "csv":
          default: {
            sql =
              `COPY (${query}) TO '${destination}' (FORMAT CSV, HEADER ${args.header}, DELIM '${delim}')`;
            break;
          }
        }

        const { stdout, success, stderr } = await runDuckDB(args.database, sql);
        const durationMs = Math.round(performance.now() - start);

        if (!success) {
          throw new Error(`Export failed: ${stderr}`);
        }

        const rowsExported = Number(stdout.trim() || 0);
        let fileSize = 0;

        try {
          const stat = await Deno.stat(destination);
          fileSize = stat.size;
        } catch {
          fileSize = 0;
        }

        context.logger.info(
          "Exported {rows} rows to {dest} ({fmt}, {size} bytes) in {ms}ms",
          {
            rows: rowsExported,
            dest: destination,
            fmt,
            size: fileSize,
            ms: durationMs,
          },
        );

        const handle = await context.writeResource(
          "export_result",
          `${fmt}-${Date.now()}`,
          {
            database: args.database,
            sql: query,
            destination,
            format: fmt,
            rowsExported,
            fileSize,
            durationMs,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
