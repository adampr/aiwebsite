import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: false,
  // @aicompany/core ships TypeScript source (consumed as a git submodule via
  // file: dependency) — Next must transpile it.
  transpilePackages: ["@aicompany/core"],
  // pdf.js resolves its worker via a dynamic import relative to pdf.mjs
  // ("./pdf.worker.mjs"); bundling it into .next/server/chunks breaks that
  // resolution and every PDF extraction throws. Run it from node_modules.
  // pdfkit reads its standard-font .afm metrics from its own package dir via
  // fs at runtime; bundling relocates the code away from those files and the
  // first doc.font() call throws. Run both from node_modules.
  serverExternalPackages: ["pdfjs-dist", "pdfkit"],
  // @aicompany/core's admin blog API (packages/aicompany/src/admin/api/blog.ts,
  // submodule — not editable here) spawns node_modules/.bin/tsx via
  // path.join(process.cwd(), ...), which makes Turbopack's file tracing walk
  // the whole project and warn "Encountered unexpected file in NFT list"
  // (flagged file: next.config.ts). Verified 2026-07-25: the warning is
  // emitted during trace collection, so outputFileTracingExcludes cannot
  // silence it (it only filters the .nft.json output afterwards). NFT output
  // is unused by this deploy model anyway (no `output: "standalone"`; the VM
  // builds in place with full node_modules and runs `next start`), so this
  // build-time-only diagnostic is suppressed with a tightly scoped
  // ignoreIssue. REMOVE once upstream fixes blog.ts (the real fix is a
  // /*turbopackIgnore: true*/ comment on its path.join(process.cwd(), ...)
  // calls) — this ignore would also mask a future whole-project trace
  // introduced by host code, so it must not outlive the upstream bug.
  // BUILD MEMORY CEILING (2026-08-09). The §5.20 round-2 deploy was
  // OOM-killed twice on the VM: "Memory cgroup out of memory: Killed
  // process (node) anon-rss:2850100kB" against the staged build's
  // MemoryMax=3072M, while earlyoom reported the box itself healthy at 77
  // percent free. So the cap was the binding constraint, not the VM, and
  // STAGE_MEM_MAX_MB is already at its render-validated maximum of 3072.
  //
  // The staged build already bounds the V8 heap (NODE_OPTIONS
  // --max-old-space-size=1024, deploy/stage-build.sh); the other ~1.8 GB is
  // Turbopack's native side, which grows to whatever is available unless it
  // is told otherwise. Capping it here keeps native + heap + overhead
  // comfortably inside the cgroup instead of a few percent over it. The
  // build gets slower under memory pressure rather than being killed, which
  // is the trade we want on a 3.8 GB VM.
  experimental: {
    turbopackMemoryLimit: 1600 * 1024 * 1024,
  },
  turbopack: {
    ignoreIssue: [
      {
        path: /next\.config\.ts$/,
        title: "Encountered unexpected file in NFT list",
      },
    ],
  },
  // NOTE: experimental.inlineCss was REMOVED 2026-07-29 (growth-portfolio panel
  // follow-up). It inlined the whole Tailwind bundle into the document — and,
  // via a Next 16.2.11 defect in getGlobalErrorStyles, THREE times per response
  // (once as <style>, twice more inside the RSC flight stream). Because this
  // site's HTML is served no-store, that CSS was re-transferred on every single
  // view and could never enter the browser cache; as an external chunk it is
  // immutable/1-year. Measured on itsupportchicago (same stack, same defect):
  // document 465,569 -> 143,278 B, <h1> byte offset 114,165 -> 7,610.
  // Do NOT re-add it without re-reading reviews/ in packages/aicompany and
  // re-running the page-size floors in deploy/synth-inventory.json — those
  // floors were calibrated against the inflated bytes and had to be lowered.
};

export default nextConfig;
