import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBusService } from "../events/EventBusService";
import { EventType } from "../events/types";
import { PipelineClient } from "./PipelineClient";
import { PipelineJobStatus } from "./types";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("PipelineClient", () => {
  let client: PipelineClient;
  let eventBus: EventBusService;
  const serverUrl = "http://localhost:8080";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: health check returns ok
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });
    eventBus = new EventBusService();
    client = new PipelineClient(serverUrl, eventBus);
  });

  describe("start", () => {
    it("should succeed when external worker is healthy", async () => {
      await expect(client.start()).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: `${serverUrl}/api/health` }),
      );
    });

    it("should fail when external worker is unreachable", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      });
      await expect(client.start()).rejects.toThrow(
        "Failed to connect to external worker",
      );
    });

    it("should fail on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
      await expect(client.start()).rejects.toThrow(
        "Failed to connect to external worker",
      );
    });
  });

  describe("enqueueScrapeJob", () => {
    it("should delegate job creation to external API", async () => {
      const mockJobId = "job-123";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jobId: mockJobId }),
      });

      const jobId = await client.enqueueScrapeJob("react", "18.0.0", {
        url: "https://react.dev",
        library: "react",
        version: "18.0.0",
      });

      expect(jobId).toBe(mockJobId);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${serverUrl}/api/jobs/scrape`,
          method: "POST",
        }),
      );
    });

    it("should handle API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad request",
      });

      await expect(client.enqueueScrapeJob("invalid", null, {} as any)).rejects.toThrow(
        "Failed to enqueue job: HTTP 400",
      );
    });
  });

  describe("enqueueRefreshJob", () => {
    it("should delegate refresh job to external API", async () => {
      const mockJobId = "job-456";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jobId: mockJobId }),
      });

      const jobId = await client.enqueueRefreshJob("react", "18.0.0");

      expect(jobId).toBe(mockJobId);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${serverUrl}/api/jobs/refresh`,
          method: "POST",
        }),
      );
    });
  });

  describe("getJob", () => {
    it("should return undefined for non-existent job (404)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await client.getJob("non-existent");
      expect(result).toBeUndefined();
    });

    it("should return job data for existing job", async () => {
      const mockJob = {
        id: "job-123",
        status: "completed",
        createdAt: "2023-01-01T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockJob,
      });

      const result = await client.getJob("job-123");
      expect(result).toEqual(mockJob);
    });
  });

  describe("getJobs", () => {
    it("should return jobs list from external API", async () => {
      const mockJobs = [{ id: "job-1", status: "completed" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jobs: mockJobs }),
      });

      const result = await client.getJobs();
      expect(result).toEqual(mockJobs);
    });

    it("should pass status filter as query param", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jobs: [] }),
      });

      await client.getJobs(PipelineJobStatus.RUNNING);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("status=running") }),
      );
    });
  });

  describe("cancelJob", () => {
    it("should cancel job via external API", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await client.cancelJob("job-123");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${serverUrl}/api/jobs/job-123/cancel`,
          method: "POST",
        }),
      );
    });

    it("should throw on failed cancellation", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(client.cancelJob("job-123")).rejects.toThrow();
    });
  });

  describe("clearCompletedJobs", () => {
    it("should clear completed jobs via external API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 5 }),
      });

      const count = await client.clearCompletedJobs();
      expect(count).toBe(5);
    });
  });

  describe("waitForJobCompletion", () => {
    it("should resolve when job completes successfully via event bus", async () => {
      const jobId = "job-123";

      // Start waiting
      const waitPromise = client.waitForJobCompletion(jobId);

      // Simulate event bus emitting status change
      setTimeout(() => {
        eventBus.emit(EventType.JOB_STATUS_CHANGE, {
          id: jobId,
          status: "completed",
          library: "test",
          version: null,
        } as any);
      }, 10);

      await expect(waitPromise).resolves.toBeUndefined();
    });

    it("should throw error when job fails via event bus", async () => {
      const jobId = "job-123";

      // Start waiting
      const waitPromise = client.waitForJobCompletion(jobId);

      // Simulate event bus emitting failure
      setTimeout(() => {
        eventBus.emit(EventType.JOB_STATUS_CHANGE, {
          id: jobId,
          status: "failed",
          library: "test",
          version: null,
          error: { message: "Scraping failed" },
        } as any);
      }, 10);

      await expect(waitPromise).rejects.toThrow("Scraping failed");
    });

    it("should ignore events for other jobs", async () => {
      const jobId = "job-123";

      // Start waiting
      const waitPromise = client.waitForJobCompletion(jobId);

      // Emit events for different job (should be ignored)
      setTimeout(() => {
        eventBus.emit(EventType.JOB_STATUS_CHANGE, {
          id: "other-job",
          status: "completed",
          library: "test",
          version: null,
        } as any);
      }, 10);

      // Emit event for our job
      setTimeout(() => {
        eventBus.emit(EventType.JOB_STATUS_CHANGE, {
          id: jobId,
          status: "completed",
          library: "test",
          version: null,
        } as any);
      }, 20);

      await expect(waitPromise).resolves.toBeUndefined();
    });
  });
});
