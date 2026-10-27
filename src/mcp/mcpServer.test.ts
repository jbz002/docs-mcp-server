/**
 * Tests for the MCP server factory: tool argument handling and response
 * formatting through a real MCP client, telemetry privacy, the advertised tool
 * schemas, and the instructions sent to clients during initialization.
 *
 * This fork registers search/retrieval tools only; the management tools
 * upstream also registers are served through the REST API instead.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionStatus } from "../store/types";
import { telemetry } from "../telemetry";
import type { AppConfig } from "../utils/config";
import { createMcpServerFactory, resolveServerInstructions } from "./mcpServer";
import type { McpServerTools } from "./tools";

vi.mock("../telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry")>()),
  telemetry: { track: vi.fn() },
}));

const mockConfig = {
  app: { readOnly: false },
  server: { name: "docs-mcp-server" },
  scraper: { maxPages: 100, maxDepth: 3 },
} as unknown as AppConfig;

const mockReadOnlyConfig = {
  app: { readOnly: true },
  server: { name: "docs-mcp-server" },
  scraper: { maxPages: 100, maxDepth: 3 },
} as unknown as AppConfig;

const mockTools = {
  listLibraries: { execute: vi.fn(async () => ({ libraries: [] })) },
  findVersion: { execute: vi.fn(async () => "Version found") },
  search: { execute: vi.fn(async () => ({ results: [] })) },
  fetchUrl: { execute: vi.fn(async () => "# Mock content") },
} as unknown as McpServerTools;

/** Creates a server the way the entry points do: through the factory, with instructions resolved from the config. */
function createServer(config: AppConfig): McpServer {
  return createMcpServerFactory(mockTools, config)();
}

/**
 * Connects a real MCP client to the server over an in-memory transport, so
 * tool arguments are validated and parsed by the SDK as they are in production.
 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** Calls one tool on a fresh normal-mode server and returns the text of its response. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await connectClient(createServer(mockConfig));
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP tools", () => {
  it("keeps URL paths, queries and search text out of telemetry", async () => {
    const cases = [
      {
        tool: "search_docs",
        args: {
          library: "react",
          query: "how do I use secret hooks",
          version: "19.0.0",
        },
        execute: mockTools.search.execute,
        forbidden: ["secret"],
        sent: { queryLength: 25 },
      },
    ];

    for (const { tool, args, execute, forbidden, sent } of cases) {
      await callTool(tool, args);

      const event = vi
        .mocked(telemetry.track)
        .mock.calls.find(([, data]) => data?.tool === tool);
      expect.soft(event?.[1], `${tool} event`).toMatchObject(sent);
      for (const text of forbidden) {
        expect.soft(JSON.stringify(event), `${tool} event`).not.toContain(text);
      }
      // The tool itself still gets the full argument
      expect
        .soft(JSON.stringify(vi.mocked(execute).mock.calls), `${tool} call`)
        .toContain("secret");
    }
  });

  it("returns a failed tool call as a tool error", async () => {
    vi.mocked(mockTools.search.execute).mockRejectedValueOnce(
      new Error("Library 'react' not found in the store."),
    );
    const client = await connectClient(createServer(mockConfig));

    const result = await client.callTool({
      name: "search_docs",
      arguments: { library: "react", query: "hooks" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not found in the store");
  });

  it("says when a search has no results", async () => {
    const text = await callTool("search_docs", {
      library: "react",
      query: "hooks lifecycle",
    });

    expect(text).toContain("No results found");
  });
});

describe("MCP versions resource", () => {
  it("finds a library by its name, ignoring case and percent-encoding", async () => {
    vi.mocked(mockTools.listLibraries.execute).mockResolvedValueOnce({
      libraries: [
        {
          name: "My-Library",
          versions: [versionInfo("1.0.0"), versionInfo("2.0.0")],
        },
      ],
    });
    const client = await connectClient(createServer(mockConfig));

    const result = await client.readResource({
      uri: "docs://libraries/my%2Dlibrary/versions",
    });

    const texts = result.contents.map((content) =>
      "text" in content ? content.text : "",
    );
    expect(texts).toEqual(["1.0.0", "2.0.0"]);
  });
});

/** A library version as listLibraries reports it. */
function versionInfo(version: string) {
  return {
    id: 1,
    version,
    documentCount: 0,
    uniqueUrlCount: 0,
    indexedAt: "2026-01-01T00:00:00Z",
    status: VersionStatus.COMPLETED,
  };
}

/** Lists the tools the way a protocol client sees them. */
async function listToolsOverTheWire(config: AppConfig) {
  const client = await connectClient(createServer(config));
  const body = (await client.listTools()) as {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, any>;
    }>;
  };
  return body.tools;
}

describe("MCP tool advertisement over protocol 2026-07-28", () => {
  it("advertises the retrieval tools in normal mode", async () => {
    const tools = await listToolsOverTheWire(mockConfig);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "find_version",
      "list_libraries",
      "search_docs",
    ]);
  });

  it("advertises the same retrieval tools in read-only mode", async () => {
    const tools = await listToolsOverTheWire(mockReadOnlyConfig);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "find_version",
      "list_libraries",
      "search_docs",
    ]);
  });

  it("keeps argument descriptions in the advertised schema", async () => {
    const tools = await listToolsOverTheWire(mockConfig);
    const search = tools.find((tool) => tool.name === "search_docs");

    for (const [name, property] of Object.entries(search?.inputSchema.properties ?? {})) {
      expect((property as { description?: string }).description, name).toBeTruthy();
    }
  });
});

describe("MCP Server instructions", () => {
  it.each([
    { mode: "normal", config: mockConfig },
    { mode: "read-only", config: mockReadOnlyConfig },
  ])("describes the server's retrieval scope ($mode mode)", async ({ config }) => {
    const client = await connectClient(createServer(config));

    expect(client.getInstructions()).toContain(
      "API and technical documentation retrieval",
    );
  });
});

describe("resolveServerInstructions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-mcp-instructions-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails when both inline instructions and an instructions file are set", () => {
    const instructionsFile = path.join(tmpDir, "instructions.md");
    fs.writeFileSync(instructionsFile, "from file");
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", instructions: "inline", instructionsFile },
    } as unknown as AppConfig;

    expect(() => resolveServerInstructions(config)).toThrow(
      /server\.instructions.*server\.instructionsFile/,
    );
  });

  it("reads the instructions from the configured file", () => {
    const instructionsFile = path.join(tmpDir, "instructions.md");
    fs.writeFileSync(instructionsFile, "custom instructions");
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", instructionsFile },
    } as unknown as AppConfig;

    expect(resolveServerInstructions(config)).toBe("custom instructions");
  });
});
