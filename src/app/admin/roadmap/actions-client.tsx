"use client";

// Mutating controls for /admin/roadmap (§5.18). Every POST hits the
// requireGlobalAdmin-guarded dispatch route; this island only carries
// clicks. Two render modes: the request queue (approve/deny) on the list
// page, and the company controls (suspend, rename, grant/revoke admin,
// typed-domain purge) on the detail view. AttendanceEditor below is the
// sibling island both detail branches (company uuid AND ?companyId=staff)
// render for the admin-attested paid-step counts.

import { useState } from "react";
import { useRouter } from "next/navigation";

type RequestItem = {
  id: string;
  requesterEmail: string;
  companyName: string;
  companyDomain: string;
  createdAt: string;
};

type CompanyItem = {
  id: string;
  domain: string;
  name: string;
  status: string;
};

type AdminItem = { userId: string; email: string; grantedVia: string };

async function post(body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch("/api/admin/roadmap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const parsed = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return parsed?.error?.message ?? `Failed (${res.status}).`;
  } catch {
    return "Network problem. Try again.";
  }
}

export function RoadmapAdminActions(props: {
  requests?: RequestItem[];
  company?: CompanyItem;
  admins?: AdminItem[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [grantEmail, setGrantEmail] = useState("");
  const [renameTo, setRenameTo] = useState(props.company?.name ?? "");
  const [purgeConfirm, setPurgeConfirm] = useState("");

  async function run(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError("");
    const err = await post(body);
    setBusy(null);
    if (err) setError(err);
    else router.refresh();
  }

  if (props.requests) {
    return (
      <div className="mt-2 space-y-2 text-sm">
        {props.requests.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3">
            <span>
              {r.requesterEmail} → {r.companyName} ({r.companyDomain}),{" "}
              {new Date(r.createdAt).toLocaleDateString("en-US")}
            </span>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy !== null}
              onClick={() =>
                run(`a-${r.id}`, { action: "approve_request", requestId: r.id })
              }
            >
              {busy === `a-${r.id}` ? "..." : "Approve"}
            </button>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy !== null}
              onClick={() =>
                run(`d-${r.id}`, { action: "deny_request", requestId: r.id })
              }
            >
              {busy === `d-${r.id}` ? "..." : "Deny"}
            </button>
          </div>
        ))}
        {error && (
          <p role="alert" style={{ color: "#e5484d" }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  const company = props.company;
  if (!company) return null;
  return (
    <section className="space-y-4 text-sm">
      <h2 className="text-lg font-semibold">Controls</h2>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn--text"
          disabled={busy !== null}
          onClick={() =>
            run("status", {
              action: company.status === "active" ? "suspend" : "activate",
              companyId: company.id,
            })
          }
        >
          {busy === "status"
            ? "..."
            : company.status === "active"
              ? "Suspend company"
              : "Reactivate company"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input"
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
          aria-label="Display name"
        />
        <button
          type="button"
          className="btn btn--text"
          disabled={busy !== null || renameTo.trim().length < 2}
          onClick={() =>
            run("rename", {
              action: "rename",
              companyId: company.id,
              name: renameTo.trim(),
            })
          }
        >
          {busy === "rename" ? "..." : "Rename"}
        </button>
      </div>

      <div>
        <h3 className="font-medium">Company admins</h3>
        <ul className="mt-1 space-y-1">
          {(props.admins ?? []).map((a) => (
            <li key={a.userId} className="flex flex-wrap items-center gap-3">
              <span>
                {a.email}{" "}
                <span className="text-faint">({a.grantedVia})</span>
              </span>
              <button
                type="button"
                className="btn btn--text"
                disabled={busy !== null}
                onClick={() =>
                  run(`rv-${a.userId}`, {
                    action: "revoke_admin",
                    companyId: company.id,
                    targetUserId: a.userId,
                  })
                }
              >
                {busy === `rv-${a.userId}` ? "..." : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="input"
            placeholder={`someone@${company.domain}`}
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            aria-label="Grant admin to email"
          />
          <button
            type="button"
            className="btn btn--text"
            disabled={busy !== null || !grantEmail.includes("@")}
            onClick={() =>
              run("grant", {
                action: "grant_admin",
                companyId: company.id,
                email: grantEmail.trim(),
              })
            }
          >
            {busy === "grant" ? "..." : "Grant admin"}
          </button>
        </div>
      </div>

      <div>
        <h3 className="font-medium">Delete company</h3>
        <p className="text-faint">
          Removes the workspace, directory, documents, requests, and every
          work submission. Type the exact domain ({company.domain}) to
          confirm.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="input"
            value={purgeConfirm}
            onChange={(e) => setPurgeConfirm(e.target.value)}
            aria-label="Type the domain to confirm deletion"
          />
          <button
            type="button"
            className="btn btn--text"
            disabled={busy !== null || purgeConfirm !== company.domain}
            onClick={() =>
              run("purge", {
                action: "purge",
                companyId: company.id,
                confirmDomain: purgeConfirm,
              }).then(() => router.push("/admin/roadmap"))
            }
          >
            {busy === "purge" ? "..." : "Delete company"}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" style={{ color: "#e5484d" }}>
          {error}
        </p>
      )}
    </section>
  );
}

/** Paid-step attendance editor (§5.18): two admin-typed counts per lane.
 * Rendered on BOTH detail branches — companyId is the companies uuid or the
 * literal "staff" for the NULL-lane staff row. Purchases are
 * server-invisible, so these are attested numbers; they are informational
 * only and never light a runway node. Save button uses the
 * aria-disabled + aria-busy idiom (request-form.tsx): the disabled
 * attribute would drop focus mid-press, so the click handler guards
 * instead. */
export function AttendanceEditor(props: {
  companyId: string;
  workshop: number;
  cohort: number;
}) {
  const router = useRouter();
  const [workshop, setWorkshop] = useState(String(props.workshop));
  const [cohort, setCohort] = useState(String(props.cohort));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const w = Number(workshop);
  const c = Number(cohort);
  const valid =
    workshop.trim() !== "" &&
    cohort.trim() !== "" &&
    Number.isInteger(w) &&
    Number.isInteger(c) &&
    w >= 0 &&
    c >= 0 &&
    w <= 100000 &&
    c <= 100000;

  async function save() {
    if (busy || !valid) return;
    setBusy(true);
    setError("");
    setSaved(false);
    const err = await post({
      action: "set_attendance",
      companyId: props.companyId,
      workshopAttended: w,
      cohortAttended: c,
    });
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <section className="space-y-2 text-sm">
      <h2 className="text-lg font-semibold">Attendance</h2>
      <p className="text-faint">
        How many people here have attended the paid training. Typed by an
        XL.net admin; purchases are not visible to this server.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span>Attended Workshop</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            step={1}
            value={workshop}
            onChange={(e) => {
              setWorkshop(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Attended Cohort</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            step={1}
            value={cohort}
            onChange={(e) => {
              setCohort(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn--text"
          aria-disabled={busy || !valid}
          aria-busy={busy}
          onClick={save}
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
      {!valid && (
        <p className="text-faint">
          Counts must be whole numbers between 0 and 100000.
        </p>
      )}
      {saved && !error && <p role="status">Saved.</p>}
      {error && (
        <p role="alert" style={{ color: "#e5484d" }}>
          {error}
        </p>
      )}
    </section>
  );
}
