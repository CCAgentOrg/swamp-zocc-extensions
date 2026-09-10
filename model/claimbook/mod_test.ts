// @zocc/claimbook — Unit Tests
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers exercised without DuckDB: SQL escaping, level derivation,
// state-change detection, and human-size normalization.

import { assertEquals } from "jsr:@std/assert@1";
import { deriveLevel, esc, stateChanged, toBytes } from "./mod.ts";

Deno.test("esc escapes SQL string literals", () => {
  assertEquals(esc("it's fine"), "it''s fine");
  assertEquals(esc("no quotes"), "no quotes");
});

Deno.test("deriveLevel follows the rubric", () => {
  assertEquals(deriveLevel([]).level, "L0");
  assertEquals(deriveLevel(["snapshot"]).level, "L1");
  assertEquals(deriveLevel(["listing", "recon"]).level, "L1");
  assertEquals(deriveLevel(["snapshot", "reconcile"]).level, "L2");
  assertEquals(deriveLevel(["reconcile", "sample"]).level, "L3");
  assertEquals(deriveLevel(["disclosure"]).level, "L4");
  assertEquals(deriveLevel(["gov", "press", "snapshot"]).level, "L4");
  assertEquals(deriveLevel(["published"]).level, "L5");
  const r = deriveLevel(["snapshot"]);
  assertEquals(r.basis.length, 1);
});

Deno.test("stateChanged fires only on real deltas", () => {
  assertEquals(
    stateChanged(null, { status: "up", httpCode: 200, bytes: 10 }),
    true,
  );
  assertEquals(
    stateChanged(
      { status: "up", httpCode: 200, bytes: 10 },
      { status: "up", httpCode: 200, bytes: 10 },
    ),
    false,
  );
  assertEquals(
    stateChanged(
      { status: "up", httpCode: 200, bytes: 10 },
      { status: "up", httpCode: 200, bytes: 11 },
    ),
    true,
  );
  assertEquals(
    stateChanged(
      { status: "up", httpCode: 200, bytes: null },
      { status: "up", httpCode: 200, bytes: 11 },
    ),
    false,
  );
  assertEquals(
    stateChanged(
      { status: "up", httpCode: 200, bytes: 10 },
      { status: "down", httpCode: null, bytes: null },
    ),
    true,
  );
});

Deno.test("toBytes normalizes human sizes", () => {
  assertEquals(toBytes("13.7 MB"), 13_700_000);
  assertEquals(toBytes("60.8 GB"), 60_800_000_000);
  assertEquals(toBytes(1234), 1234);
  assertEquals(toBytes("1,342"), 1342);
  assertEquals(toBytes(null), null);
  assertEquals(toBytes("soon"), null);
});
