// /rfp/knowledge (§5.17): the fact corpus, its correction history, the rate
// card, and the intake questionnaire.

import { requireRfpPage } from "@/lib/rfp/access";
import { LocalTime } from "@/components/local-time";
import { KnowledgeNav } from "./nav";
import { AddFact, FactActions, MinimumsEdit, QuestionEdit, RateItemEdit } from "./edit";
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

/**
 * Owner directive 2026-08-26: every stored timestamp a reader sees renders
 * in the VIEWER's zone, with a clock.
 *
 * What stood here was `day()`, returning d.toISOString().slice(0, 10) - the
 * UTC CALENDAR DATE, shown to everyone. Both values it formatted are real
 * instants, not calendar dates (rfp_facts.corrected_at and
 * rfp_rate_cards.effective_from are both `timestamp(..., withTimezone)`), so
 * it was off by a day for any reader west of Greenwich after their local
 * evening: a fact corrected at 02:30Z read "Corrected 2026-07-27" to the
 * Chicago staffer who corrected it at 21:30 on the 26th. The rate card is
 * worse - the seeded effectiveFrom is exactly 2026-01-01T00:00:00.000Z, so
 * "In force from 2026-01-01" was Dec 31 2025 for that reader: the WRONG
 * YEAR. This survived three timezone rounds because toISOString().slice()
 * matches none of the greps that found the rest (not toLocale*, not
 * when()/exact(), not <When>/<LocalTime>).
 *
 * Both values really are Date objects at runtime, which is the precondition
 * for .toISOString() here: correctedFacts() does a plain `db.select()` over
 * rfpFacts and currentRateCard() selects `effectiveFrom: rfpRateCards
 * .effectiveFrom` by COLUMN, so drizzle's PgTimestamp.mapFromDriverValue
 * runs on both. A raw sql<Date> expression does NOT get that mapper and
 * hands back a string - the trap a peer found this round in
 * src/lib/roadmap/db.ts, where .toISOString() would have 500'd the page.
 *
 * <LocalTime> is the helper that crosses a server boundary safely (this is
 * a force-dynamic SERVER component): its useState seed is UTC-pinned, so the
 * SSR string and the first client render match byte for byte, and the swap
 * to the browser's zone happens a tick after hydration. exact() would not
 * work here - it formats in the RUNTIME zone on first render, which during
 * SSR is still the VM.
 */
function stamp(d: Date | null) {
  // Two holes to plug, both of which would take the whole page down rather
  // than degrade: correctedAt is NULLABLE, and an unparseable value throws a
  // RangeError out of .toISOString() (and again out of Intl inside
  // <LocalTime>). Rendering nothing reproduces the old empty-string
  // behaviour exactly and beats a 500. Neither branch is reachable today -
  // correctedFacts() filters on `corrected_at is not null` and
  // effective_from is NOT NULL - so this is a guard, not a display case.
  if (!d || Number.isNaN(d.getTime())) return null;
  return <LocalTime iso={d.toISOString()} withTime />;
}

export default async function RfpKnowledgePage() {
  const gate = await requireRfpPage("/rfp/knowledge");
  if (!gate.ok) return null;
  const admin = gate.user.admin;

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
                  Corrected {stamp(f.correctedAt)} · introduced at KB v
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
              In force from {stamp(card.effectiveFrom)}. Minimum{" "}
              {card.minimumFullyManagedUsers} fully managed users, floor{" "}
              {usd(card.minimumMonthlyFeeCents)} per month. The floor is its own
              figure, not the per-user rate multiplied out.
              {admin && (
                <>
                  {" "}
                  <MinimumsEdit
                    minimumFullyManagedUsers={card.minimumFullyManagedUsers}
                    minimumMonthlyFeeCents={card.minimumMonthlyFeeCents}
                  />
                </>
              )}
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="table table--stack">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Code</th>
                    <th>Unit price</th>
                    <th>Unit</th>
                    {admin && (
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
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
                        {["onboarding", "m365-license"].includes(item.code)
                          ? "computed"
                          : usd(item.unitPriceCents)}
                      </td>
                      <td data-label="Unit" className="text-faint">
                        {item.unit}
                      </td>
                      {admin && (
                        <td data-label="Actions">
                          <RateItemEdit
                            code={item.code}
                            label={item.label}
                            cents={item.unitPriceCents}
                            unit={item.unit}
                            note={item.note}
                            computed={["onboarding", "m365-license"].includes(
                              item.code
                            )}
                          />
                        </td>
                      )}
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
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="doc-h">All live facts</h2>
          {admin && <AddFact />}
        </div>
        <p className="mt-2 text-sm text-faint">
          {facts.length} records. Negative facts are marked: they are records,
          not absences.
          {admin &&
            " Corrections create a new version and retire the old; nothing here edits in place."}
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="table table--stack">
            <thead>
              <tr>
                <th>Key</th>
                <th>Statement</th>
                <th>Category</th>
                <th>Flags</th>
                {admin && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
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
                  {admin && (
                    <td data-label="Actions">
                      <FactActions
                        id={f.id}
                        statement={f.statement}
                        detail={f.detail}
                        polarity={f.polarity}
                        category={f.category}
                      />
                    </td>
                  )}
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
          The reference questionnaire for what a proposal cannot answer from
          the knowledge base alone. The workspace asks its own open questions
          per draft; a fact answer can promote into the corpus once confirmed,
          a choice is per proposal and never does.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="table table--stack">
            <thead>
              <tr>
                <th>Question</th>
                <th>Kind</th>
                <th>Category</th>
                {admin && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
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
                  {admin && (
                    <td data-label="Actions">
                      <QuestionEdit
                        id={q.id}
                        text={q.text}
                        required={q.required}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
