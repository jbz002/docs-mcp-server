/**
 * Remote event proxy that subscribes to events from a remote REST worker
 * via SSE and re-emits them to the local EventBusService.
 *
 * This enables the web UI to receive events from remote workers transparently,
 * without needing to know about the remote worker's location or configuration.
 */

import { logger } from "../utils/logger";
import type { EventBusService } from "./EventBusService";
import { EventType } from "./types";

/**
 * Manages the connection to a remote worker and forwards its events locally.
 */
export class RemoteEventProxy {
  private abortController: AbortController | null = null;
  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly remoteWorkerUrl: string,
    private readonly localEventBus: EventBusService,
  ) {}

  /**
   * Start subscribing to remote events and forwarding them locally.
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.warn("Remote event proxy already connected");
      return;
    }

    logger.debug(
      `Connecting to remote worker events at ${this.remoteWorkerUrl}/api/events`,
    );

    try {
      this.abortController = new AbortController();

      const response = await fetch(`${this.remoteWorkerUrl}/api/events`, {
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Response body is null - SSE not supported");
      }

      this.isConnected = true;
      logger.debug("Remote event subscription started");

      // Read the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages (delimited by double newlines)
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";

        for (const message of messages) {
          if (!message.trim()) continue;

          let eventType = "message";
          let data = "";

          for (const line of message.split("\n")) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              data = line.slice(6);
            }
          }

          if (data === "connected") {
            continue;
          }

          if (data) {
            try {
              const parsed = JSON.parse(data) as {
                type?: string;
                payload?: unknown;
              };

              // The SSE event name format is like "job-status-change"
              // We need to convert it back to EventType enum
              const internalEventType = mapSseNameToEventType(eventType);
              if (internalEventType) {
                logger.debug(`Received remote event: ${eventType}`);
                this.localEventBus.emit(internalEventType, parsed as never);
              }
            } catch (error) {
              logger.debug(`Failed to parse remote event data: ${error}`);
            }
          }
        }
      }
    } catch (error) {
      this.isConnected = false;
      this.abortController = null;

      if ((error as Error).name === "AbortError") {
        logger.debug("Remote event subscription aborted");
      } else {
        logger.error(`❌ Remote event subscription error: ${error}`);
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from the remote worker and stop forwarding events.
   */
  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.isConnected = false;
    logger.info("🚫 Disconnected from remote worker");
  }

  /**
   * Check if the proxy is currently connected to the remote worker.
   */
  isActive(): boolean {
    return this.isConnected;
  }

  /**
   * Schedule a reconnection attempt after a delay.
   */
  private scheduleReconnect(): void {
    logger.info("🔄 Scheduling reconnect to remote worker in 5 seconds...");
    this.reconnectTimer = setTimeout(() => {
      if (!this.isConnected) {
        this.connect();
      }
    }, 5000);
  }
}

/**
 * Map SSE event name (e.g., "job-status-change") to internal EventType enum.
 */
function mapSseNameToEventType(sseName: string): EventType | null {
  switch (sseName) {
    case "job-status-change":
      return EventType.JOB_STATUS_CHANGE;
    case "job-progress":
      return EventType.JOB_PROGRESS;
    case "library-change":
      return EventType.LIBRARY_CHANGE;
    case "job-list-change":
      return EventType.JOB_LIST_CHANGE;
    default:
      return null;
  }
}
