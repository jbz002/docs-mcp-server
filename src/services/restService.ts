/**
 * REST API service registered at /api.
 * Replaces the legacy tRPC endpoint with standard HTTP routes,
 * making the API accessible from any language (Python, curl, etc.).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { EventBusService } from "../events";
import { registerSseListeners, startSseHeartbeat } from "../events/sseUtils";
import type { IPipeline } from "../pipeline/trpc/interfaces";
import { PipelineJobStatus } from "../pipeline/types";
import { AutoDetectFetcher } from "../scraper/fetcher";
import type { ScrapeResult, ScraperOptions } from "../scraper/types";
import { GreedySplitter } from "../splitter/GreedySplitter";
import { SemanticMarkdownSplitter } from "../splitter/SemanticMarkdownSplitter";
import type { Chunk } from "../splitter/types";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { FetchUrlTool } from "../tools/FetchUrlTool";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";

// ─── Reusable Zod schemas ────────────────────────────────────────────────

const nonEmptyTrimmed = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, "must not be empty");

const optionalTrimmed = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().min(1).optional().nullable(),
);

// ─── REST error helper ──────────────────────────────────────────────────

class RestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "RestError";
  }
}

/**
 * Standard error handler for REST route handlers.
 * Catches RestError (mapped to status code) and unexpected errors (500).
 */
async function handleRoute<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<void> {
  try {
    const result = await fn();
    reply.send(result);
  } catch (error) {
    if (error instanceof RestError) {
      reply.status(error.statusCode).send({ error: error.message });
    } else if (error instanceof z.ZodError) {
      reply.status(400).send({ error: "Validation failed", details: error.issues });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`❌ REST API error: ${message}`);
      reply.status(500).send({ error: "Internal server error" });
    }
  }
}

// ─── Public registration function ───────────────────────────────────────

/**
 * Register all REST API routes on the Fastify instance at /api prefix.
 */
export async function registerRestService(
  server: FastifyInstance,
  pipeline: IPipeline,
  docService: IDocumentManagement,
  eventBus: EventBusService,
  config: AppConfig,
): Promise<void> {
  const api = server;

  // ─── Health ─────────────────────────────────────────────────────────

  api.get("/api/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({ status: "ok", ts: Date.now() });
  });

  // ─── Jobs (Pipeline) ─────────────────────────────────────────────────

  api.post("/api/jobs/scrape", async (request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      const body = request.body as Record<string, unknown>;
      const parsed = z
        .object({
          library: nonEmptyTrimmed,
          version: optionalTrimmed,
          options: z.custom<ScraperOptions>(),
        })
        .parse(body);

      const jobId = await pipeline.enqueueScrapeJob(
        parsed.library,
        parsed.version ?? null,
        parsed.options,
      );
      return { jobId };
    });
  });

  api.post("/api/jobs/refresh", async (request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      const body = request.body as Record<string, unknown>;
      const parsed = z
        .object({
          library: nonEmptyTrimmed,
          version: optionalTrimmed,
          options: z.object({ preserveHashes: z.boolean().optional() }).optional(),
        })
        .parse(body);

      const jobId = await pipeline.enqueueRefreshJob(
        parsed.library,
        parsed.version ?? null,
        parsed.options,
      );
      return { jobId };
    });
  });

  api.get("/api/jobs", async (request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      const query = request.query as Record<string, string>;
      const status = query.status
        ? (PipelineJobStatus[
            query.status.toUpperCase() as keyof typeof PipelineJobStatus
          ] as PipelineJobStatus | undefined)
        : undefined;
      const jobs = await pipeline.getJobs(status);
      return { jobs };
    });
  });

  api.get(
    "/api/jobs/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await handleRoute(reply, async () => {
        const { id } = request.params;
        const job = await pipeline.getJob(id);
        if (!job) {
          throw new RestError(`Job ${id} not found`, 404);
        }
        return job;
      });
    },
  );

  api.post(
    "/api/jobs/:id/cancel",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await handleRoute(reply, async () => {
        const { id } = request.params;
        await pipeline.cancelJob(id);
        return { success: true };
      });
    },
  );

  api.post(
    "/api/jobs/clear-completed",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      await handleRoute(reply, async () => {
        const count = await pipeline.clearCompletedJobs();
        return { count };
      });
    },
  );

  // ─── Libraries (Store) ──────────────────────────────────────────────

  api.get("/api/libraries", async (_request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      return await docService.listLibraries();
    });
  });

  api.get(
    "/api/libraries/:library/versions/best",
    async (
      request: FastifyRequest<{
        Params: { library: string };
        Querystring: { targetVersion?: string };
      }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { library } = request.params;
        const { targetVersion } = request.query;
        return await docService.findBestVersion(library, targetVersion);
      });
    },
  );

  api.get(
    "/api/libraries/:library/exists",
    async (
      request: FastifyRequest<{ Params: { library: string } }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { library } = request.params;
        try {
          await docService.validateLibraryExists(library);
          return { ok: true };
        } catch {
          throw new RestError(`Library "${library}" not found`, 404);
        }
      });
    },
  );

  // ─── Search ────────────────────────────────────────────────────────

  api.get(
    "/api/search",
    async (
      request: FastifyRequest<{
        Querystring: {
          library?: string;
          version?: string;
          query?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { library, version, query, limit } = request.query;
        if (!library || !query) {
          throw new RestError("Missing required query parameters: library, query", 400);
        }
        const results = await docService.searchStore(
          library,
          version ?? null,
          query,
          limit ? Number.parseInt(limit, 10) : 5,
        );
        return results;
      });
    },
  );

  // ─── Versions (Store) ──────────────────────────────────────────────

  api.delete(
    "/api/libraries/:library/versions/:version",
    async (
      request: FastifyRequest<{ Params: { library: string; version: string } }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { library, version } = request.params;
        await docService.removeVersion(
          library,
          version === "latest" ? undefined : version,
        );
        return { ok: true };
      });
    },
  );

  api.delete(
    "/api/libraries/:library/versions/:version/documents",
    async (
      request: FastifyRequest<{ Params: { library: string; version: string } }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { library, version } = request.params;
        await docService.removeAllDocuments(
          library,
          version === "latest" ? undefined : version,
        );
        return { ok: true };
      });
    },
  );

  api.get(
    "/api/versions",
    async (
      request: FastifyRequest<{ Querystring: { status?: string } }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { status } = request.query;
        const statuses = status ? status.split(",") : [];
        return await docService.getVersionsByStatus(statuses as never);
      });
    },
  );

  api.get(
    "/api/versions/by-url",
    async (
      request: FastifyRequest<{ Querystring: { url?: string } }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { url } = request.query;
        if (!url) {
          throw new RestError("Missing required query parameter: url", 400);
        }
        return await docService.findVersionsBySourceUrl(url);
      });
    },
  );

  api.get(
    "/api/versions/:versionId/options",
    async (
      request: FastifyRequest<{ Params: { versionId: string } }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { versionId } = request.params;
        const id = Number.parseInt(versionId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          throw new RestError("versionId must be a positive integer", 400);
        }
        return await docService.getScraperOptions(id);
      });
    },
  );

  api.put(
    "/api/versions/:versionId/status",
    async (
      request: FastifyRequest<{
        Params: { versionId: string };
        Body: { status: string; errorMessage?: string | null };
      }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { versionId } = request.params;
        const body = request.body as { status: string; errorMessage?: string | null };
        const id = Number.parseInt(versionId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          throw new RestError("versionId must be a positive integer", 400);
        }
        const parsed = z
          .object({
            status: z.string().min(1),
            errorMessage: z.string().optional().nullable(),
          })
          .parse(body);

        await docService.updateVersionStatus(
          id,
          parsed.status as never,
          parsed.errorMessage ?? undefined,
        );
        return { ok: true };
      });
    },
  );

  api.put(
    "/api/versions/:versionId/progress",
    async (
      request: FastifyRequest<{
        Params: { versionId: string };
        Body: { pages: number; maxPages: number };
      }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { versionId } = request.params;
        const body = request.body as { pages: number; maxPages: number };
        const id = Number.parseInt(versionId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          throw new RestError("versionId must be a positive integer", 400);
        }
        const parsed = z
          .object({
            pages: z.number().int().nonnegative(),
            maxPages: z.number().int().positive(),
          })
          .parse(body);

        await docService.updateVersionProgress(id, parsed.pages, parsed.maxPages);
        return { ok: true };
      });
    },
  );

  api.put(
    "/api/versions/:versionId/options",
    async (
      request: FastifyRequest<{
        Params: { versionId: string };
        Body: unknown;
      }>,
      reply: FastifyReply,
    ) => {
      await handleRoute(reply, async () => {
        const { versionId } = request.params;
        const body = request.body;
        const id = Number.parseInt(versionId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          throw new RestError("versionId must be a positive integer", 400);
        }

        await docService.storeScraperOptions(id, body as never);
        return { ok: true };
      });
    },
  );

  // ─── Fetch URL ────────────────────────────────────────────────────

  api.post("/api/fetch-url", async (request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      const body = request.body as Record<string, unknown>;
      const parsed = z
        .object({
          url: z.string().url().describe("URL to fetch and convert to Markdown."),
          followRedirects: z.boolean().optional().default(true),
          scrapeMode: z.enum(["fetch", "playwright", "auto"]).optional(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .parse(body);

      const fetcher = new AutoDetectFetcher(config.scraper);
      const tool = new FetchUrlTool(fetcher, config);

      const markdown = await tool.execute({
        url: parsed.url,
        followRedirects: parsed.followRedirects,
        scrapeMode: parsed.scrapeMode as never,
        headers: parsed.headers,
      });
      return { content: markdown };
    });
  });

  // ─── Ingest (Store) ───────────────────────────────────────────────

  api.post("/api/ingest", async (request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      const body = request.body as Record<string, unknown>;
      const parsed = z
        .object({
          library: nonEmptyTrimmed,
          version: optionalTrimmed,
          documents: z
            .array(
              z.object({
                url: z.string().min(1),
                title: z.string(),
                contentType: z.string().optional().default("text/markdown"),
                chunks: z.array(
                  z.object({
                    content: z.string(),
                    types: z.array(z.string()).optional().default(["text"]),
                    section: z
                      .object({
                        level: z.number().int().optional().default(0),
                        path: z.array(z.string()).optional().default([]),
                      })
                      .optional()
                      .default({ level: 0, path: [] }),
                  }),
                ),
              }),
            )
            .min(1),
        })
        .parse(body);

      const scrapeResults: ScrapeResult[] = parsed.documents.map((doc) => ({
        url: doc.url,
        title: doc.title,
        sourceContentType: doc.contentType,
        contentType: doc.contentType,
        textContent: doc.chunks.map((c) => c.content).join("\n"),
        links: [],
        errors: [],
        chunks: doc.chunks.map(
          (c): Chunk => ({
            types: c.types as Chunk["types"],
            content: c.content,
            section: {
              level: c.section.level,
              path: c.section.path,
            },
          }),
        ),
      }));

      await docService.ingestDocuments(
        parsed.library,
        parsed.version ?? null,
        scrapeResults,
      );
      return { ingested: scrapeResults.length };
    });
  });

  // ─── Ingest Raw (Store) ──────────────────────────────────────────

  // Create splitter once, reuse across requests
  const { minChunkSize, preferredChunkSize, maxChunkSize } = config.splitter;
  const rawSplitter = new GreedySplitter(
    new SemanticMarkdownSplitter(preferredChunkSize, maxChunkSize),
    minChunkSize,
    preferredChunkSize,
    maxChunkSize,
  );

  api.post("/api/ingest-raw", async (request: FastifyRequest, reply: FastifyReply) => {
    await handleRoute(reply, async () => {
      const body = request.body as Record<string, unknown>;
      const parsed = z
        .object({
          library: nonEmptyTrimmed,
          version: optionalTrimmed,
          documents: z
            .array(
              z.object({
                url: z.string().min(1),
                title: z.string(),
                contentType: z.string().optional().default("text/markdown"),
                content: z.string().min(1),
              }),
            )
            .min(1),
        })
        .parse(body);

      const scrapeResults: ScrapeResult[] = [];
      let totalChunks = 0;
      for (const doc of parsed.documents) {
        const chunks = await rawSplitter.splitText(doc.content, doc.contentType);
        totalChunks += chunks.length;
        scrapeResults.push({
          url: doc.url,
          title: doc.title,
          sourceContentType: doc.contentType,
          contentType: doc.contentType,
          textContent: doc.content,
          links: [],
          errors: [],
          chunks,
        });
      }

      await docService.ingestDocuments(
        parsed.library,
        parsed.version ?? null,
        scrapeResults,
      );
      return { ingested: scrapeResults.length, chunks: totalChunks };
    });
  });

  // ─── Events (SSE) ───────────────────────────────────────────────────

  api.get("/api/events", async (request: FastifyRequest, reply: FastifyReply) => {
    // Set headers for SSE
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable buffering in nginx
    });

    // Send initial connection message
    reply.raw.write("data: connected\n\n");
    logger.debug("REST SSE client connected to /api/events");

    // Register event listeners
    const cleanupListeners = registerSseListeners(eventBus, reply);

    // Start heartbeat
    const heartbeatInterval = startSseHeartbeat(reply);

    // Clean up when client disconnects
    request.raw.on("close", () => {
      logger.debug("REST SSE client disconnected");
      cleanupListeners();
      clearInterval(heartbeatInterval);
    });

    request.raw.on("error", (error) => {
      logger.debug(`REST SSE connection error: ${error}`);
      cleanupListeners();
      clearInterval(heartbeatInterval);
    });
  });

  logger.debug("REST API service registered at /api");
}
