/**
 * HTTP client implementation of the Pipeline interface.
 * Delegates all pipeline operations to an external worker via REST API.
 */

import { restoreJobDates } from "../events/dateUtils";
import type { EventBusService } from "../events/EventBusService";
import { EventType } from "../events/types";
import type { ScraperOptions } from "../scraper/types";
import { logger } from "../utils/logger";
import type { IPipeline } from "./trpc/interfaces";
import type { PipelineJob, PipelineJobStatus, PipelineManagerCallbacks } from "./types";

/**
 * HTTP client that implements the IPipeline interface by delegating to external worker.
 */
export class PipelineClient implements IPipeline {
  private readonly baseUrl: string;
  private readonly eventBus: EventBusService;

  constructor(serverUrl: string, eventBus: EventBusService) {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    this.eventBus = eventBus;

    logger.debug(`PipelineClient (REST) created for: ${this.baseUrl}`);
  }

  async start(): Promise<void> {
    // Check connectivity via health endpoint
    try {
      const response = await fetch(`${this.baseUrl}/api/health`);
      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
      logger.debug("PipelineClient connected to external worker via REST");
    } catch (error) {
      throw new Error(
        `Failed to connect to external worker at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    logger.debug("PipelineClient stopped");
  }

  async enqueueScrapeJob(
    library: string,
    version: string | undefined | null,
    options: ScraperOptions,
  ): Promise<string> {
    try {
      const normalizedVersion =
        typeof version === "string" && version.trim().length === 0
          ? null
          : (version ?? null);
      const response = await fetch(`${this.baseUrl}/api/jobs/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          library,
          version: normalizedVersion,
          options,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const result = (await response.json()) as { jobId: string };
      logger.debug(`Job ${result.jobId} enqueued successfully`);
      return result.jobId;
    } catch (error) {
      throw new Error(
        `Failed to enqueue job: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async enqueueRefreshJob(
    library: string,
    version: string | undefined | null,
    options?: { preserveHashes?: boolean },
  ): Promise<string> {
    try {
      const normalizedVersion =
        typeof version === "string" && version.trim().length === 0
          ? null
          : (version ?? null);
      const response = await fetch(`${this.baseUrl}/api/jobs/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          library,
          version: normalizedVersion,
          options,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const result = (await response.json()) as { jobId: string };
      logger.debug(`Refresh job ${result.jobId} enqueued successfully`);
      return result.jobId;
    } catch (error) {
      throw new Error(
        `Failed to enqueue refresh job: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getJob(jobId: string): Promise<PipelineJob | undefined> {
    try {
      const response = await fetch(`${this.baseUrl}/api/jobs/${jobId}`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return restoreJobDates((await response.json()) as PipelineJob);
    } catch (error) {
      throw new Error(
        `Failed to get job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getJobs(status?: PipelineJobStatus): Promise<PipelineJob[]> {
    try {
      const url = new URL(`${this.baseUrl}/api/jobs`);
      if (status) {
        url.searchParams.set("status", status);
      }
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const result = (await response.json()) as { jobs: PipelineJob[] };
      return restoreJobDates(result.jobs || []);
    } catch (error) {
      logger.error(`❌ Failed to get jobs from external worker: ${error}`);
      throw error;
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      logger.debug(`Job cancelled via external worker: ${jobId}`);
    } catch (error) {
      logger.error(`❌ Failed to cancel job ${jobId} via external worker: ${error}`);
      throw error;
    }
  }

  async clearCompletedJobs(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/jobs/clear-completed`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const result = (await response.json()) as { count: number };
      logger.debug(`Cleared ${result.count} completed jobs via external worker`);
      return result.count || 0;
    } catch (error) {
      logger.error(`❌ Failed to clear completed jobs via external worker: ${error}`);
      throw error;
    }
  }

  async waitForJobCompletion(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Listen for job status changes on the event bus
      // RemoteEventProxy bridges remote worker events to this local bus
      const unsubscribe = this.eventBus.on(
        EventType.JOB_STATUS_CHANGE,
        (job: PipelineJob) => {
          // Filter for the specific job we're waiting for
          if (job.id !== jobId) {
            return;
          }

          // Check if job reached a terminal state
          if (
            job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled"
          ) {
            unsubscribe();

            if (job.status === "failed" && job.error) {
              reject(new Error(job.error.message));
            } else {
              resolve();
            }
          }
        },
      );
    });
  }

  setCallbacks(_callbacks: PipelineManagerCallbacks): void {
    // For external pipeline, callbacks are not used since all updates come via event bus
    logger.debug("PipelineClient.setCallbacks called - no-op for external worker");
  }
}
