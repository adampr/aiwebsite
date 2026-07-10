// §4.3 layer-2 validation at process start (packages/aicompany): config↔env
// cross-checks, secret presence, table-registry completeness. Fails boot with
// the field named, never a request-time 500.
//
// Host-written register() (the module's instrumentation.ts sanctions this for
// hosts where its dynamic file-URL import doesn't bundle): statically import
// the db wrapper first so registerTables() has run, then runtimeCheck.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SKIP_ENV_VALIDATION === "1") return;
  await import("@/lib/db");
  const { siteConfig } = await import("site.config");
  const { runtimeCheck } = await import("@aicompany/core/config/check");
  runtimeCheck(siteConfig);
}
