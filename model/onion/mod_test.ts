// @zocc/onion — Unit Tests
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers exercised without a Tor daemon: size parsing, PII masking,
// claim-level scoring, listing extraction, and curl output parsing.

import { assertEquals } from "jsr:@std/assert@1";
import {
  extractItems,
  maskName,
  parseCurlMeta,
  parseSize,
  scoreLevel,
} from "./mod.ts";

Deno.test("parseSize handles human units", () => {
  assertEquals(parseSize("13.7 MB"), 13_700_000);
  assertEquals(parseSize("2.6 GB"), 2_600_000_000);
  assertEquals(parseSize("772.9 KB"), 772_900);
  assertEquals(parseSize("512 B"), 512);
  assertEquals(parseSize("nonsense"), null);
});

Deno.test("maskName flags PII-bearing filenames", () => {
  const digits = maskName("account_123456789_export.json");
  assertEquals(digits.flagged, true);
  assertEquals(digits.reasons.includes("digit-run>=9"), true);
  assertEquals(digits.maskedName.startsWith("\u2022"), true);
  assertEquals(digits.maskedName.endsWith(".json"), true);

  const clean = maskName("stripe_payment_intents.json");
  assertEquals(clean.flagged, false);
  assertEquals(clean.maskedName, "stripe_payment_intents.json");

  const stem = maskName("kyc_upi_customers_2026.csv");
  assertEquals(stem.flagged, true);
  assertEquals(stem.reasons.includes("sensitive-stem"), true);
});

Deno.test("scoreLevel follows the bench rubric", () => {
  assertEquals(scoreLevel([]), "L0");
  assertEquals(scoreLevel(["snapshot"]), "L1");
  assertEquals(scoreLevel(["snapshot", "reconcile"]), "L2");
  assertEquals(scoreLevel(["reconcile", "sample"]), "L3");
  assertEquals(scoreLevel(["disclosure", "snapshot"]), "L4");
  assertEquals(scoreLevel(["recon", "published"]), "L5");
});

Deno.test("extractItems parses DireWolf item-card listings", () => {
  const html = `<!doctype html><html><body>
  <div class="stats"><span id="total-count">311 items</span></div>
  <a class="item-card file" href="/api/download?path=DodoPayments%2FClickhouse_Prod%2Frefunds.json"
     data-name="dodo_prod_psp_recon.stripe_refunds.json">
    <div class="item-info">
      <div class="item-name" title="dodo_prod_psp_recon.stripe_refunds.json">dodo_prod_psp_recon.stripe_refunds.json</div>
      <div class="item-meta">
        <span class="item-time">2026-08-10 12:41 UTC</span>
        <span class="item-size">13.7 MB</span>
      </div>
    </div>
  </a>
  <a class="item-card dir" href="/?path=DodoPayments%2FClickhouse_dev" data-name="Clickhouse_dev">
    <div class="item-info"><div class="item-name">Clickhouse_dev</div></div>
  </a>
  <a href="/?path=CollaHealth">CollaHealth</a>
  </body></html>`;
  const items = extractItems(html);
  assertEquals(items.length, 3);
  assertEquals(items[0].kind, "file");
  assertEquals(items[0].sizeHuman, "13.7 MB");
  assertEquals(items[0].mtime, "2026-08-10 12:41 UTC");
  assertEquals(items[1].kind, "dir");
  assertEquals(items[1].name, "Clickhouse_dev");
  assertEquals(items[2].name, "CollaHealth");
});

Deno.test("parseCurlMeta reads curl -w triplets", () => {
  const meta = parseCurlMeta("200\t1234\t1.5");
  assertEquals(meta.httpCode, 200);
  assertEquals(meta.bytes, 1234);
  assertEquals(meta.durationMs, 1500);
  assertEquals(parseCurlMeta("garbage").httpCode, null);
});
