/**
 * SSE (Server-Sent Events) endpoint for real-time updates.
 * Clients connect to this endpoint to receive live updates about jobs and libraries.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EventBusService } from "../../events/EventBusService";
import { registerSseListeners, startSseHeartbeat } from "../../events/sseUtils";
import { logger } from "../../utils/logger";

/**
 * Registers the SSE events route.
 * @param server - The Fastify instance.
 * @param eventBus - The central event bus service instance.
 */
export function registerEventsRoute(
  server: FastifyInstance,
  eventBus: EventBusService,
): void {
  server.get("/web/events", async (request: FastifyRequest, reply: FastifyReply) => {
    // Set headers for SSE
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable buffering in nginx
    });

    // Send initial connection message
    reply.raw.write("data: connected\n\n");
    logger.debug("SSE client connected");

    // Register event listeners using shared utility
    const cleanupListeners = registerSseListeners(eventBus, reply);

    // Start heartbeat
    const heartbeatInterval = startSseHeartbeat(reply);

    // Clean up when client disconnects
    request.raw.on("close", () => {
      logger.debug("SSE client disconnected");
      cleanupListeners();
      clearInterval(heartbeatInterval);
    });

    // Handle errors
    request.raw.on("error", (error) => {
      // This may happen when the client disconnects abruptly, the page is reloaded, etc.
      logger.debug(`SSE connection error: ${error}`);
      cleanupListeners();
      clearInterval(heartbeatInterval);
    });
  });
}
