"use client";

// The RFP workspace client island (§5.17).
//
// Two columns at lg: the draft on the left, a three-pane rail on the right.
// Below lg both columns stay MOUNTED and are toggled with hidden/block, so a
// half-typed instruction to Tron survives a tab switch.
//
// EDITING IS PER SECTION AND TEXT ONLY. `cites` and `generatedBy` are never
// sent from here and are re-attached server-side from the stored record.
// Rule A5 only demands citations when generatedBy is "llm", and rule C1's
// staleness sweep joins on cites, so a client that could clear either field
// would quietly launder an uncited claim past both.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { when } from "@/lib/rfp/time";

type Section = {
  label: string;
  title: string;
  paragraphs: string[];
  cites: string[];
  gaps: { question: string; why: string }[];
  generatedBy: "llm" | "human";
  updatedAt: string;
};

type Requirement = {
  id: string;
  structureLabel: string;
  text: string;
  mandatory: boolean;
  kind: string;
};

type Pane = "coverage" | "gate" | "tron";

export function Workspace({
  documentId,
  proposalId,
  structure,
  requirements,
  sections: initial,
  busy: initialBusy,
  genError,
}: {
  documentId: string;
  proposalId: string | null;
  structure: { label: string; title: string }[];
  requirements: Requirement[];
  sections: Section[];
  busy: boolean;
  genError: string | null;
}) {
  const router = useRouter();
  const [sections, setSections] = useState<Section[]>(initial);
  const [pane, setPane] = useState<Pane>("coverage");
  const [mobile, setMobile] = useState<"draft" | Pane>("draft");
  const [busy, setBusy] = useState(initialBusy);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [scope, setScope] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<{
    label: string;
    proposed: string[];
    current: string[];
    note: string;
  } | null>(null);
  const [notice, setNotice] = useState("");

  const covered = new Set(sections.flatMap((s) => [s.label]));

  async function generate(label: string, title: string) {
    setBusy(true);
    setDrafting(label);
    setNotice("");
    const res = await fetch(`/api/rfp/documents/${documentId}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sectionLabel: label, sectionTitle: title }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "That section could not be drafted.");
      setBusy(false);
      setDrafting(null);
      return;
    }
    // Drafting one section measured near 90s, so poll rather than block.
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await fetch(`/api/rfp/documents/${documentId}/status`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (s && s.status !== "drafting") break;
    }
    setBusy(false);
    setDrafting(null);
    router.refresh();
  }

  async function saveEdit(label: string) {
    if (!proposalId) return;
    const paragraphs = editText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, paragraphs }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "That edit was not saved.");
      return;
    }
    setSections((prev) =>
      prev.map((s) => (s.label === label ? { ...s, paragraphs } : s))
    );
    setEditing(null);
    setNotice("");
  }

  async function askTron() {
    if (!proposalId || !scope || instruction.trim().length < 3) return;
    setBusy(true);
    setNotice("");
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: scope, instruction }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "Tron did not answer. Nothing has been changed.");
      return;
    }
    const d = await res.json();
    setProposal({
      label: scope,
      proposed: d.proposed,
      current: d.current,
      note: d.note,
    });
  }

  async function acceptProposal() {
    if (!proposal || !proposalId) return;
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: proposal.label,
        paragraphs: proposal.proposed,
      }),
    });
    if (!res.ok) {
      setNotice("That change was not saved.");
      return;
    }
    setSections((prev) =>
      prev.map((s) =>
        s.label === proposal.label ? { ...s, paragraphs: proposal.proposed } : s
      )
    );
    setProposal(null);
    setInstruction("");
  }

  const totalGaps = sections.reduce((n, s) => n + s.gaps.length, 0);

  return (
    <>
      {notice && (
        <div className="panel panel--lightline-sand" role="status">
          <p>{notice}</p>
        </div>
      )}
      {genError && !notice && (
        <div className="panel panel--lightline-sand">
          <p>{genError}</p>
        </div>
      )}

      {/* Mobile switcher. Both columns stay mounted below. */}
      <nav className="tabstrip mb-4 lg:hidden" aria-label="Workspace panes">
        {(["draft", "coverage", "gate", "tron"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={mobile === k}
            onClick={() => setMobile(k)}
          >
            {k === "draft"
              ? "Draft"
              : k === "coverage"
                ? "Coverage"
                : k === "gate"
                  ? "Checks"
                  : "Tron"}
          </button>
        ))}
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-8">
        {/* ---- the draft ---- */}
        <div
          className={`${mobile === "draft" ? "block" : "hidden"} lg:block min-w-0`}
        >
          {structure.length === 0 ? (
            <div className="panel">
              <p className="text-faint">
                No section structure was found in this RFP. That usually means
                it is a form to fill in rather than a document to write. The
                requirements are still listed under Coverage.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {structure.map((node) => {
                const sec = sections.find((s) => s.label === node.label);
                const isEditing = editing === node.label;
                return (
                  <div className="panel" key={node.label} id={`sec-${node.label}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <span className="sys-label">{node.label}</span>
                        <h3 className="doc-h mt-2">{node.title}</h3>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {sec && (
                          <span className="text-xs text-faint">
                            {when(sec.updatedAt)}
                          </span>
                        )}
                        {!sec ? (
                          <button
                            type="button"
                            className="btn btn--text"
                            disabled={busy}
                            onClick={() => generate(node.label, node.title)}
                          >
                            {drafting === node.label ? "Drafting" : "Draft this"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--text"
                              onClick={() => {
                                setEditing(node.label);
                                setEditText(sec.paragraphs.join("\n\n"));
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--text"
                              onClick={() => {
                                setScope(node.label);
                                setPane("tron");
                                setMobile("tron");
                              }}
                            >
                              Ask Tron
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {drafting === node.label && (
                      <p className="mt-4 text-sm text-faint" role="status">
                        Reading the section and the facts behind it. This takes
                        about a minute.
                      </p>
                    )}

                    {sec && !isEditing && (
                      <div className="mt-4 space-y-3">
                        {sec.paragraphs.map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                        {sec.gaps.length > 0 && (
                          <div className="panel panel--lightline-sand mt-4">
                            <span className="sys-label">
                              Needs an answer before this can go out
                            </span>
                            <ul className="mt-3 space-y-2 text-sm">
                              {sec.gaps.map((g, i) => (
                                <li key={i}>
                                  {g.question}
                                  {g.why && (
                                    <span className="text-faint"> · {g.why}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <p className="text-xs text-faint">
                          {sec.cites.length} fact
                          {sec.cites.length === 1 ? "" : "s"} cited
                        </p>
                      </div>
                    )}

                    {sec && isEditing && (
                      <div className="mt-4 space-y-3">
                        <textarea
                          className="input min-h-64"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                        />
                        <p className="text-xs text-faint">
                          Blank line between paragraphs. The facts this section
                          cites are kept.
                        </p>
                        <div className="flex gap-3">
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => saveEdit(node.label)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {proposal?.label === node.label && (
                      <div className="panel panel--raised mt-4">
                        <span className="sys-label">Tron proposed a change</span>
                        {proposal.note && (
                          <p className="mt-3 text-sm text-faint">
                            {proposal.note}
                          </p>
                        )}
                        <div className="mt-4 space-y-3">
                          {proposal.proposed.map((p, i) => (
                            <p key={i}>{p}</p>
                          ))}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={acceptProposal}
                          >
                            Use this
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            onClick={() => setProposal(null)}
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ---- the rail ---- */}
        <div
          className={`${mobile !== "draft" ? "block" : "hidden"} lg:block rfp-rail min-w-0 mt-8 lg:mt-0`}
        >
          <nav className="tabstrip hidden lg:flex" aria-label="Rail">
            {(["coverage", "gate", "tron"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={pane === k}
                onClick={() => setPane(k)}
              >
                {k === "coverage" ? "Coverage" : k === "gate" ? "Checks" : "Tron"}
              </button>
            ))}
          </nav>

          <div className="panel mt-4">
            {(pane === "coverage" || mobile === "coverage") && (
              <>
                <span className="sys-label">
                  {sections.length} of {structure.length} sections drafted
                </span>
                <p className="mt-3 text-sm text-faint">
                  Every ask the client made, in their words and their order.
                </p>
                <div className="mt-4 max-h-[60vh] overflow-y-auto">
                  {requirements.map((r) => (
                    <div className="rfp-row" key={r.id}>
                      <div className="mono text-xs text-faint">
                        {r.structureLabel}
                      </div>
                      <p className="text-sm">{r.text}</p>
                      <span
                        className={`badge${covered.has(r.structureLabel) ? " badge--ok" : " badge--warn"}`}
                      >
                        {covered.has(r.structureLabel) ? "Drafted" : "Not yet"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(pane === "gate" || mobile === "gate") && (
              <>
                <span className="sys-label">Checks</span>
                <p className="mt-3 text-sm">
                  {totalGaps === 0
                    ? "No open gaps recorded. The compliance rules run against the finished document before anything can leave."
                    : `${totalGaps} open gap${totalGaps === 1 ? "" : "s"} across the draft. Each one is a question the knowledge base could not answer, and a proposal does not go out with them open.`}
                </p>
                <div className="mt-4 space-y-4">
                  {sections
                    .filter((s) => s.gaps.length)
                    .map((s) => (
                      <div key={s.label}>
                        <div className="mono text-xs text-faint">{s.label}</div>
                        <ul className="mt-1 space-y-1 text-sm">
                          {s.gaps.map((g, i) => (
                            <li key={i}>{g.question}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              </>
            )}

            {(pane === "tron" || mobile === "tron") && (
              <>
                <span className="sys-label">Ask Tron for a change</span>
                {scope ? (
                  <p className="mt-3 text-sm">
                    Scope: <span className="mono">{scope}</span>{" "}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setScope(null)}
                    >
                      clear
                    </button>
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-faint">
                    Pick a section with &quot;Ask Tron&quot; first, so the change
                    lands somewhere specific.
                  </p>
                )}
                <textarea
                  className="input mt-4 min-h-32"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Tighten this to three sentences and lead with the response time."
                />
                <p className="mt-2 text-xs text-faint">
                  Tron can reword, tighten, and reorder. It will not add a
                  price, a contract length, or a claim the knowledge base does
                  not support.
                </p>
                <button
                  type="button"
                  className="btn btn--primary mt-4"
                  disabled={busy || !scope || instruction.trim().length < 3}
                  onClick={askTron}
                >
                  {busy ? "Thinking" : "Propose a change"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
