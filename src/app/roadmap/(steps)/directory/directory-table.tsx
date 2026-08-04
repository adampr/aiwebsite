"use client";

// Directory table island (§5.18 step 2). The server page fetches the rows
// with the principal's company id and hydrates this island; every mutation
// posts to the API and then router.refresh(), so the rendered rows are
// always the server's. Members get the same table read-only. Removal is
// two-click, with the suppression checkbox defaulting ON for Apollo-sourced
// rows so a removed person is not resurrected by the next import.
//
// Round 3 auto-init parity: when the server says autoInit (admin + zero
// people + never imported + active + Apollo configured), this island kicks
// ONE {trigger:"auto"} import through the same runImport path and busy UI,
// fenced by the SAME sessionStorage key the hub card uses
// (apolloKickGuardKey), so hub -> step navigation cannot double-kick.
// Auto-lane failures degrade SILENTLY to the normal manual state; the
// Import button stays the retry lever.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apolloKickGuardKey } from "@/lib/roadmap/config";
import { importLine, type ImportResult } from "@/lib/roadmap/apollo-copy";

export type DirectoryPerson = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string;
};

type ApiError = { error?: { code?: string; message?: string } };

const inputCls =
  "w-full rounded-lg border bg-transparent px-2 py-1 text-sm";
const inputStyle = { borderColor: "var(--xl-line)" } as const;

export function DirectoryTable({
  people,
  isAdmin,
  domain,
  autoInit,
}: {
  people: DirectoryPerson[];
  isAdmin: boolean;
  domain: string;
  autoInit: boolean;
}) {
  const router = useRouter();
  const [importBusy, setImportBusy] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [add, setAdd] = useState({ name: "", email: "", phone: "" });
  const [addBusy, setAddBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", email: "", phone: "" });
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [suppress, setSuppress] = useState(false);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowErr, setRowErr] = useState<string | null>(null);

  async function readError(res: Response): Promise<string> {
    const data = (await res.json().catch(() => null)) as ApiError | null;
    return data?.error?.message ?? "Something went wrong. Try again shortly.";
  }

  async function runImport(trigger: "manual" | "auto" = "manual") {
    setImportBusy(true);
    setImportNote(null);
    setImportErr(null);
    try {
      const res = await fetch(
        "/api/roadmap/apollo-import",
        trigger === "auto"
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ trigger: "auto" }),
            }
          : { method: "POST" }
      );
      if (!res.ok) {
        // Auto lane: 429/403/503 and friends degrade SILENTLY to the normal
        // manual state (no error banner); the button is the retry lever.
        if (trigger === "manual") setImportErr(await readError(res));
        return;
      }
      const data = (await res.json().catch(() => null)) as ImportResult | null;
      setImportNote(
        importLine(data ?? {}, domain, "Add people manually below.")
      );
      router.refresh();
    } catch {
      if (trigger === "manual")
        setImportErr(
          "Something went wrong. Check your connection and try again."
        );
    } finally {
      setImportBusy(false);
    }
  }

  // The auto-kick (round 3): once per mount (StrictMode ref guard), fenced
  // by the shared per-domain sessionStorage key, pre-set synchronously
  // BEFORE the POST so a concurrent surface cannot kick again.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoInit || autoRan.current) return;
    autoRan.current = true;
    try {
      const key = apolloKickGuardKey(domain);
      if (window.sessionStorage.getItem(key) !== null) return;
      window.sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // No sessionStorage means no reload fence: do not kick.
      return;
    }
    // Deferred a tick (codebase pattern: open-items-resolver) so the effect
    // body stays setState-free; the guard above already ran synchronously.
    // No cleanup cancel: StrictMode's immediate unmount would eat the only
    // kick (the ref guard blocks the remount's attempt).
    window.setTimeout(() => void runImport("auto"), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoInit, domain]);

  async function addPerson(e: React.FormEvent) {
    e.preventDefault();
    setAddBusy(true);
    setRowErr(null);
    try {
      const res = await fetch("/api/roadmap/directory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: add.name,
          email: add.email || null,
          phone: add.phone || null,
        }),
      });
      if (!res.ok) {
        setRowErr(await readError(res));
        return;
      }
      setAdd({ name: "", email: "", phone: "" });
      router.refresh();
    } catch {
      setRowErr("Something went wrong. Check your connection and try again.");
    } finally {
      setAddBusy(false);
    }
  }

  function startEdit(p: DirectoryPerson) {
    setEditId(p.id);
    setRemoveId(null);
    setRowErr(null);
    setEdit({ name: p.name, email: p.email ?? "", phone: p.phone ?? "" });
  }

  async function saveEdit(id: string) {
    setRowBusy(true);
    setRowErr(null);
    try {
      const res = await fetch(`/api/roadmap/directory/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: edit.name,
          email: edit.email || null,
          phone: edit.phone || null,
        }),
      });
      if (!res.ok) {
        setRowErr(await readError(res));
        return;
      }
      setEditId(null);
      router.refresh();
    } catch {
      setRowErr("Something went wrong. Check your connection and try again.");
    } finally {
      setRowBusy(false);
    }
  }

  function armRemove(p: DirectoryPerson) {
    setRemoveId(p.id);
    setEditId(null);
    setRowErr(null);
    setSuppress(p.source === "apollo");
  }

  async function confirmRemove(id: string) {
    setRowBusy(true);
    setRowErr(null);
    try {
      const res = await fetch(
        `/api/roadmap/directory/${id}${suppress ? "" : "?suppress=0"}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setRowErr(await readError(res));
        return;
      }
      setRemoveId(null);
      router.refresh();
    } catch {
      setRowErr("Something went wrong. Check your connection and try again.");
    } finally {
      setRowBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      {isAdmin && (
        <div className="panel">
          <span className="sys-label">Import</span>
          <p className="mt-3 text-sm">
            Import only people you are authorized to list. Directory entries
            are visible to everyone at {domain} who signs in, and to XL.net.
          </p>
          <button
            type="button"
            className="btn mt-4"
            disabled={importBusy}
            aria-busy={importBusy}
            onClick={() => void runImport("manual")}
          >
            {importBusy ? "Importing..." : "Import from Apollo"}
          </button>
          {importNote && (
            <p role="status" className="mono mt-3 text-xs text-faint">
              {importNote}
            </p>
          )}
          {importErr && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {importErr}
            </p>
          )}
          {/* Persistent review duty (round 3): always visible in the import
              area, not only after a run. */}
          <p className="mt-3 text-xs text-faint">
            Review the results and remove anyone you are not authorized to
            list. Removals survive future imports.
          </p>
        </div>
      )}

      {isAdmin && (
        <form onSubmit={addPerson} className="panel">
          <span className="sys-label">Add Person</span>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className={inputCls}
              style={inputStyle}
              value={add.name}
              onChange={(e) => setAdd({ ...add, name: e.target.value })}
              placeholder="Name"
              aria-label="Name"
              required
            />
            <input
              className={inputCls}
              style={inputStyle}
              type="email"
              value={add.email}
              onChange={(e) => setAdd({ ...add, email: e.target.value })}
              placeholder="Email (optional)"
              aria-label="Email"
            />
            <input
              className={inputCls}
              style={inputStyle}
              value={add.phone}
              onChange={(e) => setAdd({ ...add, phone: e.target.value })}
              placeholder="Phone (optional)"
              aria-label="Phone"
            />
            <button
              type="submit"
              className="btn"
              disabled={addBusy}
              aria-busy={addBusy}
            >
              {addBusy ? "Adding..." : "Add"}
            </button>
          </div>
        </form>
      )}

      {rowErr && (
        <p role="alert" className="text-sm text-red-400">
          {rowErr}
        </p>
      )}

      {people.length === 0 ? (
        <p className="text-sm text-faint">
          No one listed yet. {isAdmin ? "Import your team from Apollo or add the first person above." : "Your company admin adds people here."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="mono text-xs uppercase tracking-[0.2em] text-faint">
                <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                  Name
                </th>
                <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                  Email
                </th>
                <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                  Phone
                </th>
                {isAdmin && (
                  <th className="border-b border-[var(--xl-line)] py-2 font-normal">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="align-top">
                  {editId === p.id ? (
                    <>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        <input
                          className={inputCls}
                          style={inputStyle}
                          value={edit.name}
                          onChange={(e) =>
                            setEdit({ ...edit, name: e.target.value })
                          }
                          aria-label="Name"
                        />
                      </td>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        <input
                          className={inputCls}
                          style={inputStyle}
                          type="email"
                          value={edit.email}
                          onChange={(e) =>
                            setEdit({ ...edit, email: e.target.value })
                          }
                          aria-label="Email"
                        />
                      </td>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        <input
                          className={inputCls}
                          style={inputStyle}
                          value={edit.phone}
                          onChange={(e) =>
                            setEdit({ ...edit, phone: e.target.value })
                          }
                          aria-label="Phone"
                        />
                      </td>
                      <td className="border-b border-[var(--xl-line)] py-2">
                        <span className="inline-flex gap-3">
                          <button
                            type="button"
                            className="btn btn--text"
                            disabled={rowBusy}
                            onClick={() => void saveEdit(p.id)}
                          >
                            {rowBusy ? "Saving..." : "Save"}
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            disabled={rowBusy}
                            onClick={() => setEditId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        {p.name}
                      </td>
                      <td className="mono border-b border-[var(--xl-line)] py-2 pr-4 text-xs">
                        {p.email ?? ""}
                      </td>
                      <td className="mono border-b border-[var(--xl-line)] py-2 pr-4 text-xs">
                        {p.phone ?? ""}
                      </td>
                      {isAdmin && (
                        <td className="border-b border-[var(--xl-line)] py-2">
                          {removeId === p.id ? (
                            <span className="inline-flex flex-wrap items-center gap-3">
                              <label className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={suppress}
                                  onChange={(e) =>
                                    setSuppress(e.target.checked)
                                  }
                                />
                                and keep them out of future imports
                              </label>
                              <button
                                type="button"
                                className="btn btn--text"
                                disabled={rowBusy}
                                onClick={() => void confirmRemove(p.id)}
                              >
                                {rowBusy ? "Removing..." : "Confirm remove"}
                              </button>
                              <button
                                type="button"
                                className="btn btn--text"
                                disabled={rowBusy}
                                onClick={() => setRemoveId(null)}
                              >
                                Keep
                              </button>
                            </span>
                          ) : (
                            <span className="inline-flex gap-3">
                              <button
                                type="button"
                                className="btn btn--text"
                                onClick={() => startEdit(p)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn--text"
                                onClick={() => armRemove(p)}
                              >
                                Remove
                              </button>
                            </span>
                          )}
                        </td>
                      )}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
