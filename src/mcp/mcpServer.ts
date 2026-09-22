import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { TelemetryEvent, telemetry } from "../telemetry";
import type { McpServerTools } from "./tools";
import { createError, createResponse } from "./utils";

/**
 * Creates and configures an instance of the MCP server with registered tools and resources.
 * Only search/retrieval tools are included; crawler and job management operations
 * are exposed via the REST API at /api instead.
 * @param tools The shared tool instances to use for server operations.
 * @returns A configured McpServer instance.
 */
export function createMcpServerInstance(tools: McpServerTools): McpServer {
  const server = new McpServer(
    {
      name: "docs-mcp-server",
      version: "0.1.0",
    },
    {
      // Server-level description surfaced to LLM clients via the MCP
      // initialize handshake. Positions this server against internal-company
      // KB search tools so models route "library API docs" questions here and
      // internal-document questions elsewhere.
      instructions:
        "API and technical documentation retrieval: how to call APIs, endpoints, parameters, SDK " +
        "usage, code examples, and version resolution — covers open-source libraries/frameworks " +
        "and internal company systems alike. Use this server for developer-facing technical " +
        "questions. Non-technical company knowledge (policies, processes, manuals, project " +
        "material) belongs to the internal KB search tools instead.",
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // --- Tool Definitions (search/retrieval only) ---

  // Search docs tool
  server.tool(
    "search_docs",
    "Search up-to-date API and technical documentation for a library, framework, package, or " +
      "internal company system (endpoints, parameters, SDK usage, code examples). Examples:\n\n" +
      '- {library: "react", query: "hooks lifecycle"} -> matches latest version of React\n' +
      '- {library: "react", version: "18.0.0", query: "hooks lifecycle"} -> matches React 18.0.0 or earlier\n' +
      '- {library: "typescript", version: "5.x", query: "ReturnType example"} -> any TypeScript 5.x.x version\n' +
      '- {library: "typescript", version: "5.2.x", query: "ReturnType example"} -> any TypeScript 5.2.x version',
    {
      library: z.string().trim().describe("Library name."),
      version: z
        .string()
        .trim()
        .optional()
        .describe("Library version (exact or X-Range, optional)."),
      query: z.string().trim().describe("Documentation search query."),
      limit: z.number().optional().default(5).describe("Maximum number of results."),
    },
    {
      title: "Search Library Documentation",
      readOnlyHint: true,
      destructiveHint: false,
    },
    async ({ library, version, query, limit }) => {
      // Track MCP tool usage
      telemetry.track(TelemetryEvent.TOOL_USED, {
        tool: "search_docs",
        context: "mcp_server",
        library,
        version,
        query: query.substring(0, 100), // Truncate query for privacy
        limit,
      });

      try {
        const result = await tools.search.execute({
          library,
          version,
          query,
          limit,
          exactMatch: false, // Always false for MCP interface
        });

        const formattedResults = result.results.map(
          (r: { url: string; content: string }, i: number) => `
------------------------------------------------------------
Result ${i + 1}: ${r.url}

${r.content}\n`,
        );

        if (formattedResults.length === 0) {
          return createResponse(
            `No results found for '${query}' in ${library}. Try to use a different or more general query.`,
          );
        }
        return createResponse(formattedResults.join(""));
      } catch (error) {
        return createError(error);
      }
    },
  );

  // List libraries tool
  server.tool(
    "list_libraries",
    "List all indexed documentation sources (libraries, frameworks, packages, internal systems).",
    {
      // no params
    },
    {
      title: "List Libraries",
      readOnlyHint: true,
      destructiveHint: false,
    },
    async () => {
      // Track MCP tool usage
      telemetry.track(TelemetryEvent.TOOL_USED, {
        tool: "list_libraries",
        context: "mcp_server",
      });

      try {
        const result = await tools.listLibraries.execute();
        if (result.libraries.length === 0) {
          return createResponse("No libraries indexed yet.");
        }

        return createResponse(
          `Indexed libraries:\n\n${result.libraries.map((lib: { name: string }) => `- ${lib.name}`).join("\n")}`,
        );
      } catch (error) {
        return createError(error);
      }
    },
  );

  // Find version tool
  server.tool(
    "find_version",
    "Find the best matching version for a documented library or system. Use to identify available or closest versions.",
    {
      library: z.string().trim().describe("Library name."),
      targetVersion: z
        .string()
        .trim()
        .optional()
        .describe("Version pattern to match (exact or X-Range, optional)."),
    },
    {
      title: "Find Library Version",
      readOnlyHint: true,
      destructiveHint: false,
    },
    async ({ library, targetVersion }) => {
      // Track MCP tool usage
      telemetry.track(TelemetryEvent.TOOL_USED, {
        tool: "find_version",
        context: "mcp_server",
        library,
        targetVersion,
      });

      try {
        const result = await tools.findVersion.execute({
          library,
          targetVersion,
        });

        // Tool now returns a structured object with message
        return createResponse(result.message);
      } catch (error) {
        return createError(error);
      }
    },
  );

  // Fetch URL tool
  // Disabled (2026-09-22): generic web-page fetching overlaps with other
  // tooling and is out of this server's API-docs-retrieval scope. Kept as a
  // comment for easy re-enable.
  /*
  server.tool(
    "fetch_url",
    "Fetch a single URL and convert its content to Markdown. Use this tool to read the content of any web page.",
    {
      url: z.string().url().describe("URL to fetch and convert to Markdown."),
      followRedirects: z
        .boolean()
        .optional()
        .default(true)
        .describe("Follow HTTP redirects (3xx responses)."),
    },
    {
      title: "Fetch URL",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true, // requires internet access
    },
    async ({ url, followRedirects }) => {
      // Track MCP tool usage
      telemetry.track(TelemetryEvent.TOOL_USED, {
        tool: "fetch_url",
        context: "mcp_server",
        url: new URL(url).hostname, // Privacy-safe URL tracking
        followRedirects,
      });

      try {
        const result = await tools.fetchUrl.execute({ url, followRedirects });
        return createResponse(result);
      } catch (error) {
        return createError(error);
      }
    },
  );
  */

  // --- Resource Definitions ---

  server.resource(
    "libraries",
    "docs://libraries",
    {
      description: "List all indexed libraries",
    },
    async (uri: URL) => {
      const result = await tools.listLibraries.execute();

      return {
        contents: result.libraries.map((lib: { name: string }) => ({
          uri: new URL(lib.name, uri).href,
          text: lib.name,
        })),
      };
    },
  );

  server.resource(
    "versions",
    new ResourceTemplate("docs://libraries/{library}/versions", {
      list: undefined,
    }),
    {
      description: "List all indexed versions for a library",
    },
    async (uri: URL, { library }) => {
      const result = await tools.listLibraries.execute();

      const lib = result.libraries.find((l: { name: string }) => l.name === library);
      if (!lib) {
        return { contents: [] };
      }

      return {
        contents: lib.versions.map((v: { version: string }) => ({
          uri: new URL(v.version, uri).href,
          text: v.version,
        })),
      };
    },
  );

  return server;
}
