import type { PipelineJob } from "../pipeline/types";
import type { ScrapeResult, ScraperProgressEvent } from "../scraper/types";
import type { EventPayloads } from "./types";
import { EventType } from "./types";

/** Date fields in PipelineJob that must be restored after JSON deserialization. */
const DATE_FIELDS = ["createdAt", "startedAt", "finishedAt", "updatedAt"] as const;

/**
 * Restores Date objects in a PipelineJob after JSON.parse.
 *
 * Native JSON.parse deserializes Date values as strings. The IPipeline contract
 * expects Date instances so downstream code can call .toISOString(), .getTime(), etc.
 * Previously superjson (tRPC) handled this automatically; REST/JSON does not.
 */
export function restoreJobDates(job: PipelineJob): PipelineJob;
export function restoreJobDates(jobs: PipelineJob[]): PipelineJob[];
export function restoreJobDates(
  input: PipelineJob | PipelineJob[],
): PipelineJob | PipelineJob[] {
  if (Array.isArray(input)) {
    for (const job of input) {
      restoreJobFields(job);
    }
    return input;
  }
  restoreJobFields(input);
  return input;
}

/** Mutates date string fields on a single job back into Date instances. */
function restoreJobFields(job: PipelineJob): void {
  for (const field of DATE_FIELDS) {
    const value = job[field];
    if (value !== undefined && value !== null && typeof value === "string") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (job as any)[field] = new Date(value);
    }
  }
}

/**
 * Restores Date objects inside event payloads that contain PipelineJob data.
 */
export function restoreEventDates<T extends EventType>(
  eventType: T,
  payload: EventPayloads[T],
): EventPayloads[T] {
  switch (eventType) {
    case EventType.JOB_STATUS_CHANGE:
    case EventType.JOB_PROGRESS: {
      const p = payload as { job: PipelineJob };
      if (p.job) {
        restoreJobFields(p.job);
      }
      return payload;
    }
    case EventType.PAGE_SCRAPED: {
      const p = payload as { job: PipelineJob; result: ScrapeResult };
      if (p.job) {
        restoreJobFields(p.job);
      }
      return payload;
    }
    default:
      return payload;
  }
}
