/**
 * @zocc/onion — Tor onion-service observability model.
 *
 * Network layer of the breach-verification bench:
 *  - bootstrap: idempotently bring up a persistent Tor SOCKS daemon
 *  - probe:     availability check for an onion URL (no state written)
 *  - fetch:     evidence snapshot capture with sha256 + byte attribution
 *  - crawl-listing: parse dump-inventory listings (DireWolf filebrowser HTML
 *               or enumeration JSON), with PII-bearing filename masking
 *
 * State persistence and claim scoring live in @zocc/claimbook; this model
 * is deliberately stateless between calls.
 *
 * @example
 * swamp model create @zocc/onion dodo-watch;
 * swamp model method run dodo-watch bootstrap --input socksPort=9150;
 * swamp model method run dodo-watch probe \
 *   --input url=http://direwolf...onion/ --input socksPort=9150;
 * swamp model method run dodo-watch fetch \
 *   --input url=http://direwolf...onion/api/download?path=... \
 *   --input destination=/home/workspace/Projects/dodo-leak/source/x.html;
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { ModelContext } from "swamp:model";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const GlobalArgsSchema = z.object({});

const ProbeResultSchema = z.object({
  url: z.string(),
  up: z.boolean(),
  httpCode: z.number().nullable(),
  bytes: z.number().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  checkedAt: z.string(),
});

const FetchResultSchema = z.object({
  url: z.string(),
  destination: z.string(),
  saved: z.boolean(),
  sha256: z.string().nullable(),
  bytes: z.number().nullable(),
  httpCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
});

const ListingEntrySchema = z.object({
  name: z.string(),
  path: z.string().nullable(),
  kind: z.enum(["file", "dir"]),
  sizeHuman: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  mtime: z.string().nullable(),
  piiFlagged: z.boolean(),
  piiReasons: z.array(z.string()),
  maskedName: z.string(),
});

const CrawlResultSchema = z.object({
  source: z.string(),
  format: z.enum(["html", "json"]),
  entryCount: z.number(),
  dirCount: z.number(),
  fileCount: z.number(),
  piiFlaggedCount: z.number(),
  approxTotalBytes: z.number(),
  itemsNote: z.string().nullable(),
  entries: z.array(ListingEntrySchema),
  crawledAt: z.string(),
});

/** Parse a human size like "13.7 MB" or "2.6 GB" into bytes. */
export function parseSize(human: string): number | null {
  const m = human.trim().match(/^([\d.,]+)\s*([KMGTP]?i?B)$/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toUpperCase().replace("I", "");
  const mult: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    PB: 1e15,
  };
  return Math.round(value * (mult[unit] ?? 1));
}

/**
 * Mask a filename that may carry PII (account ids, phone-like runs,
 * PAN-like tokens, emails embedded in stems). Extension survives.
 */
export function maskName(name: string): {
  flagged: boolean;
  reasons: string[];
  maskedName: string;
} {
  const reasons: string[] = [];
  if (/\d{9,}/.test(name)) reasons.push("digit-run>=9");
  if (/[A-Za-z]\d{7,}/.test(name)) reasons.push("digit-glued");
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(name)) reasons.push("pan-like");
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(name)) reasons.push("email-like");
  if (
    /(customer|user|account|txn|invoice|upi|vpa|kyc|pan|aadhaar)/i.test(name)
  ) {
    reasons.push("sensitive-stem");
  }
  if (reasons.length === 0) {
    return { flagged: false, reasons: [], maskedName: name };
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const maskedName = stem.replace(/[A-Za-z0-9]/g, "\u2022") + ext;
  return { flagged: true, reasons, maskedName };
}

/** Score a claim level from the set of observed evidence artifact types. */
export function scoreLevel(artifactTypes: string[]): string {
  if (artifactTypes.includes("published")) return "L5";
  if (
    ["disclosure", "recon", "press", "gov"].some((t) =>
      artifactTypes.includes(t)
    )
  ) return "L4";
  if (artifactTypes.includes("sample")) return "L3";
  if (artifactTypes.includes("reconcile")) return "L2";
  if (
    ["snapshot", "listing", "fetch", "capture"].some((t) =>
      artifactTypes.includes(t)
    )
  ) return "L1";
  return "L0";
}

/** Extract DireWolf-style item-card entries from a listing HTML page. */
export function extractItems(html: string): {
  name: string;
  kind: string;
  sizeHuman: string | null;
  mtime: string | null;
  hrefPath: string | null;
}[] {
  const items: {
    name: string;
    kind: string;
    sizeHuman: string | null;
    mtime: string | null;
    hrefPath: string | null;
  }[] = [];
  const cardRe = /<a\s+class="item-card\s+(file|dir)"([^>]*)>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const kind = m[1];
    const attrs = m[2];
    const body = m[3];
    const nameMatch = attrs.match(/data-name="([^"]*)"/) ??
      body.match(/class="item-name"[^>]*>([^<]*)</);
    if (!nameMatch) continue;
    const timeMatch = body.match(/class="item-time"[^>]*>([^<]*)</);
    const sizeMatch = body.match(/class="item-size"[^>]*>([^<]*)</);
    const hrefMatch = attrs.match(/href="([^"]*)"/);
    items.push({
      name: nameMatch[1].trim(),
      kind,
      sizeHuman: sizeMatch ? sizeMatch[1].trim() : null,
      mtime: timeMatch ? timeMatch[1].trim() : null,
      hrefPath: hrefMatch ? hrefMatch[1] : null,
    });
  }
  const seen = new Set(items.map((it) => it.hrefPath));
  const linkRe =
    /<a(?![^>]*class="item-card)[^>]+href="[^?]*\?path=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = linkRe.exec(html)) !== null) {
    const hrefPath = `/?path=${m[1]}`;
    if (seen.has(hrefPath)) continue;
    const name = decodeURIComponent(m[1].split("/").pop() ?? m[1]).trim();
    if (!name) continue;
    seen.add(hrefPath);
    items.push({
      name,
      kind: "dir",
      sizeHuman: null,
      mtime: null,
      hrefPath,
    });
  }
  return items;
}

const itemsNoteRe = /id="total-count"[^>]*>([^<]+)</;

async function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  const child = command.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);
  const output = await child.output();
  clearTimeout(timer);
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function sha256File(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function torUp(socksPort: number): Promise<boolean> {
  const r = await run(
    "curl",
    [
      "--socks5-hostname",
      `127.0.0.1:${socksPort}`,
      "-s",
      "-o",
      "/dev/null",
      "--connect-timeout",
      "6",
      "--max-time",
      "12",
      "https://check.torproject.org/api/ip",
    ],
    15_000,
  );
  return r.code === 0;
}

async function curlMeta(
  socksPort: number,
  url: string,
  timeoutSec: number,
  destination: string | null,
  maxBytes: number | null,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    "--socks5-hostname",
    `127.0.0.1:${socksPort}`,
    "-sS",
    "-L",
    "-A",
    UA,
    "--connect-timeout",
    "15",
    "--max-time",
    String(timeoutSec),
    "-w",
    "%{http_code}\t%{size_download}\t%{time_total}",
  ];
  if (destination) {
    args.push("-o", destination);
    if (maxBytes && maxBytes > 0) args.push("--max-filesize", String(maxBytes));
  } else {
    args.push("-o", "/dev/null");
  }
  args.push(url);
  return await run("curl", args, (timeoutSec + 15) * 1000);
}

export function parseCurlMeta(stdout: string): {
  httpCode: number | null;
  bytes: number | null;
  durationMs: number | null;
} {
  const parts = stdout.trim().split("\t");
  if (parts.length < 3) {
    return { httpCode: null, bytes: null, durationMs: null };
  }
  return {
    httpCode: Number(parts[0]) || null,
    bytes: Number(parts[1]) || null,
    durationMs: Math.round((Number(parts[2]) || 0) * 1000) || null,
  };
}

export const model = {
  type: "@zocc/onion",
  version: "2026.09.10.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    probe_result: {
      description: "Onion endpoint availability probe result",
      schema: ProbeResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 20,
    },
    fetch_result: {
      description: "Evidence snapshot capture result with sha256 attribution",
      schema: FetchResultSchema,
      lifetime: "24h" as const,
      garbageCollection: 20,
    },
    crawl_result: {
      description: "Parsed dump-listing inventory with PII masking applied",
      schema: CrawlResultSchema,
      lifetime: "24h" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    bootstrap: {
      description:
        "Idempotently ensure a Tor SOCKS daemon is listening (spawns one if absent)",
      arguments: z.object({
        socksPort: z.number().default(9150).describe("SOCKS5 port to use"),
        timeoutSec: z.number().default(45).describe(
          "Max seconds to wait for Tor bootstrap",
        ),
        force: z.boolean().default(false).describe(
          "Restart the daemon even if the port already answers",
        ),
      }),
      execute: async (
        args: {
          socksPort: number;
          timeoutSec: number;
          force: boolean;
        },
        context: ModelContext,
      ) => {
        const already = await torUp(args.socksPort);
        if (already && !args.force) {
          context.logger.info("Tor already listening on {port}", {
            port: args.socksPort,
          });
          return {
            dataHandles: [],
            output: {
              socksPort: args.socksPort,
              running: true,
              alreadyRunning: true,
              circuitLatencyMs: null,
              detail: "port already answering via existing daemon",
            },
          };
        }
        if (args.force) {
          await run(
            "pkill",
            ["-f", `SocksPort ${args.socksPort}`],
            5000,
          );
          await new Promise((r) => setTimeout(r, 1000));
        }
        const dataDir = `/tmp/tor-data-${args.socksPort}`;
        const logPath = `/tmp/tor-${args.socksPort}.log`;
        const logFile = await Deno.open(logPath, {
          write: true,
          create: true,
          append: true,
        });
        const command = new Deno.Command("tor", {
          args: [
            "--SocksPort",
            String(args.socksPort),
            "--ControlPort",
            "0",
            "--DataDirectory",
            dataDir,
            "--Log",
            `notice file ${logPath}`,
          ],
          stdout: "null",
          stderr: "null",
          stdin: "null",
        });
        command.spawn().unref();
        logFile.close();
        const deadline = Date.now() + args.timeoutSec * 1000;
        let up = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          if (await torUp(args.socksPort)) {
            up = true;
            break;
          }
        }
        if (!up) {
          throw new Error(
            `Tor failed to bootstrap on port ${args.socksPort} within ${args.timeoutSec}s; see ${logPath}`,
          );
        }
        context.logger.info("Tor bootstrapped on {port}", {
          port: args.socksPort,
        });
        return {
          dataHandles: [],
          output: {
            socksPort: args.socksPort,
            running: true,
            alreadyRunning: false,
            circuitLatencyMs: null,
            detail: `spawned daemon, log ${logPath}`,
          },
        };
      },
    },

    probe: {
      description:
        "Check whether an onion URL is reachable through Tor (stateless)",
      arguments: z.object({
        url: z.string().describe("Onion URL to probe"),
        socksPort: z.number().default(9150).describe("Tor SOCKS5 port"),
        timeoutSec: z.number().default(30).describe("Per-request timeout"),
        ensureTor: z.boolean().default(false).describe(
          "Bootstrap Tor first if the daemon is not running",
        ),
      }),
      execute: async (
        args: {
          url: string;
          socksPort: number;
          timeoutSec: number;
          ensureTor: boolean;
        },
        context: ModelContext,
      ) => {
        if (args.ensureTor && !(await torUp(args.socksPort))) {
          throw new Error(
            "Tor not running; call the bootstrap method first (or set ensureTor and use bootstrap explicitly)",
          );
        }
        const start = performance.now();
        const r = await curlMeta(
          args.socksPort,
          args.url,
          args.timeoutSec,
          null,
          null,
        );
        const meta = parseCurlMeta(r.stdout);
        const durationMs = Math.round(performance.now() - start);
        const up = meta.httpCode !== null && meta.httpCode < 500 &&
          meta.httpCode !== 0;
        const result = {
          url: args.url,
          up,
          httpCode: meta.httpCode,
          bytes: meta.bytes,
          durationMs: meta.durationMs ?? durationMs,
          error: r.code !== 0 && !up ? r.stderr.trim().slice(0, 300) : null,
          checkedAt: new Date().toISOString(),
        };
        context.logger.info(
          "Probe {url}: up={up} http={http} in {ms}ms",
          { url: args.url, up, http: meta.httpCode, ms: result.durationMs },
        );
        const handle = await context.writeResource(
          "probe_result",
          `${Date.now()}`,
          result,
        );
        return { dataHandles: [handle], output: result };
      },
    },

    fetch: {
      description:
        "Capture an evidence snapshot: download via Tor to a local path with sha256 + byte attribution",
      arguments: z.object({
        url: z.string().describe("Onion URL to download"),
        destination: z.string().describe(
          "Absolute local path to save the capture",
        ),
        socksPort: z.number().default(9150).describe("Tor SOCKS5 port"),
        maxBytes: z.number().default(524288000).describe(
          "Abort if the response exceeds this size (0 = unlimited)",
        ),
        timeoutSec: z.number().default(180).describe("Per-request timeout"),
      }),
      execute: async (
        args: {
          url: string;
          destination: string;
          socksPort: number;
          maxBytes: number;
          timeoutSec: number;
        },
        context: ModelContext,
      ) => {
        if (!args.destination.startsWith("/")) {
          throw new Error("destination must be an absolute path");
        }
        await Deno.mkdir(
          args.destination.slice(0, args.destination.lastIndexOf("/")),
          { recursive: true },
        );
        const start = performance.now();
        const r = await curlMeta(
          args.socksPort,
          args.url,
          args.timeoutSec,
          args.destination,
          args.maxBytes,
        );
        const meta = parseCurlMeta(r.stdout);
        const durationMs = Math.round(performance.now() - start);
        let saved = false;
        let sha256: string | null = null;
        let bytes: number | null = meta.bytes;
        try {
          const stat = await Deno.stat(args.destination);
          if (stat.isFile && stat.size !== undefined) {
            saved = true;
            bytes = stat.size;
            sha256 = await sha256File(args.destination);
          }
        } catch {
          saved = false;
        }
        const result = {
          url: args.url,
          destination: args.destination,
          saved,
          sha256,
          bytes,
          httpCode: meta.httpCode,
          durationMs,
          error: !saved
            ? (r.stderr.trim().slice(0, 300) || `curl exit ${r.code}`)
            : null,
          fetchedAt: new Date().toISOString(),
        };
        if (!saved) {
          context.logger.error(
            "Fetch failed for {url}: {err}",
            { url: args.url, err: result.error },
          );
        } else {
          context.logger.info(
            "Captured {url} -> {dest} ({bytes} bytes, sha256 {sha})",
            {
              url: args.url,
              dest: args.destination,
              bytes,
              sha: sha256?.slice(0, 12),
            },
          );
        }
        const handle = await context.writeResource(
          "fetch_result",
          `${Date.now()}`,
          result,
        );
        return { dataHandles: [handle], output: result };
      },
    },

    "crawl-listing": {
      description:
        "Parse a dump-inventory listing (DireWolf filebrowser HTML or enumeration JSON) into masked entries",
      arguments: z.object({
        source: z.string().describe(
          "Listing source: an onion URL or an absolute local file path",
        ),
        socksPort: z.number().default(9150).describe("Tor SOCKS5 port"),
        format: z.enum(["auto", "html", "json"]).default("auto"),
        timeoutSec: z.number().default(60),
      }),
      execute: async (
        args: {
          source: string;
          socksPort: number;
          format: "auto" | "html" | "json";
          timeoutSec: number;
        },
        context: ModelContext,
      ) => {
        let text: string;
        if (args.source.startsWith("http")) {
          const tmp = `/tmp/onion-crawl-${Date.now()}.body`;
          const r = await curlMeta(
            args.socksPort,
            args.source,
            args.timeoutSec,
            tmp,
            null,
          );
          if (r.code !== 0) {
            throw new Error(`fetch failed: ${r.stderr.trim().slice(0, 300)}`);
          }
          text = await Deno.readTextFile(tmp);
        } else {
          text = await Deno.readTextFile(args.source);
        }

        type Entry = z.infer<typeof ListingEntrySchema>;
        let entries: Entry[] = [];
        let format: "html" | "json" = args.format === "json" ? "json" : "html";
        let itemsNote: string | null = null;

        if (args.format !== "html") {
          try {
            const j = JSON.parse(text) as {
              files?: {
                path: string;
                size?: string;
                mtime?: string;
              }[];
            };
            if (Array.isArray(j.files)) {
              entries = j.files.map((f) => {
                const name = f.path.split("/").pop() ?? f.path;
                const masked = maskName(name);
                return {
                  name,
                  path: f.path,
                  kind: "file" as const,
                  sizeHuman: f.size ?? null,
                  sizeBytes: f.size ? parseSize(f.size) : null,
                  mtime: f.mtime ?? null,
                  piiFlagged: masked.flagged,
                  piiReasons: masked.reasons,
                  maskedName: masked.maskedName,
                };
              });
              format = "json";
            }
          } catch { /* fall through to html */ }
        }

        if (entries.length === 0 && args.format !== "json") {
          const noteMatch = text.match(itemsNoteRe);
          if (noteMatch) itemsNote = noteMatch[1].trim();
          entries = extractItems(text).map((it) => {
            const masked = maskName(it.name);
            return {
              name: it.name,
              path: it.hrefPath,
              kind: (it.kind === "dir" ? "dir" : "file") as "dir" | "file",
              sizeHuman: it.sizeHuman,
              sizeBytes: it.sizeHuman ? parseSize(it.sizeHuman) : null,
              mtime: it.mtime,
              piiFlagged: masked.flagged,
              piiReasons: masked.reasons,
              maskedName: masked.maskedName,
            };
          });
          format = "html";
        }

        const result = {
          source: args.source,
          format,
          entryCount: entries.length,
          dirCount: entries.filter((e) => e.kind === "dir").length,
          fileCount: entries.filter((e) => e.kind === "file").length,
          piiFlaggedCount: entries.filter((e) => e.piiFlagged).length,
          approxTotalBytes: entries.reduce(
            (acc, e) => acc + (e.sizeBytes ?? 0),
            0,
          ),
          itemsNote,
          entries,
          crawledAt: new Date().toISOString(),
        };
        context.logger.info(
          "Parsed {count} entries ({dirs} dirs, {files} files, {pii} PII-flagged) from {src}",
          {
            count: result.entryCount,
            dirs: result.dirCount,
            files: result.fileCount,
            pii: result.piiFlaggedCount,
            src: args.source,
          },
        );
        const handle = await context.writeResource(
          "crawl_result",
          `${Date.now()}`,
          result,
        );
        return { dataHandles: [handle], output: result };
      },
    },
  },
};
