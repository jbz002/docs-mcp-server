# Event Bus Architecture

This document describes the event-driven architecture used for real-time communication between backend services. The system uses a central event bus to decouple event producers from consumers, enabling flexible and scalable status updates.

## Overview

The core of the system is the `EventBusService`, an in-memory pub/sub service. It allows different parts of the application, such as the job processing pipeline, to emit events without being directly coupled to the components that consume them, like the CLI commands that display progress.

This architecture achieves two primary goals:

1.  **Decoupling:** The `PipelineManager` does not need to know about its consumers. It simply emits events about its state.
2.  **Real-Time Updates:** Consumers (e.g. CLI commands) receive immediate feedback on background job progress and status changes.

## Core Components

| Component          | Location             | Responsibility                                                                                                                                         |
| :----------------- | :------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PipelineManager`  | `src/pipeline/`      | Manages the lifecycle of scraping and indexing jobs. It is the primary **producer** of job-related events, emitting directly to the `EventBusService`. |
| `EventBusService`  | `src/events/`        | The central pub/sub bus that receives all events and distributes them to registered listeners.                                                         |
| `RemoteEventProxy` | `src/events/`        | Subscribes to events from an external worker via tRPC and re-emits them on the local event bus.                                                        |
| **CLI Commands**   | `src/cli/commands/`  | CLI commands subscribe to events from the event bus to display progress indicators (using `ora` spinner).                                              |

## Local Event Flow

The following diagram illustrates the flow of an event when the worker is running within the same process as its consumers.

```mermaid
sequenceDiagram
    participant PipelineManager
    participant EventBusService
    participant CLI as "CLI Command"

    PipelineManager->>EventBusService: Emits JOB_STATUS_CHANGE event
    EventBusService->>CLI: Notifies listener of event
    CLI->>CLI: Updates ora spinner
```

1.  The `PipelineManager` updates the status of a job and directly emits a `JOB_STATUS_CHANGE` event to the `EventBusService`.
2.  The `EventBusService` forwards the event to all its registered listeners:
    - CLI commands (for terminal progress indicators)
3.  CLI commands update their progress indicators (e.g., `ora` spinner).

## External Worker Event Flow

When using an external worker, the `RemoteEventProxy` ensures events are seamlessly integrated into the local system.

```mermaid
sequenceDiagram
    participant WorkerProcess as "External Worker"
    participant AppServer
    participant RemoteEventProxy
    participant EventBusService

    WorkerProcess->>AppServer: Emits event over tRPC
    AppServer->>RemoteEventProxy: Receives tRPC event
    RemoteEventProxy->>EventBusService: Emits event locally
```

1.  An event occurs in the external worker process.
2.  The event is sent to the `AppServer` via a tRPC subscription.
3.  The `RemoteEventProxy` on the `AppServer` receives the event.
4.  The proxy re-emits the event on the local `EventBusService`, at which point it follows the same flow as a local event.

## Key Event Types

| Event Name          | Payload                                                | Description                                                                          |
| :------------------ | :----------------------------------------------------- | :----------------------------------------------------------------------------------- |
| `JOB_STATUS_CHANGE` | `PipelineJob`                                          | Fired when a job's status changes (e.g., QUEUED, RUNNING, COMPLETED).                |
| `JOB_PROGRESS`      | `{ job: PipelineJob, progress: ScraperProgressEvent }` | Fired periodically during a running job to provide progress updates.                 |
| `LIBRARY_CHANGE`    | `undefined`                                            | Fired when a library's state may have changed, signaling consumers to refresh data.  |
