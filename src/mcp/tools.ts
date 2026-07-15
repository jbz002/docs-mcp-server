/**
 * Helper utilities for constructing MCP tools with shared dependencies. Tools
 * are created with the resolved configuration supplied by the entrypoint to
 * avoid internal config loading.
 */
import { AutoDetectFetcher } from "../scraper/fetcher";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { FetchUrlTool, FindVersionTool, ListLibrariesTool, SearchTool } from "../tools";
import type { AppConfig } from "../utils/config";

/**
 * Interface for the shared tool instances.
 */
export interface McpServerTools {
  listLibraries: ListLibrariesTool;
  findVersion: FindVersionTool;
  search: SearchTool;
  fetchUrl: FetchUrlTool;
}

/**
 * Initializes and returns the shared tool instances.
 * This should be called after initializeServices has completed.
 * @param docService The initialized DocumentManagementService instance.
 * @param config The resolved configuration provided by the entrypoint.
 * @returns An object containing all instantiated tool instances.
 */
export async function initializeTools(
  docService: IDocumentManagement,
  config: AppConfig,
): Promise<McpServerTools> {
  const tools: McpServerTools = {
    listLibraries: new ListLibrariesTool(docService),
    findVersion: new FindVersionTool(docService),
    search: new SearchTool(docService),
    fetchUrl: new FetchUrlTool(new AutoDetectFetcher(config.scraper), config),
  };

  return tools;
}
