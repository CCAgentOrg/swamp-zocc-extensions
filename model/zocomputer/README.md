# @zocc/zocomputer — Zo Computer MCP + Ask model for swamp

Interact with your Zo Computer from any swamp workflow. Two access modes:

- **Ask** (`ask`) — conversational AI via `/zo/ask`. Send a prompt, get a response from Zo's model. Good for analysis, writing, research questions.
- **MCP** (`mcp_list_tools`, `mcp_call_tool`) — direct access to Zo's full 89+ tool surface over JSON-RPC. Read files, search the web, generate images, manage services, send messages, and more.

Plus convenience wrappers for common tools: `web_search`, `read_file`, `generate_image`.

## Installation

```sh
swamp extension install @zocc/zocomputer
```

## Prerequisites

Must run inside a Zo Computer session — the extension reads `ZO_CLIENT_IDENTITY_TOKEN` from the environment automatically.

## Methods

| Method | Description | Inputs | Output |
| --- | --- | --- | --- |
| `ask` | Send a prompt to Zo's conversational AI | input, model? | askResult |
| `mcp_list_tools` | List all Zo MCP tools with descriptions | filter? | toolList |
| `mcp_call_tool` | Call any Zo MCP tool by name | name, arguments | toolCallResult |
| `web_search` | Search the web via web_search MCP | query, max_results?, time_range? | toolCallResult |
| `read_file` | Read a file from the Zo workspace | path, start_line?, end_line? | toolCallResult |
| `generate_image` | Generate an image via AI image generation | prompt, aspect_ratio?, n? | toolCallResult |

## Examples

### Ask Zo a question

```sh
swamp model method run my-zo ask --input input="What's the latest RBI repo rate?"
```

### List all Zo tools

```sh
swamp model method run my-zo mcp_list_tools
```

### List tools matching "web"

```sh
swamp model method run my-zo mcp_list_tools --input filter=web
```

### Call a tool directly (search the web)

```sh
swamp model method run my-zo mcp_call_tool \
  --input name=web_search \
  --input arguments='{"query": "India GDP 2026", "time_range": "year"}'
```

```sh
swamp model method run my-zo web_search --input query="latest UPI trends"
```

### Read a file

```sh
swamp model method run my-zo read_file \
  --input path=/home/workspace/AGENTS.md
```

### Generate an image

```sh
swamp model method run my-zo generate_image \
  --input prompt="A futuristic Indian city with UPI payments everywhere" \
  --input aspect_ratio=16:9
```

## Development

```sh
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

## Auth

No additional configuration needed. The extension authenticates using `ZO_CLIENT_IDENTITY_TOKEN`, which is automatically available when running inside a Zo Computer session.

## License

Apache-2.0 — see LICENSE.md for details.
