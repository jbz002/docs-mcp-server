/**
 * Interface for document management operations exposed externally.
 * Implemented by the local DocumentManagementService and the remote tRPC client.
 */
import type { ScrapeResult, ScraperOptions } from "../../scraper/types";
import type { EmbeddingModelConfig } from "../embeddings/EmbeddingConfig";
import type {
  DbVersionWithLibrary,
  FindVersionResult,
  LibrarySummary,
  StoredScraperOptions,
  StoreSearchResult,
  VersionStatus,
} from "../types";

export interface CrawlResultItem {
  url: string;
  title: string | null;
  textContent: string | null;
  contentType: string | null;
  depth: number | null;
}

export interface CrawlResultsPage {
  items: CrawlResultItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface IDocumentManagement {
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Library/version introspection used by tools/UI
  listLibraries(): Promise<LibrarySummary[]>;
  validateLibraryExists(library: string): Promise<void>;
  findBestVersion(library: string, targetVersion?: string): Promise<FindVersionResult>;
  ensureLibraryAndVersion(library: string, version: string): Promise<number>;

  // Search & mutation used by tools/UI
  searchStore(
    library: string,
    version: string | null | undefined,
    query: string,
    limit?: number,
  ): Promise<StoreSearchResult[]>;
  removeAllDocuments(library: string, version?: string | null): Promise<void>;
  removeVersion(library: string, version?: string | null): Promise<void>;
  deletePageByUrl(
    library: string,
    version: string | null | undefined,
    url: string,
  ): Promise<boolean>;

  // crawlOnly raw result cache (二开新增) — AIHelms reads this to backfill
  // pages lost during an SSE gap before re-ingest. Server-side persistence is
  // written by the pipeline worker; this is the read path.
  getCrawlResults(
    library: string,
    version: string | null | undefined,
    page: number,
    pageSize: number,
  ): Promise<CrawlResultsPage>;

  // Clear crawlOnly raw result cache for a version (二开新增). AIHelms clears
  // dangling cache after a task is declared failed (job lost, no salvage data).
  clearCrawlResults(library: string, version: string | null | undefined): Promise<void>;

  // Minimal set used indirectly by pipeline/UI where needed
  getVersionsByStatus(statuses: VersionStatus[]): Promise<DbVersionWithLibrary[]>;
  findVersionsBySourceUrl(url: string): Promise<DbVersionWithLibrary[]>;
  getScraperOptions(versionId: number): Promise<StoredScraperOptions | null>;
  updateVersionStatus(
    versionId: number,
    status: VersionStatus,
    errorMessage?: string,
  ): Promise<void>;
  updateVersionProgress(
    versionId: number,
    pages: number,
    maxPages: number,
  ): Promise<void>;
  storeScraperOptions(versionId: number, options: ScraperOptions): Promise<void>;

  // Document ingestion (used by REST API for external content)
  addScrapeResult(
    library: string,
    version: string | null | undefined,
    depth: number,
    result: ScrapeResult,
  ): Promise<void>;
  ingestDocuments(
    library: string,
    version: string | null | undefined,
    results: ScrapeResult[],
  ): Promise<void>;

  // Embedding configuration
  getActiveEmbeddingConfig(): EmbeddingModelConfig | null;
}
