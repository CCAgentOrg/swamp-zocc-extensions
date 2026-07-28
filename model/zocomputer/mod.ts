/**
 * Zo Computer MCP + Ask model for swamp.
 *
 * Interact with the Zo Computer API through a single extension:
 *  - ask:     conversational AI via /zo/ask (HTTP POST)
 *  - mcp_list_tools, mcp_call_tool: full Zo tool surface (89+ tools)
 *    via MCP JSON-RPC at api.zo.computer/mcp
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { DataHandle, ModelContext } from "swamp:model";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({});

const AskResultSchema = z.object({
  model: z.string(),
  output: z.string(),
  durationMs: z.number(),
  fetchedAt: z.string(),
  conversationId: z.string().optional(),
  error: z.string().optional(),
});

const MCPToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
});

const ToolListSchema = z.object({
  tools: z.array(MCPToolSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const ToolCallResultSchema = z.object({
  tool: z.string(),
  result: z.string(),
  isError: z.boolean(),
  fetchedAt: z.string(),
  error: z.string().optional(),
});

// =============================================================================
// Constants
// =============================================================================

const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const ZO_MCP_URL = "https://api.zo.computer/mcp";

function getToken(): string {
  const t = Deno.env.get("ZO_CLIENT_IDENTITY_TOKEN");
  if (!t) {
    throw new Error(
      "ZO_CLIENT_IDENTITY_TOKEN not set — run inside Zo Computer",
    );
  }
  return t;
}

// =============================================================================
// MCP Client (JSON-RPC)
// =============================================================================

interface MCPResponse {
  result?: {
    content?: { type: string; text?: string }[];
    tools?: MCPToolType[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

interface MCPToolType {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

async function mcpCall(
  method: string,
  params?: unknown,
): Promise<MCPResponse> {
  const res = await fetch(ZO_MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function mcpListTools(): Promise<MCPToolType[]> {
  const data = await mcpCall("tools/list");
  return data.result?.tools ?? [];
}

async function mcpCallTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const data = await mcpCall("tools/call", { name, arguments: args });
  if (data.error) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }
  const content = data.result?.content ?? [];
  const text = content.map((c) => c.text ?? "").join("\n").trim();
  if (data.result?.isError) throw new Error(text || "Tool returned error");
  return text;
}

// =============================================================================
// /zo/ask client
// =============================================================================

async function askZo(input: string, modelName?: string): Promise<{
  output: string;
  durationMs: number;
  conversationId?: string;
}> {
  const start = performance.now();
  const res = await fetch(ZO_ASK_URL, {
    method: "POST",
    headers: {
      authorization: getToken(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input,
      model_name: modelName ?? "byok:b5700bd6-fca9-4aa2-9d31-bc9f5bb33bbc",
    }),
  });
  const durationMs = Math.round(performance.now() - start);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Zo Ask API ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    output: data.output ?? JSON.stringify(data),
    durationMs,
    conversationId: data.conversation_id,
  };
}

// =============================================================================
// Model
// =============================================================================

/**
 * Zo Computer model for swamp.
 *
 * Provides access to the Zo Computer AI and tool surface via two channels:
 *
 * **HTTP API (/zo/ask)** — high-level conversational AI. Send prompts and receive
 * responses with optional streaming. Methods: `ask`.
 *
 * **MCP API (api.zo.computer/mcp)** — granular tool operations (89 tools covering
 * file ops, web search, AI generation, integrations, space management, and more).
 * Methods: `listTools`, `toolCall`, `runCode`, `readFile`, `writeFile`, `search`.
 *
 * @module
 */
export const model = {
  type: "@zocc/zocomputer",
  version: "2026.07.29.1",

  globalArguments: GlobalArgsSchema,

  resources: {
    askResult: {
      description: "Zo conversational AI response",
      schema: AskResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    toolList: {
      description: "List of Zo MCP tools with their schemas",
      schema: ToolListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    toolCallResult: {
      description: "Result from calling a Zo MCP tool",
      schema: ToolCallResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    /**
     * Send a natural-language prompt to Zo's conversational AI and get a response.
     *
     * Wraps the /zo/ask HTTP endpoint. Use for open-ended questions, analysis,
     * writing, or any task that benefits from Zo's full context and reasoning.
     */
    /**
     * Ask Zo a conversational question. Wraps the HTTP /zo/ask endpoint. Returns the model's text response with metadata.
     */
    ask: {
      description: "Send a prompt to Zo's conversational AI and get a response",
      arguments: z.object({
        input: z.string().min(1).describe(
          "The prompt or question for Zo",
        ),
        model: z.string().optional().describe(
          "Optional model override (e.g. 'byok:b5700bd6-fca9-4aa2-9d31-bc9f5bb33bbc')",
        ),
      }),
      execute: async (
        args: { input: string; model?: string },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        const result = await askZo(args.input, args.model);

        const handle = await context.writeResource("askResult", "main", {
          model: args.model ?? "default",
          output: result.output,
          durationMs: result.durationMs,
          fetchedAt: new Date().toISOString(),
          conversationId: result.conversationId,
        });
        return { dataHandles: [handle] };
      },
    },

    /**
     * List all MCP tools available on this Zo Computer.
     *
     * Returns the full 89+ tool roster with descriptions and input schemas,
     * so you can discover what's available and how to call each tool.
     */
    mcp_list_tools: {
      description: "List all Zo MCP tools with descriptions and input schemas",
      arguments: z.object({
        filter: z.string().optional().describe(
          "Optional substring to filter tool names (e.g. 'web', 'file')",
        ),
      }),
      execute: async (
        args: { filter?: string },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        const tools = await mcpListTools();
        const filtered = args.filter
          ? tools.filter((t) =>
            t.name.toLowerCase().includes(args.filter!.toLowerCase())
          )
          : tools;

        const handle = await context.writeResource("toolList", "main", {
          tools: filtered,
          count: filtered.length,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    /**
     * Call any Zo MCP tool by name with typed arguments.
     *
     * Pass the tool name and its arguments as a JSON object. The full
     * Zo tool surface (89+ tools) is accessible — file ops, web search,
     * image generation, email, browser, space management, etc.
     *
     * Use `mcp_list_tools` first to discover available tool names and schemas.
     */
    mcp_call_tool: {
      description: "Call any Zo MCP tool by name with arguments",
      arguments: z.object({
        name: z.string().min(1).describe(
          "Tool name (e.g. 'web_search', 'read_file', 'generate_image', 'bash')",
        ),
        arguments: z.string().describe(
          "Tool arguments as a JSON object matching the tool's input_schema",
        ),
      }),
      execute: async (
        args: { name: string; arguments: string },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        let result: string;
        let isError = false;
        let error: string | undefined;

        try {
          let parsedArgs: Record<string, unknown> = {};
          if (typeof args.arguments === "string") {
            parsedArgs = JSON.parse(args.arguments);
          }
          result = await mcpCallTool(args.name, parsedArgs);
        } catch (e) {
          isError = true;
          error = e instanceof Error ? e.message : String(e);
          result = error;
        }

        const handle = await context.writeResource(
          "toolCallResult",
          args.name,
          {
            tool: args.name,
            result,
            isError,
            fetchedAt: new Date().toISOString(),
            error,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /**
     * Convenience: search the web for a query and return results.
     *
     * Thin wrapper around Zo's `web_search` MCP tool for quick lookups
     * without needing to construct the MCP call manually.
     */
    web_search: {
      description: "Search the web via Zo's web_search MCP tool",
      arguments: z.object({
        query: z.string().min(1).describe("Search query"),
        max_results: z.number().int().min(1).max(50).optional()
          .describe("Maximum results to return (default 10)"),
        time_range: z.enum(["anytime", "day", "week", "month", "year"])
          .optional()
          .describe("Time range filter"),
      }),
      execute: async (
        args: { query: string; max_results?: number; time_range?: string },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        const mcpArgs: Record<string, unknown> = { query: args.query };
        if (args.max_results) mcpArgs.max_results = args.max_results;
        if (args.time_range) mcpArgs.time_range = args.time_range;

        const result = await mcpCallTool("web_search", mcpArgs);
        const handle = await context.writeResource(
          "toolCallResult",
          `web_search:${args.query.slice(0, 40)}`,
          {
            tool: "web_search",
            result,
            isError: false,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /**
     * Convenience: read a file from the Zo workspace.
     *
     * Thin wrapper around Zo's `read_file` MCP tool.
     */
    read_file: {
      description: "Read a file from the Zo workspace",
      arguments: z.object({
        path: z.string().min(1).describe(
          "Absolute path to the file (e.g. '/home/workspace/example.md')",
        ),
        start_line: z.number().int().optional()
          .describe("Optional starting line number (1-indexed)"),
        end_line: z.number().int().optional()
          .describe("Optional ending line number (1-indexed, inclusive)"),
      }),
      execute: async (
        args: { path: string; start_line?: number; end_line?: number },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        const mcpArgs: Record<string, unknown> = {
          target_file: args.path,
        };
        if (args.start_line !== undefined) mcpArgs.start_line = args.start_line;
        if (args.end_line !== undefined) mcpArgs.end_line = args.end_line;

        const result = await mcpCallTool("read_file", mcpArgs);
        const handle = await context.writeResource(
          "toolCallResult",
          `read_file:${args.path.split("/").pop()}`,
          {
            tool: "read_file",
            result,
            isError: false,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /**
     * Convenience: generate an image via Zo's image generation.
     *
     * Thin wrapper around Zo's `generate_image` MCP tool.
     */
    generate_image: {
      description: "Generate an image via Zo's AI image generation",
      arguments: z.object({
        prompt: z.string().min(1).describe("Image description prompt"),
        aspect_ratio: z
          .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"])
          .optional()
          .describe("Aspect ratio (default 1:1)"),
        n: z.number().int().min(1).max(4).optional()
          .describe("Number of images to generate (default 1)"),
      }),
      execute: async (
        args: { prompt: string; aspect_ratio?: string; n?: number },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<DataHandle> }> => {
        const mcpArgs: Record<string, unknown> = {
          prompt: args.prompt,
          file_stem: args.prompt.slice(0, 40).replace(/\s+/g, "_"),
        };
        if (args.aspect_ratio) mcpArgs.aspect_ratio = args.aspect_ratio;
        if (args.n) mcpArgs.n = args.n;

        const result = await mcpCallTool("generate_image", mcpArgs);
        const handle = await context.writeResource(
          "toolCallResult",
          `generate_image:${args.prompt.slice(0, 40)}`,
          {
            tool: "generate_image",
            result,
            isError: false,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
