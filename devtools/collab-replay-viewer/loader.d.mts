import type { CollabReplayTraceV1, CollabTraceStep, TraceTarget } from "../../src/collab-trace.js";

export interface TraceFilters {
  actors?: readonly string[];
  outcomes?: readonly string[];
  targets?: readonly string[];
}

export function loadTrace(input: string | unknown): Readonly<CollabReplayTraceV1>;
export function targetLabel(target: TraceTarget): string;
export function filterOptions(trace: CollabReplayTraceV1): { actors: string[]; outcomes: string[]; targets: string[] };
export function filterSteps(trace: CollabReplayTraceV1, filters?: TraceFilters): readonly CollabTraceStep[];
