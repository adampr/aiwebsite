"use client";

// /governance signed-in home: the user's project list plus the create panel
// (kind picker, domain confirm/override, required acknowledgment). Deletion
// is a two-step confirm that names the immediacy (critique S12).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ACK_TEXT,
  AI_PROCESSING_NOTICE,
  DELETION_NOTICE,
  KIND_LABELS,
} from "@/lib/governance/config";
import {
  GOVERNANCE_KINDS,
  type GovernanceKind,
  type ProjectSummary,
} from "@/lib/governance/types";
import { api, fmtDate, StatusBadge } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

function statusLine(p: ProjectSummary): string {
  switch (p.status) {
    case "created":
    case "queued":
      return "waiting to start research";
    case "researching":
      return "researching now";
    case "research_failed":
      return "research paused";
    case "drafting":
      return `question ${p.progress.answered + 1} of about ${p.progress.total}`;
    case "review":
      return "ready for your review";
    case "done":
      return "final";
  }
}

function openLabel(status: ProjectSummary["status"]): string {
  if (status === "drafting") return "Resume";
  if (status === "review") return "Review and confirm";
  return "Open";
}

export function GovernanceHome({ defaultDomain }: { defaultDomain: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [listError, setListError] = useState("");
  const [signedOut, setSignedOut] = useState(false);

  const [kind, setKind] = useState<GovernanceKind | null>(null);
  const [domain, setDomain] = useState(defaultDomain);
  const [editingDomain, setEditingDomain] = useState(defaultDomain === "");
  const [ack, setAck] = useState(false);
  const [ackHint, setAckHint] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{
    code: string;
    message: string;
  } | null>(null);

  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<{ projects: ProjectSummary[] }>("/api/governance/projects").then(
      (r) => {
        if (!alive) return;
        if (r.ok) setProjects(r.data.projects);
        else if (r.status === 401) setSignedOut(true);
        else setListError(r.message);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  async function create() {
    if (!kind || creating) return;
    if (!ack) {
      setAckHint(true);
      return;
    }
    setCreating(true);
    setCreateError(null);
    const r = await api<{ id: string; status: string }>(
      "/api/governance/projects",
      {
        method: "POST",
        body: JSON.stringify({ kind, domain: domain.trim(), ack: true }),
      }
    );
    if (r.ok) {
      router.push(`/governance/${r.data.id}`);
      return;
    }
    setCreating(false);
    if (r.status === 401) {
      setSignedOut(true);
      return;
    }
    setCreateError({ code: r.code, message: r.message });
    if (r.code === "invalid_domain") setEditingDomain(true);
  }

  async function confirmDelete(id: string) {
    if (deleteBusy) return;
    setDeleteBusy(true);
    const r = await api<undefined>(
      `/api/governance/projects/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    setDeleteBusy(false);
    if (r.ok || r.status === 404) {
      setProjects((ps) => (ps ? ps.filter((x) => x.id !== id) : ps));
      setDeletePending(null);
    } else if (r.status === 401) {
      setSignedOut(true);
    } else {
      setListError(r.message);
    }
  }

  if (signedOut) {
    return (
      <div className="panel panel--lightline mx-auto max-w-xl text-center">
        <h3>Sign in to continue</h3>
        <p className="mx-auto mt-4 text-sm">
          Your session ended. Sign back in and you will land right here.
        </p>
        <a
          href={`/login?redirect=${encodeURIComponent("/governance")}`}
          className="btn btn--primary mt-6 no-underline"
        >
          Sign in
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      {/* Project list */}
      <section aria-label="Your projects" className="space-y-4">
        {projects === null && !listError && (
          <p className="text-sm" style={dim}>
            Loading your projects...
          </p>
        )}
        {listError && (
          <p className="text-sm" role="alert" style={{ color: "var(--xl-danger)" }}>
            {listError}
          </p>
        )}
        {projects !== null && projects.length === 0 && (
          <p className="text-sm" style={dim}>
            No projects yet. Pick what you want to build.
          </p>
        )}
        {projects?.map((p) => (
          <div key={p.id} className="panel">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h3 className="doc-h text-lg">{KIND_LABELS[p.kind].name}</h3>
              <StatusBadge status={p.status} />
            </div>
            <p className="mt-2 text-sm" style={dim}>
              {p.domain} · started {fmtDate(p.createdAt)} · {statusLine(p)}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="mono text-xs" style={faint}>
                Auto-deletes {fmtDate(p.deletesAt)}
              </span>
              <span className="ml-auto flex items-center gap-6">
                <Link
                  href={`/governance/${p.id}`}
                  className={`btn btn--text no-underline${p.status === "review" ? " text-sand" : ""}`}
                >
                  {openLabel(p.status)}
                </Link>
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={() =>
                    setDeletePending(deletePending === p.id ? null : p.id)
                  }
                  aria-expanded={deletePending === p.id}
                >
                  Delete
                </button>
              </span>
            </div>
            {deletePending === p.id && (
              <div className="panel--raised mt-4 border p-4" style={{ borderColor: "var(--xl-line)" }}>
                <p className="text-sm">
                  This deletes the project now, not in 30 days. Download first
                  if you want to keep it.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-6">
                  <button
                    type="button"
                    className="btn"
                    style={{
                      borderColor: "var(--xl-danger)",
                      color: "var(--xl-danger)",
                    }}
                    disabled={deleteBusy}
                    onClick={() => void confirmDelete(p.id)}
                  >
                    {deleteBusy ? "Deleting..." : "Delete now"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--text"
                    onClick={() => setDeletePending(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </section>

      <hr className="rule" />

      {/* Create panel */}
      <section aria-label="Start a new project" id="new">
        <h2 className="text-center">Start a new project</h2>
        <div className="mt-8 grid grid--2" role="group" aria-label="Document type">
          {GOVERNANCE_KINDS.map((k) => {
            const meta = KIND_LABELS[k];
            const selected = kind === k;
            return (
              <button
                key={k}
                type="button"
                className={`panel text-left${selected ? " panel--lightline" : ""}`}
                aria-pressed={selected}
                onClick={() => setKind(k)}
                style={selected ? { borderColor: "var(--xl-light-dim)" } : undefined}
              >
                <span className={`badge${k === "usage_policy" ? " badge--light" : ""}`}>
                  {meta.badge}
                </span>
                <span className="doc-h mt-4 block text-lg">{meta.name}</span>
                <span className="mt-2 block text-sm" style={dim}>
                  {meta.blurb}
                </span>
                {selected && (
                  <span className="mt-3 block text-xs" style={{ color: "var(--xl-light)" }}>
                    Selected
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {kind && (
          <div className="panel panel--raised mt-6 space-y-6">
            {editingDomain ? (
              <div className="field max-w-sm">
                <label htmlFor="gov-domain">Researching</label>
                {defaultDomain === "" && (
                  <p className="text-sm">
                    You signed in with a personal address. What is your
                    company&apos;s website?
                  </p>
                )}
                <input
                  id="gov-domain"
                  className="input"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="company.com"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <span
                  className="text-xs font-medium uppercase"
                  style={{ ...faint, letterSpacing: "0.3em" }}
                >
                  Researching
                </span>
                <span className="mono">{domain}</span>
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={() => setEditingDomain(true)}
                >
                  Change
                </button>
              </div>
            )}

            <p className="text-sm">
              Tron researches {domain.trim() || "your company"} before asking
              you anything: your site, pages and articles that mention you,
              and your industry.
            </p>

            <div className="space-y-3 text-sm" style={dim}>
              <p>{DELETION_NOTICE}</p>
              <p>{AI_PROCESSING_NOTICE}</p>
            </div>

            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0"
                checked={ack}
                onChange={(e) => {
                  setAck(e.target.checked);
                  if (e.target.checked) setAckHint(false);
                }}
              />
              <span>{ACK_TEXT}</span>
            </label>
            {ackHint && !ack && (
              <p className="text-sm" role="alert" style={{ color: "var(--xl-warn)" }}>
                Please check the acknowledgment to continue.
              </p>
            )}

            {createError && (
              <p className="text-sm" role="alert" style={{ color: "var(--xl-danger)" }}>
                {createError.message}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-6">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void create()}
                disabled={creating}
              >
                {creating ? "Starting..." : "Start research"}
              </button>
              <button
                type="button"
                className="btn btn--text"
                onClick={() => {
                  setKind(null);
                  setCreateError(null);
                  setAckHint(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
