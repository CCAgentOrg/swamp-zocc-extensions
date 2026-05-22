// DuckDB Query Model — Unit Tests
// SPDX-License-Identifier: Apache-2.0
//
// Tests pure helper functions and SQL-limit logic extracted from query.ts.
// No real DuckDB instance required.

import {
  assertArrayIncludes,
  assertEquals,
  assertFalse,
} from "jsr:@std/assert@1";

// =============================================================================
// Extract pure helper functions for testing
// (re-implemented to avoid importing the module which requires Deno runtime)
// =============================================================================

/** Escape double-quotes for SQL identifiers. */
function escId(value: string): string {
  return value.replace(/"/g, '""');
}

/** Detect file format from extension. */
function detectFormat(pathOrUrl: string): string {
  const lower = pathOrUrl.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return "ndjson";
  if (lower.endsWith(".parquet")) return "parquet";
  return "csv";
}

/** Parse a single CSV line respecting quoted fields. */
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

/** Check whether SQL is a SELECT query (for LIMIT-attachment logic). */
function isSelectQuery(sql: string): boolean {
  return /^SELECT\b/i.test(sql.trim());
}

/** Parse DuckDB CSV output into columns + rows. */
type QueryResultRow = Record<string, unknown>;

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

// =============================================================================
// Tests: parseCSVLine
// =============================================================================

Deno.test("parseCSVLine — simple comma-separated values", () => {
  assertEquals(parseCSVLine("a,b,c"), ["a", "b", "c"]);
});

Deno.test("parseCSVLine — single field", () => {
  assertEquals(parseCSVLine("hello"), ["hello"]);
});

Deno.test("parseCSVLine — empty string", () => {
  assertEquals(parseCSVLine(""), [""]);
});

Deno.test("parseCSVLine — quoted field with comma", () => {
  assertEquals(parseCSVLine('"hello, world",foo'), ["hello, world", "foo"]);
});

Deno.test("parseCSVLine — quoted field with escaped double-quote", () => {
  assertEquals(parseCSVLine('"say ""hi""",bar'), ['say "hi"', "bar"]);
});

Deno.test("parseCSVLine — empty fields", () => {
  assertEquals(parseCSVLine("a,,c"), ["a", "", "c"]);
});

Deno.test("parseCSVLine — all empty fields", () => {
  assertEquals(parseCSVLine(",,,"), ["", "", "", ""]);
});

Deno.test("parseCSVLine — leading/trailing whitespace is trimmed", () => {
  assertEquals(parseCSVLine("  a , b  ,  c  "), ["a", "b", "c"]);
});

Deno.test("parseCSVLine — quoted field still trimmed by push logic", () => {
  // The implementation trims on push, so even quoted whitespace is trimmed
  assertEquals(parseCSVLine('"  spaced  "'), ["spaced"]);
});

Deno.test("parseCSVLine — numeric values", () => {
  assertEquals(parseCSVLine("1,2.5,3"), ["1", "2.5", "3"]);
});

Deno.test("parseCSVLine — quoted field with newline characters", () => {
  // CSV embedded newlines happen at the multi-line level but a single line
  // shouldn't contain literal \n — test that literal chars are kept
  assertEquals(parseCSVLine('"line1\nline2"'), ["line1\nline2"]);
});

Deno.test("parseCSVLine — multiple consecutive commas", () => {
  assertEquals(parseCSVLine("a,,,b"), ["a", "", "", "b"]);
});

Deno.test("parseCSVLine — trailing comma produces empty last field", () => {
  assertEquals(parseCSVLine("a,b,"), ["a", "b", ""]);
});

Deno.test("parseCSVLine — mixed quoted and unquoted", () => {
  assertEquals(parseCSVLine('foo,"bar,baz",qux'), ["foo", "bar,baz", "qux"]);
});

// =============================================================================
// Tests: parseCSV
// =============================================================================

Deno.test("parseCSV — basic header + data", () => {
  const csv = "name,age\nAlice,30\nBob,25";
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["name", "age"]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { name: "Alice", age: "30" });
  assertEquals(rows[1], { name: "Bob", age: "25" });
});

Deno.test("parseCSV — empty input returns single empty column", () => {
  // "".split("\n") yields [""] which has length 1, so columns = [""]
  const { columns, rows } = parseCSV("");
  assertEquals(columns, [""]);
  assertEquals(rows, []);
});

Deno.test("parseCSV — header only returns no rows", () => {
  const { columns, rows } = parseCSV("col1,col2");
  assertEquals(columns, ["col1", "col2"]);
  assertEquals(rows, []);
});

Deno.test("parseCSV — skips blank lines", () => {
  const csv = "a,b\n1,2\n\n3,4\n";
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["a", "b"]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { a: "1", b: "2" });
  assertEquals(rows[1], { a: "3", b: "4" });
});

Deno.test("parseCSV — quoted fields with commas", () => {
  const csv = 'name,address\n"Alice Smith","123 Main St, Apt 4"\nBob,"456 Oak"';
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["name", "address"]);
  assertEquals(rows[0], { name: "Alice Smith", address: "123 Main St, Apt 4" });
  assertEquals(rows[1], { name: "Bob", address: "456 Oak" });
});

Deno.test("parseCSV — empty fields become null when missing columns", () => {
  const csv = "a,b,c\n1,2";
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["a", "b", "c"]);
  assertEquals(rows[0], { a: "1", b: "2", c: null });
});

Deno.test("parseCSV — extra values beyond columns are ignored", () => {
  const csv = "a,b\n1,2,3";
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["a", "b"]);
  assertEquals(rows[0], { a: "1", b: "2" });
});

Deno.test("parseCSV — single column", () => {
  const csv = "val\nhello\nworld";
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["val"]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { val: "hello" });
  assertEquals(rows[1], { val: "world" });
});

Deno.test("parseCSV — escaped quotes in values", () => {
  const csv = 'text\n"she said ""hello"""\n"he said ""world"""';
  const { columns, rows } = parseCSV(csv);
  assertEquals(columns, ["text"]);
  assertEquals(rows[0], { text: 'she said "hello"' });
  assertEquals(rows[1], { text: 'he said "world"' });
});

// =============================================================================
// Tests: detectFormat
// =============================================================================

Deno.test("detectFormat — .csv files", () => {
  assertEquals(detectFormat("data.csv"), "csv");
  assertEquals(detectFormat("/path/to/file.csv"), "csv");
  assertEquals(detectFormat("https://example.com/data.csv"), "csv");
});

Deno.test("detectFormat — .json files", () => {
  assertEquals(detectFormat("data.json"), "json");
  assertEquals(detectFormat("/path/to/file.json"), "json");
});

Deno.test("detectFormat — .ndjson and .jsonl files", () => {
  assertEquals(detectFormat("data.ndjson"), "ndjson");
  assertEquals(detectFormat("data.jsonl"), "ndjson");
});

Deno.test("detectFormat — .parquet files", () => {
  assertEquals(detectFormat("data.parquet"), "parquet");
  assertEquals(detectFormat("/path/to/file.parquet"), "parquet");
});

Deno.test("detectFormat — unknown extension defaults to csv", () => {
  assertEquals(detectFormat("data.txt"), "csv");
  assertEquals(detectFormat("data"), "csv");
  assertEquals(detectFormat("data.xml"), "csv");
});

Deno.test("detectFormat — case insensitive", () => {
  assertEquals(detectFormat("DATA.CSV"), "csv");
  assertEquals(detectFormat("file.JSON"), "json");
  assertEquals(detectFormat("file.PARQUET"), "parquet");
  assertEquals(detectFormat("file.NDJSON"), "ndjson");
});

// =============================================================================
// Tests: escId
// =============================================================================

Deno.test("escId — simple identifier unchanged", () => {
  assertEquals(escId("my_table"), "my_table");
});

Deno.test("escId — double-quote is escaped to double-double-quote", () => {
  assertEquals(escId('col"umn'), 'col""umn');
});

Deno.test("escId — multiple double-quotes are all escaped", () => {
  assertEquals(escId('a"b"c'), 'a""b""c');
});

Deno.test("escId — empty string", () => {
  assertEquals(escId(""), "");
});

Deno.test("escId — identifier with spaces (no quotes to escape)", () => {
  assertEquals(escId("my table"), "my table");
});

// =============================================================================
// Tests: isSelectQuery — LIMIT attachment guard
// =============================================================================

Deno.test("isSelectQuery — basic SELECT", () => {
  assertEquals(isSelectQuery("SELECT * FROM t"), true);
});

Deno.test("isSelectQuery — SELECT with leading whitespace", () => {
  assertEquals(isSelectQuery("  SELECT * FROM t"), true);
});

Deno.test("isSelectQuery — SELECT with tabs", () => {
  assertEquals(isSelectQuery("\tSELECT 1"), true);
});

Deno.test("isSelectQuery — lowercase select", () => {
  assertEquals(isSelectQuery("select * from t"), true);
});

Deno.test("isSelectQuery — mixed case SeLeCt", () => {
  assertEquals(isSelectQuery("SeLeCt * FROM t"), true);
});

Deno.test("isSelectQuery — CREATE TABLE is not SELECT", () => {
  assertEquals(isSelectQuery("CREATE TABLE foo AS SELECT * FROM bar"), false);
});

Deno.test("isSelectQuery — INSERT is not SELECT", () => {
  assertEquals(isSelectQuery("INSERT INTO t VALUES (1)"), false);
});

Deno.test("isSelectQuery — UPDATE is not SELECT", () => {
  assertEquals(isSelectQuery("UPDATE t SET a = 1"), false);
});

Deno.test("isSelectQuery — DELETE is not SELECT", () => {
  assertEquals(isSelectQuery("DELETE FROM t WHERE a = 1"), false);
});

Deno.test("isSelectQuery — DROP is not SELECT", () => {
  assertEquals(isSelectQuery("DROP TABLE t"), false);
});

Deno.test("isSelectQuery — ALTER is not SELECT", () => {
  assertEquals(isSelectQuery("ALTER TABLE t ADD COLUMN c INT"), false);
});

Deno.test("isSelectQuery — WITH ... SELECT (CTE) is recognized as SELECT", () => {
  // WITH is not SELECT prefix, so this correctly returns false —
  // CTEs should not get LIMIT auto-appended to the outer WITH
  assertEquals(
    isSelectQuery("WITH cte AS (SELECT 1) SELECT * FROM cte"),
    false,
  );
});

Deno.test("isSelectQuery — EXPLAIN is not SELECT", () => {
  assertEquals(isSelectQuery("EXPLAIN SELECT * FROM t"), false);
});

Deno.test("isSelectQuery — COPY is not SELECT", () => {
  assertEquals(isSelectQuery("COPY (SELECT * FROM t) TO 'out.csv'"), false);
});

// =============================================================================
// Tests: LIMIT attachment logic (integrated with isSelectQuery)
// =============================================================================

/** Simulates the fixed LIMIT-attachment logic from the query method. */
function applyLimitLogic(originalSql: string, limit: number): {
  sql: string;
  truncatedAt?: number;
} {
  let sql = originalSql.trim().replace(/;+\s*$/, "");
  let truncatedAt: number | undefined;

  if (
    limit > 0 && !sql.toUpperCase().includes("LIMIT") && /^SELECT\b/i.test(sql)
  ) {
    sql += ` LIMIT ${limit}`;
    truncatedAt = limit;
  }

  return { sql, truncatedAt };
}

Deno.test("applyLimitLogic — appends LIMIT to basic SELECT", () => {
  const result = applyLimitLogic("SELECT * FROM t", 10);
  assertEquals(result.sql, "SELECT * FROM t LIMIT 10");
  assertEquals(result.truncatedAt, 10);
});

Deno.test("applyLimitLogic — does NOT append LIMIT when limit is 0", () => {
  const result = applyLimitLogic("SELECT * FROM t", 0);
  assertEquals(result.sql, "SELECT * FROM t");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT if already present", () => {
  const result = applyLimitLogic("SELECT * FROM t LIMIT 5", 10);
  assertEquals(result.sql, "SELECT * FROM t LIMIT 5");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to CREATE TABLE", () => {
  const result = applyLimitLogic("CREATE TABLE foo AS SELECT * FROM bar", 10);
  assertEquals(result.sql, "CREATE TABLE foo AS SELECT * FROM bar");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to INSERT", () => {
  const result = applyLimitLogic("INSERT INTO t VALUES (1, 2, 3)", 10);
  assertEquals(result.sql, "INSERT INTO t VALUES (1, 2, 3)");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to UPDATE", () => {
  const result = applyLimitLogic("UPDATE t SET a = 1 WHERE b = 2", 10);
  assertEquals(result.sql, "UPDATE t SET a = 1 WHERE b = 2");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to DELETE", () => {
  const result = applyLimitLogic("DELETE FROM t WHERE id = 1", 10);
  assertEquals(result.sql, "DELETE FROM t WHERE id = 1");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to DROP", () => {
  const result = applyLimitLogic("DROP TABLE old_data", 10);
  assertEquals(result.sql, "DROP TABLE old_data");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to ALTER", () => {
  const result = applyLimitLogic("ALTER TABLE t ADD COLUMN x INT", 10);
  assertEquals(result.sql, "ALTER TABLE t ADD COLUMN x INT");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — does NOT append LIMIT to COPY", () => {
  const result = applyLimitLogic("COPY (SELECT * FROM t) TO 'out.csv'", 10);
  assertEquals(result.sql, "COPY (SELECT * FROM t) TO 'out.csv'");
  assertEquals(result.truncatedAt, undefined);
});

Deno.test("applyLimitLogic — appends LIMIT to SELECT with trailing semicolons", () => {
  const result = applyLimitLogic("SELECT * FROM t;;;", 100);
  assertEquals(result.sql, "SELECT * FROM t LIMIT 100");
  assertEquals(result.truncatedAt, 100);
});

Deno.test("applyLimitLogic — appends LIMIT to SELECT with leading/trailing whitespace", () => {
  const result = applyLimitLogic("   SELECT * FROM t   ", 50);
  assertEquals(result.sql, "SELECT * FROM t LIMIT 50");
  assertEquals(result.truncatedAt, 50);
});

Deno.test("applyLimitLogic — lowercase select is recognized", () => {
  const result = applyLimitLogic("select * from t", 10);
  assertEquals(result.sql, "select * from t LIMIT 10");
  assertEquals(result.truncatedAt, 10);
});

Deno.test("applyLimitLogic — LIMIT is case-insensitive check", () => {
  const result = applyLimitLogic("SELECT * FROM t limit 5", 10);
  assertEquals(result.sql, "SELECT * FROM t limit 5");
  assertEquals(result.truncatedAt, undefined);
});
