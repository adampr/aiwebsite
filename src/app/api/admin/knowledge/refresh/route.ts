import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";

export const runtime = "nodejs";

// Manually kick the nightly knowledge crawl (scripts/refresh-tron-knowledge.mjs,
// normally an 08:00 UTC root cron). The crawl takes minutes, so it runs
// detached with output appended to data/knowledge-refresh-manual.log; the
// in-process flag prevents doubled runs from this UI (the cron itself is not
// coordinated with — same as running the script by hand twice).
let running: { startedAt: string; pid: number } | null = null;

function logFile(): string {
  return path.join(process.cwd(), "data", "knowledge-refresh-manual.log");
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  return NextResponse.json({ running });
}

export async function POST() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  if (running) {
    return NextResponse.json(
      { error: `Crawl already running (started ${running.startedAt})` },
      { status: 409 }
    );
  }

  const script = path.join(process.cwd(), "scripts", "refresh-tron-knowledge.mjs");
  try {
    const out = fs.openSync(logFile(), "a");
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    const startedAt = new Date().toISOString();
    running = { startedAt, pid: child.pid ?? -1 };
    child.on("exit", () => {
      running = null;
    });
    child.on("error", () => {
      running = null;
    });
    child.unref();
    fs.closeSync(out);
    console.log(
      `[admin/knowledge] crawl started by ${auth.session.email} (pid ${child.pid})`
    );
    return NextResponse.json({ ok: true, startedAt });
  } catch (err) {
    running = null;
    console.error("[admin/knowledge] failed to start crawl:", err);
    return NextResponse.json({ error: "Failed to start crawl" }, { status: 500 });
  }
}
