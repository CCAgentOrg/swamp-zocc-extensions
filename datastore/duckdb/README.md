# DuckDB Extension for Swamp

DuckDB integration for swamp — query model + embedded datastore backend.

## Required Tools

- `duckdb` CLI (https://duckdb.org/) — install via your package manager or
  `curl https://shell.duckdb.org/install.sh | sh`

## Extension Components

| Component                | Type      | Description                                                                 |
| ------------------------ | --------- | --------------------------------------------------------------------------- |
| `@zocc/duckdb`           | Model     | SQL query methods (list_tables, query, summarize, import_data, export_data) |
| `@zocc/duckdb-datastore` | Datastore | Swamp runtime storage backend using DuckDB                                  |

## Quick Start

```bash
swamp extension pull @zocc/duckdb
swamp model create @zocc/duckdb mydb
```

## Methods

### `list_tables`

List all tables with column names, types, and nullability.

```bash
swamp model method run mydb list_tables \
  --input database=/path/to/data.duckdb
```

### `query`

Execute arbitrary SQL and return structured results.

```bash
swamp model method run mydb query \
  --input database=/path/to/data.duckdb \
  --input sql="SELECT * FROM t LIMIT 10" \
  --input limit=100
```

### `summarize`

Quick overview with row counts per table.

```bash
swamp model method run mydb summarize \
  --input database=/path/to/data.duckdb
```

### `import_data`

Load CSV, JSON, NDJSON, or Parquet files into a DuckDB table. Supports both
local files and HTTP URLs.

```bash
# Import from local CSV
swamp model method run mydb import_data \
  --input database=/path/to/data.duckdb \
  --input source=/path/to/data.csv \
  --input table=my_table \
  --input format=csv \
  --input create_table=true

# Import from URL
swamp model method run mydb import_data \
  --input database=/path/to/data.duckdb \
  --input source="https://example.com/data.parquet" \
  --input table=remote_data \
  --input format=parquet

# Append to existing table
swamp model method run mydb import_data \
  --input database=/path/to/data.duckdb \
  --input source=/path/to/more.csv \
  --input table=my_table \
  --input format=csv \
  --input create_table=false
```

**Supported formats:** `csv`, `json`, `ndjson` (JSON Lines), `parquet`, `auto`
(detect from extension)

### `export_data`

Export query results or an entire table to CSV, JSON, or Parquet.

```bash
# Export a table to CSV
swamp model method run mydb export_data \
  --input database=/path/to/data.duckdb \
  --input table=my_table \
  --input destination=/output/data.csv

# Export a query to JSON
swamp model method run mydb export_data \
  --input database=/path/to/data.duckdb \
  --input sql="SELECT category, COUNT(*) AS cnt FROM t GROUP BY category" \
  --input destination=/output/summary.json

# Export to Parquet
swamp model method run mydb export_data \
  --input database=/path/to/data.duckdb \
  --input sql="SELECT * FROM large_table" \
  --input destination=/output/data.parquet
```

**Supported formats:** `csv`, `json`, `parquet`, `auto` (detect from destination
extension)

## Datastore Usage

Use DuckDB as swamp's runtime storage backend instead of the default filesystem.

```yaml
# .swamp.yaml
datastore:
  type: "@zocc/duckdb-datastore"
  config:
    database: "/path/to/swamp-data.duckdb"
    schema: "swamp"
```

The datastore auto-creates the schema and locks table on first use.

## Workflow Example: Ingest → Query → Export

```yaml
version: 1
models:
  - name: fetch-data
    type: "@zocc/duckdb"
    method: import_data
    arguments:
      database: "./data/analysis.duckdb"
      source: "https://api.example.com/transactions.csv"
      table: transactions
      format: csv

  - name: analyze
    type: "@zocc/duckdb"
    method: query
    dependsOn:
      - fetch-data
    arguments:
      database: "./data/analysis.duckdb"
      sql: "SELECT category, SUM(amount) as total FROM transactions GROUP BY category"

  - name: publish
    type: "@zocc/duckdb"
    method: export_data
    dependsOn:
      - analyze
    arguments:
      database: "./data/analysis.duckdb"
      destination: "./output/category_totals.json"
      format: json
```

## Known Flaws {#openflaw}

This extension ships under the
[OpenFlaw Manifesto](https://ccagentorg.github.io/OpenFlaw/): _Don't hide your
flaws. Ship anyway._

| Flaw                                                  | Impact                                               | Mitigation                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Subprocess overhead — every query spawns `duckdb` CLI | ~50-100ms latency per call                           | Use the datastore backend for repeated operations; batch queries in SQL                         |
| No connection pooling                                 | Concurrent queries serialize through CLI invocations | Design workflows to chain sequentially; DuckDB itself handles parallelism within a single query |
| File-lock contention in datastore                     | Multi-process writes may retry on lock collision     | Nonce-based locks auto-expire after 5s; retries are transparent                                 |
| Large result sets truncated in model output           | `limit=0` (unlimited) can OOM on huge tables         | Always set a sensible limit; use `export_data` for full dumps                                   |
| No in-process DuckDB — requires CLI binary            | Fails if `duckdb` not on PATH                        | Documented in Required Tools; clear error message from the model                                |

> Perfection is an illusion. Utility through honesty is the goal.

## License

Apache-2.0
