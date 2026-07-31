// /rfp/knowledge (§5.17): the fact corpus, its correction history, the rate
// card, and the intake questionnaire.

import { requireRfpPage } from "@/lib/rfp/access";
import { KnowledgeNav } from "./nav";
import {
  correctedFacts,
  currentKbVersion,
  currentRateCard,
  intakeQuestions,
  liveFacts,
  usd,
} from "@/lib/rfp/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function day(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

export default async function RfpKnowledgePage() {
  const gate = await requireRfpPage("/rfp/knowledge");
  if (!gate.ok) return null;

  let kb: number;
  let facts: Awaited<ReturnType<typeof liveFacts>>;
  let corrected: Awaited<ReturnType<typeof correctedFacts>>;
  let card: Awaited<ReturnType<typeof currentRateCard>>;
  let questions: Awaited<ReturnType<typeof intakeQuestions>>;
  try {
    [kb, facts, corrected, card, questions] = await Promise.all([
      currentKbVersion(),
      liveFacts(),
      correctedFacts(),
      currentRateCard(),
      intakeQuestions(),
    ]);
  } catch {
    return (
      <div className="panel panel--raised">
        <p>
          The knowledge base did not answer. Nothing has been changed. Reload
          the page, and if it keeps failing the database is the place to look.
        </p>
      </div>
    );
  }

  if (facts.length === 0) {
    return (
      <div className="panel panel--raised">
        <p>
          The knowledge base is empty. Facts land here as they are captured,
          and nothing can be cited until they do.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      <KnowledgeNav admin={gate.user.admin} />

      <div>
        <span className="sys-label">Knowledge base · v{kb}</span>
        <p className="mt-4 max-w-2xl">
          Every claim a proposal makes has to trace to a record here. A missing
          fact produces an acknowledged gap, not a plausible sentence.
        </p>
      </div>

      {/* --- corrections ---------------------------------------------- */}
      <section>
        <h2 className="doc-h">Corrected facts</h2>
        <p className="mt-2 text-sm text-faint">
          Facts whose value was wrong and has been fixed. The superseded
          version is retired, never deleted, so an older proposal citing it can
          still be resolved.
        </p>
        {corrected.length === 0 ? (
          <div className="panel mt-4">
            <p className="text-faint">
              No corrections on file. When a fact is corrected here, every
              proposal repeating the old version becomes findable.
            </p>
          </div>
        ) : (
          <div className="panel mt-4">
            {corrected.map((f, i) => (
              <div
                key={f.id}
                className={i > 0 ? "rfp-row" : undefined}
                style={i > 0 ? undefined : { paddingBottom: "1rem" }}
              >
                <div className="mono text-xs" style={{ color: "var(--xl-sand)" }}>
                  {f.key}
                </div>
                <p className="mt-1">{f.statement}</p>
                <div className="mt-1 text-xs text-faint">
                  Corrected {day(f.correctedAt)} · introduced at KB v
                  {f.introducedInKb}
                  {f.detail ? ` · ${f.detail}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- rate card ------------------------------------------------- */}
      <section>
        <h2 className="doc-h">Rate card</h2>
        {!card ? (
          <div className="panel mt-4">
            <p className="text-faint">
              No rate card on file. Pricing blocks cannot be computed until one
              is loaded.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-faint">
              In force from {day(card.effectiveFrom)}. Minimum{" "}
              {card.minimumFullyManagedUsers} fully managed users, floor{" "}
              {usd(card.minimumMonthlyFeeCents)} per month. The floor is its own
              figure, not the per-user rate multiplied out.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="table table--stack">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Code</th>
                    <th>Unit price</th>
                    <th>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {card.items.map((item) => (
                    <tr key={item.code}>
                      <td data-label="Item">
                        {item.label}
                        {item.note && (
                          <div className="text-xs text-faint">{item.note}</div>
                        )}
                      </td>
                      <td data-label="Code" className="mono text-xs">
                        {item.code}
                      </td>
                      <td data-label="Unit price" className="mono">
                        {usd(item.unitPriceCents)}
                      </td>
                      <td data-label="Unit" className="text-faint">
                        {item.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* --- facts ------------------------------------------------------ */}
      <section>
        <h2 className="doc-h">All live facts</h2>
        <p className="mt-2 text-sm text-faint">
          {facts.length} records. Negative facts are marked: they are records,
          not absences.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="table table--stack">
            <thead>
              <tr>
                <th>Key</th>
                <th>Statement</th>
                <th>Category</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => (
                <tr key={f.id}>
                  <td data-label="Key" className="mono text-xs">
                    {f.key}
                  </td>
                  <td data-label="Statement">
                    {f.statement}
                    {f.detail && (
                      <div className="text-xs text-faint">{f.detail}</div>
                    )}
                  </td>
                  <td data-label="Category" className="text-faint text-xs">
                    {f.category}
                  </td>
                  <td data-label="Flags">
                    {f.polarity === "negative" && (
                      <span className="badge">Negative</span>
                    )}{" "}
                    {f.confidence === "needs-adam" && (
                      <span className="badge badge--warn">Unconfirmed</span>
                    )}{" "}
                    {f.correctedAt && (
                      <span className="badge badge--light">Corrected</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* --- intake ----------------------------------------------------- */}
      <section>
        <h2 className="doc-h">Intake questions</h2>
        <p className="mt-2 text-sm text-faint">
          Asked when a proposal needs something the knowledge base cannot
          answer. A fact question can promote into the corpus once confirmed; a
          choice is per proposal and never does.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="table table--stack">
            <thead>
              <tr>
                <th>Question</th>
                <th>Kind</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id}>
                  <td data-label="Question">
                    {q.text}
                    {q.required && (
                      <>
                        {" "}
                        <span className="badge badge--warn">Required</span>
                      </>
                    )}
                  </td>
                  <td data-label="Kind">
                    <span className="badge">{q.kind}</span>
                  </td>
                  <td data-label="Category" className="text-faint text-xs">
                    {q.category}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
