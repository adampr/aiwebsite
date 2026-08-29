"use client";

// The one submission form (§5.16), shared by the /work dialog and the
// /work/submit page so validation and microcopy cannot fork. The client
// never gates anything: every check here is a convenience copy of a
// server-enforced rule.
//
// context="page": success shows a notice above the form, fields reset, and
// onSubmitted fires (the page refreshes its status list).
// context="dialog": success REPLACES the form in place (the dialog stays
// open so the handoff link is read); state is never reset on dialog close,
// so a typed draft survives an accidental Esc.
//
// There is NO kind control on this form (owner directive 2026-08-28: "for
// submit, no longer ask if its CoWork or Code program. Figure out which is
// based on what was uploaded"). Two radio buttons stood here for months and
// people picked the wrong one often enough to matter: three of the 85 rows
// on production were filed as CoWork Skills while the package was plainly a
// Claude Code program. src/lib/work/classify.ts reads the files and decides,
// and this form cannot help it: the browser never opens the archive, so
// every label, hint and error below has to be true of both shapes at once.
// The single place a kind is still named is the update banner, where the
// kind belongs to the published card being replaced and the server pins it.

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { EMAIL_PROMISE } from "@/lib/work/config";
import {
  parseTimeSavedHours,
  TIME_SAVED_MAX_HOURS,
} from "@/lib/work/time-saved";
import { ReviewProgress } from "./review-progress";

// QUEUED_NOTICE and OK_NOTICE are gone (2026-08-25 round). Both were dead
// sentences: they described a state once, at the moment of the 202, and then
// sat there unchanged for however many minutes the review took. The live
// <ReviewProgress> tracker below says the same things and keeps saying them.
const OK_NOTICE_UPDATE =
  "Received. The panel is reviewing your update; if it passes, it waits for Adam's approval before the live card changes.";
const PAGE_NOTICE =
  "Received. It is at the top of your submissions below, with live progress.";

interface SubmissionFormProps {
  context: "page" | "dialog";
  /** The new row's id, so the page list can start watching it immediately. */
  onSubmitted?: (id?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onClose?: () => void; // dialog only
  /** §5.16 update mode: the published card being updated. Title and kind
   * are pinned server-side; the form shows them locked and never sends
   * either field (the update route 400s on a typed value). The kind lives on
   * this prop and nowhere else on the form: a card's kind is a property of
   * the card, so an update to it is not open to re-inference, while a fresh
   * submission has no kind until the server has read the package. */
  updateTarget?: {
    id: string;
    title: string;
    kind: "skill" | "program";
  } | null;
  /** §5.18 company reuse: where "track it" points. Defaults keep every /work
   * usage byte-identical; /roadmap/work passes its own values. */
  trackHref?: string;
  /** Credit fallback named in the attribution placeholder. */
  creditTeamName?: string;
  /** The retention fine print (the staff default names Adam; company copy
   * must not). */
  retentionLine?: string;
  /** Which lane the tracker's terminal and next-step copy speaks for.
   * EXPLICIT, never inferred from trackHref: a lane is an authorization fact
   * and a href is a string a caller may change for any reason. */
  lane?: "internal" | "company";
}

export function SubmissionForm({
  context,
  onSubmitted,
  onBusyChange,
  onClose,
  updateTarget = null,
  trackHref = "/work/submit",
  creditTeamName = "the XL.net team",
  retentionLine = "Files that look like credentials are cleaned out of your upload before it is stored. Only document text is kept for review; the files are emailed to Adam when the card publishes.",
  lane = "internal",
}: SubmissionFormProps) {
  const [title, setTitle] = useState("");
  const [blurb, setBlurb] = useState("");
  const [attribution, setAttribution] = useState("");
  // §5.16 time saved (owner ask 2026-08-27). A STRING, never a number: this
  // is the raw input value, and holding it as a number would turn a
  // half-typed "6." into NaN and wipe the caret out from under the person
  // typing it. The one parse happens on submit, through the same module the
  // route uses.
  const [timeSavedHours, setTimeSavedHours] = useState("");
  const [pkg, setPkg] = useState<File | null>(null);
  const [skillMd, setSkillMd] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverPaths, setServerPaths] = useState<string[]>([]);
  // The refusal REASON, not a boolean. `Boolean(data?.queued)` is what
  // destroyed it before: the one word that would have told a submitter a site
  // update was finishing already travelled over the wire in the 202 body and
  // the client threw it away on arrival.
  const [done, setDone] = useState<null | {
    id: string | null;
    queued: string | null;
    /** Set when the intake scan cleaned the upload. Rendered on BOTH surfaces:
     * the submitter has to learn that we changed their files and that they
     * still need to rotate whatever was in them. */
    cleaned: { message: string; paths: string[] } | null;
  }>(null);
  const pkgRef = useRef<HTMLInputElement>(null);
  const mdRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uid = useId();

  // A landed file clears that field's error immediately (a red border with
  // a green check until the next submit is a contradiction; design-critic
  // ruling 2026-07-30).
  const takePkg = (f: File | null) => {
    setPkg(f);
    if (f)
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.pkg;
        return next;
      });
  };
  const takeMd = (f: File | null) => setSkillMd(f);

  const setBusyBoth = (b: boolean) => {
    setBusy(b);
    onBusyChange?.(b);
  };

  function resetForm() {
    setTitle("");
    setBlurb("");
    setAttribution("");
    setTimeSavedHours("");
    setPkg(null);
    setSkillMd(null);
    setFieldErrors({});
    setServerError(null);
    setServerPaths([]);
    if (pkgRef.current) pkgRef.current.value = "";
    if (mdRef.current) mdRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setServerPaths([]);
    const errs: Record<string, string> = {};
    if (!pkg) errs.pkg = "Attach your package (.zip or .skill).";
    // The document field is optional (the package usually carries the doc);
    // only the server can see inside the archive, so no client check exists.
    //
    // Time saved IS checked here, and the reason is narrower than the one
    // this comment used to give. It claimed the check spares the submitter a
    // 100 MB upload the route would only refuse afterwards; in a browser it
    // almost never does, because an <input type="number"> hands back "" for
    // anything it cannot parse (so "6 hourss" never survives the field) and
    // the native min/max on that input already refuse the out-of-range
    // values the parser refuses. The branch STAYS, for the two things it
    // still does: it is belt and braces for a value that reaches state
    // without passing through the field's sanitizer (autofill, a paste
    // handled oddly, a browser that behaves differently), and it is the SAME
    // function the route calls, so whichever side does the refusing, the
    // person reads one sentence and not two that can drift apart.
    const timeSaved = parseTimeSavedHours(
      updateTarget ? "" : timeSavedHours
    );
    if (!timeSaved.ok) errs.timeSaved = timeSaved.message;
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      // The FIRST failing field in DOM order takes focus, not always the
      // package: the hours input sits above the upload zone, and sending
      // focus past a field that is flagged red is how a keyboard user ends
      // up never finding the thing that refused them.
      if (errs.timeSaved) timeRef.current?.focus();
      else pkgRef.current?.focus();
      return;
    }
    setBusyBoth(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const form = new FormData();
      // No "kind" field, on either lane. On a create the server infers it
      // from the package; on an update it is pinned to the parent row, and
      // that route refuses a value that disagrees with the card. Sending a
      // guess from here could only ever be wrong or redundant.
      if (!updateTarget) form.set("title", title);
      form.set("blurb", blurb);
      form.set("attribution", attribution);
      // Only when non-empty, and never in update mode. An empty string would
      // parse to "not reported" and be harmless, but a field that is absent
      // from the body is the honest description of a field nobody filled in,
      // and it keeps the update lane's FormData byte-identical to what it
      // sent before this round (that route ignores the key; the child picks
      // the live parent's figure up at swap time instead, in
      // publishWithSupersede).
      if (!updateTarget && timeSavedHours.trim() !== "")
        form.set("timeSavedHours", timeSavedHours.trim());
      form.set("file", pkg as File);
      // "skillMd" is the historical wire name, kept on purpose. The field is
      // now the generic standalone reviewed document (a SKILL.md or an
      // architecture doc, whichever the package is short of), and renaming it
      // would mean changing the create route, the update route and the email
      // lane's equivalent in lockstep for the sake of a label nobody sees.
      if (skillMd) form.set("skillMd", skillMd);
      const res = await fetch(
        updateTarget
          ? `/api/work/submissions/${updateTarget.id}/update`
          : "/api/work/submissions",
        {
          method: "POST",
          body: form,
          signal: ctrl.signal,
        }
      );
      const data = (await res.json().catch(() => null)) as {
        id?: string;
        error?: { code?: string; message?: string; paths?: string[] };
        queued?: string | null;
        cleaned?: { message: string; paths: string[] } | null;
      } | null;
      if (!res.ok) {
        // Server 422s carry instructional copy; render it verbatim.
        setServerError(
          data?.error?.message ?? "Something went wrong. Try again shortly."
        );
        setServerPaths(data?.error?.paths ?? []);
        return;
      }
      setDone({
        id: data?.id ?? null,
        queued: data?.queued ?? null,
        cleaned: data?.cleaned ?? null,
      });
      if (context === "page") resetForm();
      onSubmitted?.(data?.id);
    } catch {
      setServerError(
        "The upload did not complete. Check your connection and try again; your entries are still here."
      );
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
      setBusyBoth(false);
    }
  }

  const inputCls = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";
  const inputStyle = { borderColor: "var(--xl-line)" } as const;
  const labelCls = "mono text-xs uppercase tracking-[0.2em] text-light";

  // Dialog success state replaces the form, and now TRACKS the run in place
  // instead of handing off to a page that used to be just as static.
  if (done && context === "dialog") {
    return (
      <DialogDone
        id={done.id}
        queued={done.queued}
        cleaned={done.cleaned}
        lane={lane}
        trackHref={trackHref}
        onAnother={() => {
          setDone(null);
          resetForm();
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {done && context === "page" && (
        <div role="status" className="space-y-1">
          <p className="text-sm">
            {updateTarget ? OK_NOTICE_UPDATE : PAGE_NOTICE}
          </p>
          <p className="text-xs text-faint">{EMAIL_PROMISE}</p>
          {done.cleaned && <CleanedNotice cleaned={done.cleaned} />}
        </div>
      )}
      {updateTarget ? (
        <div className="space-y-2">
          <p className="text-sm">
            Updating the published card{" "}
            <span className="font-medium">{updateTarget.title}</span> (
            {updateTarget.kind === "skill" ? "CoWork Skill" : "Code program"}
            ).
          </p>
          <p className="text-xs text-faint">
            Updates keep the card&apos;s title and kind; renaming stays admin
            only. Attach the full new package, not a changelog. The live card
            stays up until Adam approves the reviewed update.
          </p>
        </div>
      ) : (
        <div>
          <label className={labelCls}>Title</label>
          <input
            className={inputCls}
            style={inputStyle}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            minLength={4}
            maxLength={60}
            required
            placeholder="What the tool is called"
          />
        </div>
      )}
      <div>
        <label className={labelCls}>One paragraph (optional)</label>
        <textarea
          className={inputCls}
          style={inputStyle}
          value={blurb}
          onChange={(e) => setBlurb(e.target.value)}
          maxLength={5000}
          rows={4}
          placeholder="Optional context: what it does, who uses it, what it replaced (up to 5000 characters). The card's claims come from your documents."
        />
      </div>
      {/* §5.16 time saved (owner ask 2026-08-27), optional at submission
          time. It sits between the paragraph and the upload because it is a
          fact about the WORK, not about the files, and because the person is
          still thinking in prose here rather than hunting for a .zip.

          HIDDEN in update mode, and that is the whole design of the update
          lane for this field: an update is reviewed as a fresh row, so an
          empty box on the update form would be read by the route as "clear
          it" and would silently strip the figure off a live card the moment
          the swap was approved. Instead the child INHERITS the parent's
          figure at swap time (publishWithSupersede reads the live parent
          under FOR UPDATE and carries its value over, so a correction made
          on the live card while the update waited is the one that
          publishes), and the owner edits it on the row afterwards (the
          editor on the submissions list), where there is exactly one
          meaning for an empty field. */}
      {!updateTarget && (
        <div>
          <label htmlFor={`${uid}-timesaved`} className={labelCls}>
            Time saved per month for you (optional)
          </label>
          <input
            id={`${uid}-timesaved`}
            ref={timeRef}
            className={inputCls}
            style={inputStyle}
            type="number"
            // inputMode on top of type="number": a phone keypad that opens
            // without a decimal point makes "6.5" untypeable, which is the
            // most common answer this field will ever get.
            inputMode="decimal"
            min={0}
            // The constant, never a literal 744: the parser refuses above it
            // and migration 0049's CHECK refuses above its minute twin, so a
            // hand-typed ceiling here would drift into a browser that accepts
            // a value the server then rejects.
            max={TIME_SAVED_MAX_HOURS}
            // "any", never a step grid. This input lives inside a real
            // <form onSubmit> with no noValidate, so the browser runs
            // constraint validation BEFORE the handler: with step=0.25 a
            // submitter who typed 6.3, filled in the rest and attached a
            // package was refused ("the two nearest valid values are 6.25
            // and 6.5") for a value parseTimeSavedHours accepts happily and
            // the editor on the submissions list saves without a word. The
            // parser is the single arbiter of what this field means; min and
            // max stay because they agree with it exactly.
            step="any"
            value={timeSavedHours}
            onChange={(e) => {
              setTimeSavedHours(e.target.value);
              // Clear the refusal as soon as the value changes: a field
              // still flagged red while it now holds a fine value is the
              // same contradiction the file-drop rule above names.
              if (fieldErrors.timeSaved)
                setFieldErrors((prev) => {
                  const next = { ...prev };
                  delete next.timeSaved;
                  return next;
                });
            }}
            aria-describedby={
              fieldErrors.timeSaved
                ? `${uid}-timesaved-error ${uid}-timesaved-help`
                : `${uid}-timesaved-help`
            }
            aria-invalid={Boolean(fieldErrors.timeSaved)}
            placeholder="Hours a month, for example 6, 6.5, or 0.75"
          />
          {fieldErrors.timeSaved && (
            <p
              id={`${uid}-timesaved-error`}
              className="mt-1 text-xs text-red-400"
            >
              {fieldErrors.timeSaved}
            </p>
          )}
          {/* Lane-neutral on purpose: this component renders on /work, in the
              /work dialog and inside the company dialog on /roadmap/work, so
              naming "the Our Work page" here would be false for a company
              submitter. "Your published card" is true in every lane. */}
          <p id={`${uid}-timesaved-help`} className="mt-2 text-xs text-faint">
            Your own estimate of the time this saves you in a typical month.
            Once your card is published the figure shows on it, said to be
            reported by you, and it is added to your total on the scorecard.
            Leave it empty if you do not have a figure yet; you can add it or
            change it later on this submission.
          </p>
        </div>
      )}
      <div>
        <span id={`${uid}-pkg-label`} className={labelCls}>
          Your package (.zip or .skill)
        </span>
        <label
          className={
            "file-drop mt-2" +
            (fieldErrors.pkg ? " file-drop--error" : "") +
            (pkg ? " file-drop--filled" : "")
          }
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // The bordered zone invites drops; an unhandled drop would
            // navigate the browser away and destroy the draft.
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files?.length && pkgRef.current) {
              pkgRef.current.files = files;
              takePkg(files[0]);
            }
          }}
        >
          <input
            ref={pkgRef}
            type="file"
            accept=".zip,.skill"
            aria-labelledby={`${uid}-pkg-label`}
            aria-describedby={
              fieldErrors.pkg
                ? `${uid}-pkg-error ${uid}-pkg-help`
                : `${uid}-pkg-help`
            }
            aria-invalid={Boolean(fieldErrors.pkg)}
            onChange={(e) => takePkg(e.target.files?.[0] ?? null)}
          />
          <span className="file-drop-glyph" aria-hidden="true">
            {pkg ? "✓" : "+"}
          </span>
          {pkg ? (
            <>
              <span className="file-drop-name">{pkg.name}</span>
              <span className="file-drop-cta">Replace</span>
            </>
          ) : (
            <>
              <span className="file-drop-cta">Choose file</span>
              <span className="mono text-xs text-faint">.zip or .skill</span>
            </>
          )}
        </label>
        {fieldErrors.pkg && (
          <p id={`${uid}-pkg-error`} className="mt-1 text-xs text-red-400">
            {fieldErrors.pkg}
          </p>
        )}
        {/* The single most-read paragraph on the page, and the one thing
            standing between a submitter and a 422. It has to serve both
            shapes at once now that nobody declares which they are sending,
            so it names what each shape must CONTAIN rather than which button
            to press: the refusals people actually hit are "no SKILL.md
            found" and "no architecture document", and both are avoidable by
            whoever reads this before choosing a file. */}
        <p id={`${uid}-pkg-help`} className="mt-2 text-xs text-faint">
          Upload the whole package.{" "}
          {/* Only on a create. On an update the kind is pinned to the card
              and the banner above says so, so telling that submitter their
              files decide it would contradict the sentence they just read. */}
          {!updateTarget && (
            <>
              Whether it is a Skill or a program is read off the files, so
              there is nothing to pick.{" "}
            </>
          )}
          A Skill needs its SKILL.md at the top level or one folder deep, or
          the package can be a .skill, or a .zip holding one. A program needs
          an architecture.md (or ARCHITECTURE.md, design.md, or a README.md
          with an Architecture section) at the top level or one folder deep:
          what it does, its components, how data flows. Max 100 MB.
        </p>
      </div>
      {/* ALWAYS rendered, where it used to appear only for a Skill. Hiding
          it behind the kind was only possible while the submitter declared
          one, and it left the program lane with no way out of a hard refusal:
          a program whose architecture doc was not in the zip had nothing it
          could attach, so the rescue that Skills had always enjoyed did not
          exist for it. Both routes now take this file for either kind. */}
      <div>
        <span id={`${uid}-md-label`} className={labelCls}>
          SKILL.md or architecture doc (optional)
        </span>
        <label
          className={"file-drop mt-2" + (skillMd ? " file-drop--filled" : "")}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files?.length && mdRef.current) {
              mdRef.current.files = files;
              takeMd(files[0]);
            }
          }}
        >
          <input
            ref={mdRef}
            type="file"
            accept=".md,.mdx,.markdown"
            aria-labelledby={`${uid}-md-label`}
            aria-describedby={`${uid}-md-help`}
            onChange={(e) => takeMd(e.target.files?.[0] ?? null)}
          />
          <span className="file-drop-glyph" aria-hidden="true">
            {skillMd ? "✓" : "+"}
          </span>
          {skillMd ? (
            <>
              <span className="file-drop-name">{skillMd.name}</span>
              <span className="file-drop-cta">Replace</span>
            </>
          ) : (
            <>
              <span className="file-drop-cta">Choose file</span>
              <span className="mono text-xs text-faint">.md (optional)</span>
            </>
          )}
        </label>
        <p id={`${uid}-md-help`} className="mt-2 text-xs text-faint">
          Skip this if your package already carries the document the panel
          should read, a SKILL.md for a Skill or an architecture doc for a
          program. Attach one here when it does not, or when you want the
          panel to review this exact text; a file attached here wins over the
          copy inside the package. Max 1 MB.
        </p>
      </div>
      <p className="text-xs text-faint">{retentionLine}</p>
      <div>
        <label className={labelCls}>Public credit (optional)</label>
        <input
          className={inputCls}
          style={inputStyle}
          value={attribution}
          onChange={(e) => setAttribution(e.target.value)}
          maxLength={20}
          placeholder={`First name only. Empty publishes as ${creditTeamName}.`}
        />
      </div>
      {serverError && (
        <div role="alert" className="text-sm text-red-400">
          <p>{serverError}</p>
          {serverPaths.length > 0 && (
            <ul className="mono mt-1 text-xs">
              {serverPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" className="btn" disabled={busy}>
          {busy
            ? "Uploading..."
            : updateTarget
              ? "Submit update"
              : "Submit for review"}
        </button>
        {busy && (
          <button
            type="button"
            className="btn btn--text"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel upload
          </button>
        )}
        {!busy && context === "dialog" && onClose && (
          <button type="button" className="btn btn--text" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The dialog's post-submit branch, extracted so its focus effect can run
 * ONCE, when the branch mounts.
 *
 * The bug this replaces was `ref={(el) => el?.focus()}` on the notice: a ref
 * callback runs on EVERY render, so once the live tracker started polling
 * inside this branch, focus was yanked back roughly six times a minute for
 * the whole review. The WRAPPER takes focus, never the role="status" element:
 * focusing a live region makes screen readers announce it twice. */
/** The intake-cleaning disclosure, shared by both success surfaces.
 *
 * role="alert", not "status": in the dialog this sits in the same subtree as
 * the live review tracker, which repaints several times a minute, and a polite
 * region competing with that is a region nobody hears. This is also the only
 * copy in the whole flow that asks the submitter to go and do something
 * outside the site, which is what earns the interruption. */
function CleanedNotice({
  cleaned,
}: {
  cleaned: { message: string; paths: string[] };
}) {
  return (
    <div role="alert" className="space-y-1">
      <p className="text-sm">{cleaned.message}</p>
      {cleaned.paths.length > 0 && (
        <ul className="mono text-xs text-faint">
          {cleaned.paths.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DialogDone({
  id,
  queued,
  cleaned,
  lane,
  trackHref,
  onAnother,
  onClose,
}: {
  id: string | null;
  queued: string | null;
  cleaned: { message: string; paths: string[] } | null;
  lane: "internal" | "company";
  trackHref: string;
  onAnother: () => void;
  onClose?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wrapRef.current?.focus();
  }, []);
  return (
    <div ref={wrapRef} tabIndex={-1} className="space-y-5">
      <p className="text-sm">Received. This updates on its own while you watch.</p>
      {/* ABOVE the tracker on purpose. The wrapper takes focus on mount, so a
          screen reader reaches the cleaning notice before the live region
          starts repainting, and a sighted reader meets the one instruction
          that needs acting on before the progress copy. */}
      {cleaned && <CleanedNotice cleaned={cleaned} />}
      {/* initialQueueReason is the reason from the 202 body, so the FIRST
          second reads correctly, before any poll has run. */}
      {id && (
        <ReviewProgress id={id} lane={lane} initialQueueReason={queued} />
      )}
      <p className="text-xs text-faint">{EMAIL_PROMISE}</p>
      <div className="flex flex-wrap gap-4">
        <Link href={trackHref} className="btn no-underline">
          Track it on your submissions page
        </Link>
        <button type="button" className="btn btn--text" onClick={onAnother}>
          Submit another
        </button>
        {onClose && (
          <button type="button" className="btn btn--text" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
