/**
 * Prints each benchmark's cost as a share of one 60 Hz frame.
 *
 * Vitest's own table reports hz/mean/p99 in milliseconds and has no notion of a
 * frame budget, but the frame share is the figure this baseline exists to give:
 * `applyOps` and `project` sit on the follower's frame path, so "6% of a frame"
 * is a number a reader can act on, where "1.03 ms" invites comparison against
 * nothing.
 *
 * WHY A REPORTER AND NOT `afterAll`. `afterAll` does not run under
 * `vitest bench` — probed against vitest 4.1.11, where a hook in a benchmark
 * suite produced no output at all. Reporters are the supported seam.
 *
 * WHY `onTestRunEnd` AND `test.task.result.benchmark`. Vitest 4 replaced the
 * v3 `onFinished(files)` hook with `onTestRunEnd(testModules)`; a reporter
 * defining only `onFinished` loads, runs `onInit`, and is then silently never
 * called again. The public `test.meta().benchmark` is only the boolean marking
 * a task AS a benchmark — the measurements hang off the underlying runner task
 * at `test.task.result.benchmark`. Both were established by probing, not from
 * docs, so the access is defensive: anything missing is skipped rather than
 * throwing, and a version bump that moves these degrades to printing nothing
 * instead of failing a run that has no assertions to fail.
 *
 * This asserts nothing and fails nothing. A frame share is context for setting
 * a budget later, not a pass mark; see bench/apply-project.bench.ts for why
 * this baseline refuses to invent a threshold.
 */

/** One 60 Hz frame, in milliseconds. Must match bench/apply-project.bench.ts. */
const FRAME_MS = 16.6;

interface BenchmarkMeasurement {
  mean?: number;
  p99?: number;
  rme?: number;
}

interface BenchTest {
  name: string;
  parent?: { name?: string };
  task?: { result?: { benchmark?: BenchmarkMeasurement } };
}

interface TestModule {
  children?: { allTests?: () => Iterable<BenchTest> };
}

interface Row {
  label: string;
  mean: number;
  p99: number;
  rme: number;
}

/** Defensive by design: see the header on why these accessors were probed, not read from docs. */
function collectRows(modules: TestModule[]): Row[] {
  const rows: Row[] = [];
  for (const module of modules) {
    for (const test of module.children?.allTests?.() ?? []) {
      const measured = test.task?.result?.benchmark;
      if (!measured || typeof measured.mean !== "number") continue;
      const suite = test.parent?.name;
      rows.push({
        label: suite ? `${suite} › ${test.name}` : test.name,
        mean: measured.mean,
        p99: typeof measured.p99 === "number" ? measured.p99 : Number.NaN,
        rme: typeof measured.rme === "number" ? measured.rme : Number.NaN,
      });
    }
  }
  return rows;
}

export default class FrameShareReporter {
  onTestRunEnd(modules: TestModule[] = []): void {
    const rows = collectRows(modules);
    if (rows.length === 0) return;

    const share = (ms: number) => (Number.isFinite(ms) ? `${((ms / FRAME_MS) * 100).toFixed(2)}%` : "n/a");
    const width = Math.max(...rows.map((row) => row.label.length));

    console.log(`\n  Share of one ${FRAME_MS} ms frame (60 Hz) — baseline only, nothing is asserted\n`);
    for (const row of rows) {
      console.log(
        `  ${row.label.padEnd(width)}   mean ${row.mean.toFixed(4)} ms = ${share(row.mean).padStart(7)}` +
          `   p99 ${row.p99.toFixed(4)} ms = ${share(row.p99).padStart(7)}` +
          `   ±${row.rme.toFixed(2)}%`,
      );
    }
    console.log("");
  }
}
