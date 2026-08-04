import type { ScraperService } from "../scraper";
import type {
  ScrapeResult,
  ScraperProgressEvent as ScraperProgress,
  ScraperProgressEvent,
} from "../scraper/types";
import type { DocumentManagementService } from "../store";
import { logger } from "../utils/logger";
import { CancellationError } from "./errors";
import type { InternalPipelineJob } from "./types";

/**
 * Internal callbacks used by PipelineWorker.
 * These work with InternalPipelineJob before conversion to public interface.
 */
interface WorkerCallbacks {
  onJobProgress?: (job: InternalPipelineJob, progress: ScraperProgress) => Promise<void>;
  onPageScraped?: (job: InternalPipelineJob, result: ScrapeResult) => Promise<void>;
  onJobError?: (
    job: InternalPipelineJob,
    error: Error,
    page?: ScrapeResult,
  ) => Promise<void>;
  onJobStatusChange?: (job: InternalPipelineJob) => Promise<void>;
}

/**
 * Executes a single document processing job.
 * Handles scraping, storing documents, and reporting progress/errors via callbacks.
 */
export class PipelineWorker {
  // Dependencies are passed in, making the worker stateless regarding specific jobs
  private readonly store: DocumentManagementService;
  private readonly scraperService: ScraperService;

  // Constructor accepts dependencies needed for execution
  constructor(store: DocumentManagementService, scraperService: ScraperService) {
    this.store = store;
    this.scraperService = scraperService;
  }

  /**
   * Executes the given pipeline job.
   * @param job - The job to execute.
   * @param callbacks - Internal callbacks provided by the manager for reporting.
   */
  async executeJob(job: InternalPipelineJob, callbacks: WorkerCallbacks): Promise<void> {
    const { id: jobId, library, version, scraperOptions, abortController } = job;
    const signal = abortController.signal;

    logger.debug(`[${jobId}] Worker starting job for ${library}@${version}`);

    try {
      // Clear existing documents for this library/version before scraping
      // Skip this step for refresh operations or if clean is explicitly false
      if (
        !scraperOptions.isRefresh &&
        scraperOptions.clean !== false &&
        !scraperOptions.crawlOnly
      ) {
        await this.store.removeAllDocuments(library, version);
        logger.info(
          `💾 Cleared store for ${library}@${version || "latest"} before scraping.`,
        );
      } else {
        // crawlOnly: clear the raw result cache so a fresh scrape does not
        // retain stale pages from a prior run (mirrors normal-mode removeAllDocuments).
        // Resume after restart keeps the cache so already-crawled URLs upsert idempotently
        // (UNIQUE(version_id,url)) and any AIHelms backfill salvage stays consistent.
        if (scraperOptions.crawlOnly && !job.isResume) {
          await this.store.clearCrawlResults(library, version);
          logger.info(
            `💾 Cleared crawl_results cache for ${library}@${version || "latest"} before scraping.`,
          );
        }
        const message = scraperOptions.isRefresh
          ? `🔄 Refresh operation - preserving existing data for ${library}@${version || "latest"}.`
          : job.isResume
            ? `▶️ Resume re-scrape for ${library}@${version || "latest"} (crawl_results cache preserved).`
            : `💾 Appending to store for ${library}@${version || "latest"} (clean=false).`;
        logger.info(message);
      }

      // Resume (crawlOnly): seed visited with already-crawled URLs and inject
      // the uncrawled frontier reconstructed from their stored links, so resume
      // skips finished pages and continues crawling the remaining ones.
      if (scraperOptions.crawlOnly && job.isResume) {
        try {
          const rows = await this.store.listCrawlResultsForResume(library, version);
          if (rows.length > 0) {
            const crawled = new Set<string>(rows.map((r) => r.url));
            scraperOptions.resumeFromUrls = Array.from(crawled);

            // frontier = union(links) - crawled; depth = min(linker depth)+1
            const frontierDepth = new Map<string, number>();
            for (const r of rows) {
              if (!r.links) continue;
              let outgoing: string[] = [];
              try {
                const parsed = JSON.parse(r.links);
                if (Array.isArray(parsed)) {
                  outgoing = parsed.filter((x): x is string => typeof x === "string");
                }
              } catch {
                /* malformed links JSON, skip */
              }
              const linkerDepth = r.depth ?? 0;
              for (const linkUrl of outgoing) {
                if (crawled.has(linkUrl)) continue;
                const childDepth = linkerDepth + 1;
                const prev = frontierDepth.get(linkUrl);
                if (prev === undefined || childDepth < prev) {
                  frontierDepth.set(linkUrl, childDepth);
                }
              }
            }
            scraperOptions.resumeFromQueue = Array.from(frontierDepth.entries()).map(
              ([u, depth]) => ({ url: u, depth }),
            );
            logger.info(
              `[${jobId}] Resume: ${crawled.size} crawled urls, ${frontierDepth.size} frontier urls reconstructed`,
            );
          }
        } catch (err) {
          logger.warn(`[${jobId}] Resume seed failed (non-fatal): ${err}`);
        }
      }

      // --- Core Job Logic ---
      await this.scraperService.scrape(
        scraperOptions,
        async (progress: ScraperProgressEvent) => {
          // Check for cancellation signal before processing each document
          if (signal.aborted) {
            throw new CancellationError("Job cancelled during scraping progress");
          }

          // Update job object directly (manager holds the reference)
          // Report progress via manager's callback (single source of truth)
          await callbacks.onJobProgress?.(job, progress);

          // Handle deletion events (404 during refresh or broken links)
          if (progress.deleted && progress.pageId) {
            try {
              await this.store.deletePage(progress.pageId);
              logger.debug(
                `[${jobId}] Deleted page ${progress.pageId}: ${progress.currentUrl}`,
              );
            } catch (docError) {
              logger.error(
                `❌ [${jobId}] Failed to delete page ${progress.pageId}: ${docError}`,
              );

              // Report the error and fail the job to ensure data integrity
              const error =
                docError instanceof Error ? docError : new Error(String(docError));
              await callbacks.onJobError?.(job, error);
              // Re-throw to fail the job - deletion failures indicate serious database issues
              // and leaving orphaned documents would compromise index accuracy
              throw error;
            }
          }
          // Handle successful content processing
          else if (progress.result) {
            if (job.scraperOptions.crawlOnly) {
              // Persist raw result so AIHelms can backfill pages lost during
              // an SSE gap (SSE remains the live-progress channel; this is the
              // authoritative content cache keyed by version_id+url).
              await this.store.upsertCrawlResult(
                library,
                version,
                jobId,
                progress.depth ?? null,
                progress.result,
              );
              await callbacks.onPageScraped?.(job, progress.result);
            } else {
              try {
                // For refresh operations, delete old documents before adding new ones
                if (progress.pageId) {
                  await this.store.deletePage(progress.pageId);
                  logger.debug(
                    `[${jobId}] Refreshing page ${progress.pageId}: ${progress.currentUrl}`,
                  );
                }

                // Add the processed content to the store
                await this.store.addScrapeResult(
                  library,
                  version,
                  progress.depth,
                  progress.result,
                );
                logger.debug(
                  `[${jobId}] Stored processed content: ${progress.currentUrl}`,
                );
              } catch (docError) {
                logger.error(
                  `❌ [${jobId}] Failed to process content ${progress.currentUrl}: ${docError}`,
                );
                // Report document-specific errors via manager's callback
                await callbacks.onJobError?.(
                  job,
                  docError instanceof Error ? docError : new Error(String(docError)),
                  progress.result,
                );
              }
            }
          }
        },
        signal, // Pass signal to scraper service
        job.pauseController, // Pass cooperative pause gate
      );
      // --- End Core Job Logic ---

      // Check signal one last time after scrape finishes
      if (signal.aborted) {
        throw new CancellationError("Job cancelled");
      }

      // If successful and not cancelled, the manager will handle status update
      logger.debug(`[${jobId}] Worker finished job successfully.`);
    } catch (error) {
      // Re-throw error to be caught by the manager in _runJob
      logger.warn(`⚠️  [${jobId}] Worker encountered error: ${error}`);
      throw error;
    }
    // Note: The manager (_runJob) is responsible for updating final job status (COMPLETED/FAILED/CANCELLED)
    // and resolving/rejecting the completion promise based on the outcome here.
  }

  // --- Old methods removed ---
  // process()
  // stop()
  // setCallbacks()
  // handleScrapingProgress()
}
