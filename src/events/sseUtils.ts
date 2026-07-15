/**
 * Shared SSE (Server-Sent Events) utility functions.
 * Used by both the REST API SSE endpoint (/api/events) and the Web UI SSE endpoint (/web/events).
 */

import type { FastifyReply } from "fastify";
import type { PipelineJob } from "../pipeline/types";
import type { ScraperProgressEvent } from "../scraper/types";
import { logger } from "../utils/logger";
import type { EventBusService } from "./EventBusService";
import {
  type EventPayloads,
  EventType,
  ServerEventName,
  type SseEventPayloads,
} from "./types";

/**
 * Convert internal event payload to SSE payload format.
 * Transforms non-serializable types (Date, Error) into JSON-safe representations.
 */
export function convertToSsePayload(
  eventType: EventType,
  payload: EventPayloads[EventType],
): SseEventPayloads[keyof SseEventPayloads] {
  switch (eventType) {
    case EventType.JOB_STATUS_CHANGE: {
      const job = payload as PipelineJob;
      return {
        id: job.id,
        library: job.library,
        version: job.version,
        status: job.status,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        sourceUrl: job.sourceUrl,
      } satisfies SseEventPayloads["job-status-change"];
    }

    case EventType.JOB_PROGRESS: {
      const { job, progress } = payload as {
        job: PipelineJob;
        progress: ScraperProgressEvent;
      };
      return {
        id: job.id,
        library: job.library,
        version: job.version,
        progress: {
          pagesScraped: progress.pagesScraped,
          totalPages: progress.totalPages,
          totalDiscovered: progress.totalDiscovered,
          currentUrl: progress.currentUrl,
          depth: progress.depth,
          maxDepth: progress.maxDepth,
        },
      } satisfies SseEventPayloads["job-progress"];
    }

    case EventType.LIBRARY_CHANGE: {
      return {} satisfies SseEventPayloads["library-change"];
    }

    case EventType.JOB_LIST_CHANGE: {
      return {} satisfies SseEventPayloads["job-list-change"];
    }

    default: {
      // TypeScript ensures this is unreachable if all cases are handled
      const _exhaustive: never = eventType;
      throw new Error(`Unhandled event type: ${_exhaustive}`);
    }
  }
}

/**
 * Send an SSE message to the client.
 * @returns true if the message was sent successfully, false otherwise.
 */
export function sendSseMessage(
  reply: FastifyReply,
  eventName: string,
  data: unknown,
): boolean {
  try {
    const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    reply.raw.write(message);
    return true;
  } catch (error) {
    logger.error(`❌ Failed to send SSE event: ${error}`);
    return false;
  }
}

/**
 * Register SSE event listeners on the event bus and return cleanup function.
 * Subscribes to all event types and forwards them as SSE messages.
 */
export function registerSseListeners(
  eventBus: EventBusService,
  reply: FastifyReply,
): () => void {
  const allEventTypes = [
    EventType.JOB_STATUS_CHANGE,
    EventType.JOB_PROGRESS,
    EventType.LIBRARY_CHANGE,
    EventType.JOB_LIST_CHANGE,
  ] as const;

  const unsubscribers: (() => void)[] = [];

  for (const eventType of allEventTypes) {
    const unsubscribe = eventBus.on(eventType, (payload) => {
      try {
        const eventName = ServerEventName[eventType];
        const ssePayload = convertToSsePayload(eventType, payload);
        logger.debug(`SSE forwarding event: ${eventName} ${JSON.stringify(ssePayload)}`);
        sendSseMessage(reply, eventName, ssePayload);
      } catch (error) {
        logger.error(`❌ Failed to convert/send SSE event ${eventType}: ${error}`);
      }
    });
    unsubscribers.push(unsubscribe);
  }

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

/**
 * Start a heartbeat interval to keep SSE connection alive.
 * @param reply - The Fastify reply with raw socket access.
 * @param intervalMs - Heartbeat interval in milliseconds (default: 30 seconds).
 * @returns The interval ID for cleanup.
 */
export function startSseHeartbeat(
  reply: FastifyReply,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      reply.raw.write(": heartbeat\n\n");
    } catch (_error) {
      // Client likely disconnected
    }
  }, intervalMs);
}
