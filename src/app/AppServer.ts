/**
 * Central application server that can be configured to run different combinations of services.
 * This replaces the separate server implementations with a single, modular approach.
 *
 * This fork serves the REST API and the MCP endpoint; there is no web UI.
 */

import type { IncomingHttpHeaders } from "node:http";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { JwtAccessTokenVerifier } from "../auth/JwtAccessTokenVerifier";
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataPaths,
  protectedResourceMetadataUrl,
} from "../auth/protectedResourceMetadata";
import type { JobsBackend } from "../services/backend";
import {
  MCP_ENDPOINT_PATH,
  type McpEndpointAuth,
  registerMcpService,
} from "../services/mcpService";
import { registerRestService } from "../services/restService";
import { TelemetryEvent, telemetry } from "../telemetry";
import { shouldEnableTelemetry } from "../telemetry/TelemetryConfig";
import { printBanner } from "../utils/banner";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import {
  describePublicLocationWarnings,
  type PublicLocation,
  resolvePublicLocation,
} from "../utils/serverOrigin";
import type { AppServerConfig } from "./AppServerConfig";
import { isUnderPath, stripBasePath } from "./basePath";
import {
  createHostPolicy,
  createOriginPolicy,
  type HostPolicy,
  isLoopbackBindHost,
  type OriginPolicy,
  setCorsPreflightHeaders,
} from "./originPolicy";

/** Distinct refused host names that get a warning; later ones are only refused. */
const MAX_REFUSED_HOST_WARNINGS = 20;

/**
 * Central application server that provides modular service composition.
 */
export class AppServer {
  private server: FastifyInstance;
  /** Authentication for the MCP endpoint; set only when auth is enabled and MCP is served. */
  private mcpAuth: McpEndpointAuth | undefined;
  private readonly originPolicy: OriginPolicy;
  private readonly hostPolicy: HostPolicy;
  private readonly refusedHosts = new Set<string>();
  /**
   * On a loopback bind no reverse proxy stands in front of the API, so it is
   * shielded from foreign web pages the same way as the MCP endpoint.
   */
  private readonly shieldsApi: boolean;
  private serverConfig: AppServerConfig;
  private readonly appConfig: AppConfig;
  private readonly backend: JobsBackend;
  /** Where clients reach this server; every advertised URL derives from it. */
  private readonly location: PublicLocation;
  /** Public URL of the MCP endpoint: the resource identifier and default token audience. */
  private readonly mcpEndpointUrl: string;

  /**
   * @param backend The services to serve. Whoever opened them closes them;
   *   the server neither starts nor stops the pipeline.
   * @param serverConfig Which services to run and the port to bind.
   * @param appConfig The application configuration.
   */
  constructor(backend: JobsBackend, serverConfig: AppServerConfig, appConfig: AppConfig) {
    this.backend = backend;
    this.serverConfig = serverConfig;
    this.appConfig = appConfig;
    this.location = resolvePublicLocation(appConfig, serverConfig.port);
    for (const warning of describePublicLocationWarnings(appConfig)) {
      logger.warn(`⚠️  ${warning}`);
    }
    this.mcpEndpointUrl = `${this.location.url}${MCP_ENDPOINT_PATH}`;
    const browserPolicy = {
      publicOrigin: this.location.configured ? this.location.origin : undefined,
      allowedOrigins: appConfig.server.allowedOrigins,
    };
    this.originPolicy = createOriginPolicy(browserPolicy);
    this.hostPolicy = createHostPolicy(browserPolicy);
    this.shieldsApi = isLoopbackBindHost(appConfig.server.host);
    const basePath = this.location.basePath;
    this.server = Fastify({
      logger: false, // Use our own logger
      // One set of root-mounted routes serves proxies that forward the base
      // path and proxies that strip it.
      rewriteUrl: (request) => stripBasePath(request.url ?? "/", basePath),
    });
  }

  /**
   * Validate the server configuration for invalid service combinations.
   */
  /** Whether jobs run in this process rather than on a remote worker. */
  private get runsJobs(): boolean {
    return this.backend.workerUrl === undefined;
  }

  /**
   * Whether a request's `Host` header may be served, warning once per refused
   * name so an operator reaching the server under an unknown name sees why.
   */
  private acceptsHost(host: string | undefined): boolean {
    if (this.hostPolicy.isAllowed(host)) {
      return true;
    }
    const name = JSON.stringify(String(host).slice(0, 100));
    if (
      !this.refusedHosts.has(name) &&
      this.refusedHosts.size < MAX_REFUSED_HOST_WARNINGS
    ) {
      this.refusedHosts.add(name);
      logger.warn(
        `⚠️  Refused a request for host ${name}. If clients reach the server under this name, set server.publicUrl to it or add its origin to server.allowedOrigins.`,
      );
    }
    return false;
  }

  /**
   * Why a request is refused before routing, if it is: an unknown host name
   * (DNS rebinding), or a foreign origin calling the API on a loopback bind.
   * @param headers - The request headers.
   * @param reachesApi - Whether the request targets the REST API or the MCP endpoint.
   * @returns The refusal message, or `undefined` when the request may proceed.
   */
  private refusal(headers: IncomingHttpHeaders, reachesApi: boolean): string | undefined {
    if (!this.acceptsHost(headers.host)) {
      return "Forbidden: host not allowed.";
    }
    if (
      reachesApi &&
      this.shieldsApi &&
      this.originPolicy.check(headers.origin) === "denied"
    ) {
      return "Forbidden: origin not allowed.";
    }
    return undefined;
  }

  /**
   * Start the application server with the configured services.
   */
  async start(): Promise<FastifyInstance> {
    // Get embedding configuration from the document service (source of truth)
    const embeddingConfig = this.backend.docService.getActiveEmbeddingConfig();

    // Initialize telemetry if enabled
    if (this.appConfig.app.telemetryEnabled && shouldEnableTelemetry()) {
      try {
        // Set global application context that will be included in all events
        if (telemetry.isEnabled()) {
          telemetry.setGlobalContext({
            appVersion: __APP_VERSION__,
            appPlatform: process.platform,
            appNodeVersion: process.version,
            appServicesEnabled: this.getActiveServicesList(),
            appAuthEnabled: Boolean(this.appConfig.auth.enabled),
            appReadOnly: Boolean(this.appConfig.app.readOnly),
            // Add embedding configuration to global context
            ...(embeddingConfig && {
              aiEmbeddingProvider: embeddingConfig.provider,
              aiEmbeddingModel: embeddingConfig.model,
              aiEmbeddingDimensions: embeddingConfig.dimensions,
            }),
          });

          // Track app start at the very beginning
          telemetry.track(TelemetryEvent.APP_STARTED, {
            services: this.getActiveServicesList(),
            port: this.serverConfig.port,
            externalWorker: Boolean(this.backend.workerUrl),
            // Include startup context when available
            ...(this.serverConfig.startupContext?.cliCommand && {
              cliCommand: this.serverConfig.startupContext.cliCommand,
            }),
            ...(this.serverConfig.startupContext?.mcpProtocol && {
              mcpProtocol: this.serverConfig.startupContext.mcpProtocol,
            }),
            ...(this.serverConfig.startupContext?.mcpTransport && {
              mcpTransport: this.serverConfig.startupContext.mcpTransport,
            }),
          });
        }
      } catch (error) {
        logger.debug(`Failed to initialize telemetry: ${error}`);
      }
    }

    await this.setupServer();

    try {
      await this.server.listen({
        port: this.serverConfig.port,
        host: this.appConfig.server.host,
      });

      this.logStartupInfo(this.location.url);
      return this.server;
    } catch (error) {
      logger.error(`❌ Failed to start AppServer: ${error}`);
      await this.server.close();
      throw error;
    }
  }

  /**
   * Stop the application server and cleanup all services.
   */
  async stop(): Promise<void> {
    try {
      // Track app shutdown
      if (telemetry.isEnabled()) {
        telemetry.track(TelemetryEvent.APP_SHUTDOWN, {
          graceful: true,
        });
      }

      // Shutdown telemetry service (this will flush remaining events)
      await telemetry.shutdown();

      // Force close all connections to ensure immediate shutdown
      if (this.server.server) {
        this.server.server.closeAllConnections();
      }

      // Close Fastify server
      await this.server.close();
      logger.info("🛑 AppServer stopped");
    } catch (error) {
      logger.error(`❌ Failed to stop AppServer gracefully: ${error}`);

      // Track ungraceful shutdown
      if (telemetry.isEnabled()) {
        telemetry.track(TelemetryEvent.APP_SHUTDOWN, {
          graceful: false,
          error: error instanceof Error ? error.constructor.name : "UnknownError",
        });
        await telemetry.shutdown();
      }

      throw error;
    }
  }

  /**
   * Setup global error handling for telemetry
   */
  private setupErrorHandling(): void {
    // Only add listeners if they haven't been added yet (prevent duplicate listeners in tests)
    if (!process.listenerCount("unhandledRejection")) {
      // Catch unhandled promise rejections
      process.on("unhandledRejection", (reason) => {
        logger.error(`Unhandled Promise Rejection: ${reason}`);
        if (telemetry.isEnabled()) {
          // Create an Error object from the rejection reason for better tracking
          const error = reason instanceof Error ? reason : new Error(String(reason));
          telemetry.captureException(error, {
            error_category: "system",
            component: AppServer.constructor.name,
            context: "process_unhandled_rejection",
          });
        }
      });
    }

    if (!process.listenerCount("uncaughtException")) {
      // Catch uncaught exceptions
      process.on("uncaughtException", (error) => {
        logger.error(`Unhandled Exception: ${error.message}`);
        if (telemetry.isEnabled()) {
          telemetry.captureException(error, {
            error_category: "system",
            component: AppServer.constructor.name,
            context: "process_uncaught_exception",
          });
        }
        // Don't exit immediately, let the app attempt graceful shutdown
      });
    }

    // Setup Fastify error handler (if method exists - for testing compatibility)
    if (typeof this.server.setErrorHandler === "function") {
      this.server.setErrorHandler<FastifyError>(async (error, request, reply) => {
        if (telemetry.isEnabled()) {
          telemetry.captureException(error, {
            errorCategory: "http",
            component: "FastifyServer",
            statusCode: error.statusCode || 500,
            method: request.method,
            route: request.routeOptions?.url || request.url,
            context: "http_request_error",
          });
        }

        logger.error(`HTTP Error on ${request.method} ${request.url}: ${error.message}`);

        // Send appropriate error response
        const statusCode = error.statusCode || 500;
        reply.status(statusCode).send({
          error: "Internal Server Error",
          statusCode,
          message: statusCode < 500 ? error.message : "An unexpected error occurred",
        });
      });
    }
  }

  /**
   * Get list of currently active services for telemetry
   */
  private getActiveServicesList(): string[] {
    const services: string[] = [];
    if (this.serverConfig.enableMcpServer) services.push("mcp");
    if (this.serverConfig.enableApiServer) services.push("api");
    if (this.runsJobs) services.push("worker");
    return services;
  }

  /**
   * Setup the server with plugins and conditionally enabled services.
   */
  private async setupServer(): Promise<void> {
    // Setup global error handling for telemetry
    this.setupErrorHandling();

    // Refuse host names that could belong to an attacker's page (a DNS-rebound
    // page sends same-origin GET requests without an Origin header, so origin
    // checks alone cannot recognize it), and shield the API on a loopback bind.
    this.server.addHook("onRequest", async (request, reply) => {
      const pathname = request.url.split("?")[0];
      const reachesApi =
        isUnderPath(pathname, "/api") ||
        isUnderPath(pathname, MCP_ENDPOINT_PATH) ||
        isUnderPath(pathname, "/sse") ||
        isUnderPath(pathname, "/messages");
      const refusal = this.refusal(request.headers, reachesApi);
      if (refusal) {
        return reply.code(403).send({ error: refusal });
      }
    });

    // Authentication covers the MCP endpoint only; set it up before the
    // endpoint registers so every request goes through the same checks.
    await this.setupAuthentication();

    // Conditionally enable services based on configuration
    if (this.serverConfig.enableMcpServer) {
      await this.enableMcpServer();
    }

    if (this.serverConfig.enableApiServer) {
      await this.enableRestApi();
    }
  }

  /**
   * Enable MCP server service.
   */
  private async enableMcpServer(): Promise<void> {
    await registerMcpService(
      this.server,
      {
        docService: this.backend.docService,
        config: this.appConfig,
        originPolicy: this.originPolicy,
        location: this.location,
      },
      this.mcpAuth,
    );
    logger.debug("MCP server service enabled");
  }

  /**
   * Enable REST API service.
   */
  private async enableRestApi(): Promise<void> {
    await registerRestService(
      this.server,
      this.backend.pipeline,
      this.backend.docService,
      this.backend.eventBus,
      this.appConfig,
    );
    logger.debug("REST API server enabled");
  }

  /**
   * Set up authentication for the MCP endpoint: this server is an OAuth 2.0
   * resource server that verifies tokens the configured issuer issued for it,
   * and publishes protected resource metadata so clients can find that issuer.
   *
   * @throws Error when authentication is enabled for the MCP endpoint without
   *   an issuer or a public URL, or when the issuer can't be discovered.
   */
  private async setupAuthentication(): Promise<void> {
    if (!this.appConfig.auth.enabled) {
      return;
    }
    if (!this.serverConfig.enableMcpServer) {
      logger.warn(
        "⚠️  Authentication is enabled, but this process serves no MCP endpoint, so it protects nothing here. The REST API is never protected by authentication.",
      );
      return;
    }

    const issuerUrl = this.appConfig.auth.issuerUrl?.trim();
    if (!issuerUrl) {
      throw new Error(
        "Authentication is enabled but auth.issuerUrl is not set. Set it to your identity provider's issuer URL.",
      );
    }
    if (!this.location.configured) {
      throw new Error(
        "Authentication is enabled but no public URL is configured. Set server.publicUrl (or --public-url) to the URL clients use to reach this server.",
      );
    }

    const verifier = await JwtAccessTokenVerifier.create({
      issuerUrl,
      audience: this.appConfig.auth.audience?.trim() || this.mcpEndpointUrl,
    });

    const document = buildProtectedResourceMetadata({
      mcpEndpointUrl: this.mcpEndpointUrl,
      issuerUrl,
      server: this.appConfig.server,
    });
    for (const metadataPath of protectedResourceMetadataPaths(
      this.location.basePath,
      MCP_ENDPOINT_PATH,
    )) {
      this.server.route({
        method: ["GET", "HEAD"],
        url: metadataPath,
        handler: async (_request, reply) =>
          reply
            .header("Access-Control-Allow-Origin", "*")
            .type("application/json")
            .send(document),
      });
      this.server.options(metadataPath, async (request, reply) => {
        setCorsPreflightHeaders(reply.raw, {
          origin: "*",
          methods: "GET",
          requestedHeaders: request.headers["access-control-request-headers"],
        });
        return reply.code(204).send();
      });
    }

    this.mcpAuth = {
      verifier,
      resourceMetadataUrl: protectedResourceMetadataUrl(
        this.location.url,
        MCP_ENDPOINT_PATH,
      ),
    };
    logger.debug(`Protected resource metadata served for ${this.mcpEndpointUrl}`);
  }

  /**
   * Log startup information showing which services are enabled.
   */
  private logStartupInfo(address: string): void {
    // Print the ASCII art banner if enabled
    if (this.serverConfig.showLogo !== false) {
      printBanner();
    }

    // Determine the service mode
    const isWorkerOnly = this.runsJobs && !this.serverConfig.enableMcpServer;
    const isMcpOnly = this.serverConfig.enableMcpServer && !this.runsJobs;

    // Determine the main service name
    if (isWorkerOnly) {
      logger.info(`🚀 Worker available at ${address}`);
    } else if (isMcpOnly) {
      logger.info(`🚀 MCP server available at ${address}`);
    } else {
      logger.info(`🚀 Grounded Docs available at ${address}`);
    }

    const enabledServices: string[] = [];

    // MCP endpoints: always show if enabled
    if (this.serverConfig.enableMcpServer) {
      enabledServices.push(`MCP endpoints: ${address}/mcp, ${address}/sse`);
    }

    // Authentication boundary: say exactly what is and isn't protected
    if (this.mcpAuth) {
      enabledServices.push(
        `Authentication: protects ${this.mcpEndpointUrl} only; the REST API is not protected`,
      );
    }

    // Worker: only show external worker URL (internal is implied)
    if (this.backend.workerUrl) {
      enabledServices.push(`Worker: ${this.backend.workerUrl}`);
    }

    // Embeddings: only show when jobs run in this process
    if (this.runsJobs) {
      const embeddingConfig = this.backend.docService.getActiveEmbeddingConfig();
      if (embeddingConfig) {
        enabledServices.push(
          `Embeddings: ${embeddingConfig.provider}:${embeddingConfig.model}`,
        );
      } else {
        enabledServices.push(`Embeddings: disabled (full text search only)`);
      }
    }

    for (const service of enabledServices) {
      logger.info(`   • ${service}`);
    }
  }
}
