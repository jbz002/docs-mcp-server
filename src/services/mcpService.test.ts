/**
 * Tests for MCP service functionality including SSE heartbeat.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { type AppConfig, loadConfig } from "../utils/config";
import { cleanupMcpService, registerMcpService } from "./mcpService";

// Mock the dependencies
vi.mock("../mcp/tools", () => ({
  initializeTools: vi.fn().mockResolvedValue({
    listLibraries: { execute: vi.fn() },
    findVersion: { execute: vi.fn() },
    search: { execute: vi.fn() },
    fetchUrl: { execute: vi.fn() },
  }),
}));

vi.mock("../mcp/mcpServer", () => ({
  createMcpServerInstance: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../telemetry", () => ({
  telemetry: {
    isEnabled: () => false,
  },
}));

describe("MCP Service", () => {
  let server: ReturnType<typeof Fastify>;
  let mockDocService: IDocumentManagement;
  let appConfig: AppConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    server = Fastify({ logger: false });

    mockDocService = {} as IDocumentManagement;
    appConfig = loadConfig();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
    vi.clearAllMocks();
  });

  describe("SSE Heartbeat", () => {
    it("should cleanup heartbeat intervals on service cleanup", async () => {
      const mcpServer = await registerMcpService(server, mockDocService, appConfig);

      const mcpServerWithInternals = mcpServer as unknown as {
        _heartbeatIntervals: Record<string, NodeJS.Timeout>;
      };
      expect(mcpServerWithInternals._heartbeatIntervals).toBeDefined();

      await expect(cleanupMcpService(mcpServer)).resolves.not.toThrow();
    });

    it("should store transport references for cleanup", async () => {
      const mcpServer = await registerMcpService(server, mockDocService, appConfig);

      const mcpServerWithInternals = mcpServer as unknown as {
        _sseTransports: Record<string, unknown>;
        _heartbeatIntervals: Record<string, NodeJS.Timeout>;
      };
      expect(mcpServerWithInternals._sseTransports).toBeDefined();
      expect(mcpServerWithInternals._heartbeatIntervals).toBeDefined();

      await cleanupMcpService(mcpServer);
    });
  });

  describe("Route Registration", () => {
    it("should register /sse endpoint", async () => {
      const mcpServer = await registerMcpService(server, mockDocService, appConfig);

      const routes = server.printRoutes();
      expect(routes).toContain("sse");

      await cleanupMcpService(mcpServer);
    });

    it("should register /messages endpoint", async () => {
      const mcpServer = await registerMcpService(server, mockDocService, appConfig);

      const routes = server.printRoutes();
      expect(routes).toContain("essages");

      await cleanupMcpService(mcpServer);
    });

    it("should register /mcp endpoint", async () => {
      const mcpServer = await registerMcpService(server, mockDocService, appConfig);

      const routes = server.printRoutes();
      expect(routes).toContain("cp (POST)");

      await cleanupMcpService(mcpServer);
    });
  });
});
