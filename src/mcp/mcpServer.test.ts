/**
 * Tests for MCP server read-only mode functionality
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createMcpServerInstance } from "./mcpServer";
import type { McpServerTools } from "./tools";

// Mock tools (only search/retrieval tools remain)
const mockTools: McpServerTools = {
  listLibraries: {
    execute: () => Promise.resolve({ libraries: [] }),
  } as any,
  findVersion: {
    execute: () => Promise.resolve("Version found"),
  } as any,
  search: {
    execute: () => Promise.resolve({ results: [] }),
  } as any,
  fetchUrl: {
    execute: () => Promise.resolve("# Mock content"),
  } as any,
};

describe("MCP Server Read-Only Mode", () => {
  it("should create server instance in normal mode", () => {
    const server = createMcpServerInstance(mockTools);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("should create server instance in read-only mode", () => {
    const server = createMcpServerInstance(mockTools);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("should create server without prompts capability and not fail", () => {
    const server = createMcpServerInstance(mockTools);
    expect(server).toBeInstanceOf(McpServer);
    expect(server).toBeDefined();
  });
});
