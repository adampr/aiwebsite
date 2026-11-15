/**
 * A plain tsx test script must not be able to exit 0 without reaching its
 * summary.
 *
 * Why: Node exits when its event loop runs dry, even while `main()` is still
 * awaiting a promise that nothing will ever settle (no timer, socket or other
 * handle keeps it alive). The exit code is then 0 and the `process.exit(...)`
 * after the summary is never reached: a silent pass. test:anthropicsdk did
 * exactly that on 2026-11-15 (its timeout arm awaited a stream that could
 * never end). A top-level `await` is safe on its own (Node exits 13 on an
 * unsettled top-level await); `main().catch(...)`, `.then(...)` chains and
 * `void (async () => {...})()` blocks are not.
 *
 * Use: `const guard = summaryGuard("suite name")` at the top; `guard.step(...)`
 * before a long await if the failure line should name it; `guard.track(label,
 * promise)` for a fire-and-forget async block that must finish too; and
 * `guard.reached()` immediately before the summary line. If the loop runs dry,
 * or anything calls process.exit(0), before that (or with a tracked block still
 * open), the exit code becomes 1 and one INCOMPLETE line names what never
 * finished. A non-zero exit is left alone.
 */
export type SummaryGuard = {
  /** Names the step in progress, for the INCOMPLETE line. */
  step(label: string): void;
  /** A fire-and-forget async block that must also settle before the exit. */
  track<T>(label: string, p: Promise<T>): Promise<T>;
  /** Call immediately before printing the summary line. */
  reached(): void;
};

export function summaryGuard(suite: string): SummaryGuard {
  let current = "start";
  let summary = false;
  const open = new Set<string>();
  const unfinished = (): string[] => [
    ...(summary ? [] : [`the summary was never reached (last step: ${current})`]),
    ...[...open].map((l) => `async block "${l}" never settled`),
  ];
  let reported = false;
  const fail = (how: string) => {
    const u = unfinished();
    if (u.length === 0) return;
    if (!reported) {
      reported = true;
      console.error(`${suite}: INCOMPLETE (${how}): ${u.join("; ")}`);
    }
    process.exitCode = 1;
  };
  // The loop ran dry with a promise still pending.
  process.on("beforeExit", () => fail("the event loop ran dry"));
  // An explicit process.exit(0) (or a natural exit) before the summary.
  // Setting process.exitCode inside an 'exit' listener changes the final code.
  process.on("exit", (code) => {
    if (code === 0) fail("exit 0 before the summary");
  });
  return {
    step(label) {
      current = label;
    },
    track(label, p) {
      open.add(label);
      return p.finally(() => open.delete(label));
    },
    reached() {
      summary = true;
    },
  };
}
