/**
 * HTTP client for the document management REST API.
 * Implements IDocumentManagement and delegates to /api endpoints.
 */

import type { ScrapeResult, ScraperOptions } from "../scraper/types";
import { logger } from "../utils/logger";
import type { EmbeddingModelConfig } from "./embeddings/EmbeddingConfig";
import type { CrawlResultsPage, IDocumentManagement } from "./trpc/interfaces";
import type {
  DbVersionWithLibrary,
  FindVersionResult,
  LibrarySummary,
  StoredScraperOptions,
  StoreSearchResult,
  VersionStatus,
} from "./types";

export class DocumentManagementClient implements IDocumentManagement {
  private readonly baseUrl: string;

  constructor(serverUrl: string) {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    logger.debug(`DocumentManagementClient (REST) created for: ${this.baseUrl}`);
  }

  async initialize(): Promise<void> {
    // Connectivity check using health endpoint
    try {
      const response = await fetch(`${this.baseUrl}/api/health`);
      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
    } catch (error) {
      logger.debug(
        `Failed to connect to DocumentManagement server at ${this.baseUrl}: ${error}`,
      );
      throw new Error(
        `Failed to connect to server at ${this.baseUrl}.\n\nPlease verify the server URL includes the correct port (default 8080) and ends with '/api' (e.g., 'http://localhost:8080/api').`,
      );
    }
  }

  async shutdown(): Promise<void> {
    // no-op for HTTP client
  }

  async listLibraries(): Promise<LibrarySummary[]> {
    return await this.get<LibrarySummary[]>("/api/libraries");
  }

  async validateLibraryExists(library: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/libraries/${encodeURIComponent(library)}/exists`,
    );
    if (response.status === 404) {
      throw new Error(`Library "${library}" not found`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  async findBestVersion(
    library: string,
    targetVersion?: string,
  ): Promise<FindVersionResult> {
    const path = `/api/libraries/${encodeURIComponent(library)}/versions/best`;
    const query = targetVersion
      ? `?targetVersion=${encodeURIComponent(targetVersion)}`
      : "";
    return await this.get<FindVersionResult>(path + query);
  }

  async searchStore(
    library: string,
    version: string | null | undefined,
    query: string,
    limit?: number,
  ): Promise<StoreSearchResult[]> {
    const params = new URLSearchParams({ library, query });
    if (version) params.set("version", version);
    if (limit) params.set("limit", String(limit));
    return await this.get<StoreSearchResult[]>(`/api/search?${params}`);
  }

  async removeVersion(library: string, version?: string | null): Promise<void> {
    await this.delete(
      `/api/libraries/${encodeURIComponent(library)}/versions/${encodeURIComponent(version ?? "latest")}`,
    );
  }

  async removeAllDocuments(library: string, version?: string | null): Promise<void> {
    await this.delete(
      `/api/libraries/${encodeURIComponent(library)}/versions/${encodeURIComponent(version ?? "latest")}/documents`,
    );
  }

  async getCrawlResults(
    library: string,
    version: string | null | undefined,
    page: number,
    pageSize: number,
  ): Promise<CrawlResultsPage> {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    return await this.get<CrawlResultsPage>(
      `/api/libraries/${encodeURIComponent(library)}/versions/${encodeURIComponent(version ?? "latest")}/crawl-results?${params}`,
    );
  }

  async getVersionsByStatus(statuses: VersionStatus[]): Promise<DbVersionWithLibrary[]> {
    const query = statuses.length > 0 ? `?status=${statuses.join(",")}` : "";
    return await this.get<DbVersionWithLibrary[]>(`/api/versions${query}`);
  }

  async findVersionsBySourceUrl(url: string): Promise<DbVersionWithLibrary[]> {
    return await this.get<DbVersionWithLibrary[]>(
      `/api/versions/by-url?url=${encodeURIComponent(url)}`,
    );
  }

  async getScraperOptions(versionId: number): Promise<StoredScraperOptions | null> {
    return await this.get<StoredScraperOptions | null>(
      `/api/versions/${versionId}/options`,
    );
  }

  async updateVersionStatus(
    versionId: number,
    status: VersionStatus,
    errorMessage?: string,
  ): Promise<void> {
    await this.put(`/api/versions/${versionId}/status`, {
      status,
      errorMessage: errorMessage ?? null,
    });
  }

  async updateVersionProgress(
    versionId: number,
    pages: number,
    maxPages: number,
  ): Promise<void> {
    await this.put(`/api/versions/${versionId}/progress`, { pages, maxPages });
  }

  async storeScraperOptions(versionId: number, options: ScraperOptions): Promise<void> {
    await this.put(`/api/versions/${versionId}/options`, options);
  }

  getActiveEmbeddingConfig(): EmbeddingModelConfig | null {
    // For remote client, embedding config is not available locally.
    // The remote server's embedding status cannot be synchronously queried.
    // Return null to indicate embeddings status is unknown/unavailable.
    return null;
  }

  async addScrapeResult(
    library: string,
    version: string | null | undefined,
    depth: number,
    result: ScrapeResult,
  ): Promise<void> {
    await this.ingestDocuments(library, version, [result]);
  }

  async ingestDocuments(
    library: string,
    version: string | null | undefined,
    results: ScrapeResult[],
  ): Promise<void> {
    await this.post("/api/ingest", {
      library,
      version: version ?? null,
      documents: results,
    });
  }

  async ensureLibraryAndVersion(library: string, version: string): Promise<number> {
    const response = await fetch(`${this.baseUrl}/api/libraries/ensure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ library, version: version || null }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { versionId: number };
    return data.versionId;
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async put(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  }

  private async delete(path: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  }
}
