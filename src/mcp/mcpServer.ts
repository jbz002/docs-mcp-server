import fs from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { libraryNamesMatch } from "../store/types";
import { TelemetryEvent, telemetry } from "../telemetry";
import type { AppConfig } from "../utils/config";
import type { McpServerTools } from "./tools";
import { createError, createResponse } from "./utils";

/**
 * Built-in instructions advertised to MCP clients when none are configured.
 * They position this server against internal-company KB search tools so models
 * route "library API docs" questions here and internal-document questions
 * elsewhere. Unlike upstream, this fork only registers search/retrieval tools,
 * so the text never mentions indexing tools.
 */
const DEFAULT_INSTRUCTIONS =
  "API and technical documentation retrieval: how to call APIs, endpoints, parameters, SDK " +
  "usage, code examples, and version resolution — covers open-source libraries/frameworks " +
  "and internal company systems alike. Use this server for developer-facing technical " +
  "questions. Non-technical company knowledge (policies, processes, manuals, project " +
  "material) belongs to the internal KB search tools instead.";

/**
 * Resolves the instructions text advertised to MCP clients during initialization.
 * `server.instructions` and `server.instructionsFile` are mutually exclusive. When
 * neither is set, the built-in instructions of this fork are used.
 * @param config The application configuration.
 * @returns The configured instructions text, or the built-in instructions.
 * @throws {Error} If both settings are set, or the configured instructions file cannot be read.
 */
export function resolveServerInstructions(config: AppConfig): string {
  const { instructions, instructionsFile: filePath } = config.server;
  if (instructions !== undefined && filePath !== undefined) {
    throw new Error(
      "Both server.instructions and server.instructionsFile are set; configure only one of them.",
    );
  }
  if (instructions !== undefined) {
    return instructions;
  }
  if (filePath !== undefined) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read MCP server instructions file "${filePath}": ${reason}`,
      );
    }
  }
  return DEFAULT_INSTRUCTIONS;
}

/**
 * Decodes a URI template variable once. The SDK hands variables over still
 * percent-encoded; a malformed escape is kept verbatim rather than failing.
 */
function decodeUriVariable(value: string | string[]): string {
  const raw = Array.isArray(value) ? value.join("/") : value;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Creates a factory for MCP server instances. The instructions are resolved once
 * so every connection created from the factory advertises the same text.
 * @param tools The shared tool instances to use for server operations.
 * @param config The application configuration.
 * @returns A factory that builds configured McpServer instances.
 */
export function createMcpServerFactory(
  tools: McpServerTools,
  config: AppConfig,
): () => McpServer {
  const instructions = resolveServerInstructions(config);
  return () => createMcpServerInstance(tools, config, instructions);
}

/**
 * Creates and configures an instance of the MCP server with registered tools and resources.
 * Only search/retrieval tools are included; crawler and job management operations
 * are exposed via the REST API at /api instead.
 * @param tools The shared tool instances to use for server operations.
 * @param config The application configuration.
 * @param instructions Instructions text sent to clients during initialization, as
 *   returned by `resolveServerInstructions()`.
 * @returns A configured McpServer instance.
 */
export function createMcpServerInstance(
  tools: McpServerTools,
  config: AppConfig,
  instructions: string = DEFAULT_INSTRUCTIONS,
): McpServer {
  const { name, title } = config.server;
  const server = new McpServer(
    {
      name,
      ...(title !== undefined ? { title } : {}),
      version: __APP_VERSION__,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions,
    },
  );

  // --- Tool Definitions (search/retrieval only) ---

  // Search docs tool
  server.registerTool(
    "search_docs",
    {
      description:
        "Search up-to-date API and technical documentation for a library, framework, package, or " +
        "internal company system (endpoints, parameters, SDK usage, code examples). Examples:\n\n" +
        '- {library: "react", query: "hooks lifecycle"} -> matches latest version of React\n' +
        '- {library: "react", version: "18.0.0", query: "hooks lifecycle"} -> matches React 18.0.0 or earlier\n' +
        '- {library: "typescript", version: "5.x", query: "ReturnType example"} -> any TypeScript 5.x.x version\n' +
        '- {library: "typescript", version: "5.2.x", query: "ReturnType example"} -> any TypeScript 5.2.x version',
      inputSchema: {
        library: z.string().trim().describe("Library name."),
        version: z
          .string()
          .trim()
          .optional()
          .describe("Library version (exact or X-Range, optional)."),
        query: z.string().trim().describe("Documentation search query."),
        limit: z.number().optional().default(5).describe("Maximum number of results."),
      },
      annotations: {
        title: "Search Library Documentation",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ library, version, query, limit }) => {
      // Track MCP tool usage
      telemetry.track(TelemetryEvent.TOOL_USED, {
        tool: "search_docs",
        context: "mcp_server",
        library,
        version,
        queryLength: query.length, // Never the query itself
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
  server.registerTool(
    "list_libraries",
    {
      description:
        "List all indexed documentation sources (libraries, frameworks, packages, internal systems).",
      inputSchema: {},
      annotations: {
        title: "List Libraries",
        readOnlyHint: true,
        destructiveHint: false,
      },
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
  server.registerTool(
    "find_version",
    {
      description:
        "Find the best matching version for a documented library or system. Use to identify available or closest versions.",
      inputSchema: {
        library: z.string().trim().describe("Library name."),
        targetVersion: z
          .string()
          .trim()
          .optional()
          .describe("Version pattern to match (exact or X-Range, optional)."),
      },
      annotations: {
        title: "Find Library Version",
        readOnlyHint: true,
        destructiveHint: false,
      },
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

  // --- Resource Definitions ---

  server.registerResource(
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

  server.registerResource(
    "versions",
    new ResourceTemplate("docs://libraries/{library}/versions", {
      list: undefined,
    }),
    {
      description: "List all indexed versions for a library",
    },
    async (uri: URL, { library }) => {
      const result = await tools.listLibraries.execute();

      // The template variable arrives percent-encoded (a name containing "/" must
      // be sent as %2F), and names match case-insensitively.
      const requested = decodeUriVariable(library);
      const lib = result.libraries.find((l: { name: string }) =>
        libraryNamesMatch(l.name, requested),
      );
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
