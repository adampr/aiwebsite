// "Time saved per month for you" (§5.16 / §5.18, owner ask 2026-08-27): the
// ONE parse/format module for the self-reported figure on a work submission.
//
// PURE ON PURPOSE. Nothing here may import the DB, the session, `node:*`, or
// anything from src/lib/work/http.ts: the submit form, the submissions list
// and the roadmap work island are all client components that import these
// formatters, and a single server-only import in this file would drag a DB
// driver into the browser bundle (or fail the build outright). The API routes
// import the same functions, so a value the form accepts and a value the
// route accepts can never drift apart.
//
// Units: the human types HOURS (people think "about six hours a month"), the
// database stores whole MINUTES. That split is deliberate - minutes keep
// "6h 30m" exact with no float ever reaching a column, and hours keep the
// form from asking for 390 of anything. NO EM DASHES in any string here: the
// messages below are visible site copy (site rule).

/** The physical ceiling: 744 hours is a 31-day month, so nothing beyond it
 * can be time saved *in* a month. Named in the refusal copy so a typo like
 * "6000" tells the reader what the bound actually is. */
export const TIME_SAVED_MAX_HOURS = 744;

/** 744 hours in minutes. Kept in step with the migration 0049 CHECK
 * (work_submissions_time_saved_ck, 1 .. 44640): if this constant and the
 * constraint ever disagree the route hands the DB a value it refuses and the
 * user gets a 500 instead of a sentence. */
export const TIME_SAVED_MAX_MINUTES = 44_640;

export type TimeSavedParse =
  | { ok: true; minutes: number | null }
  | { ok: false; message: string };

/** Parse the form/API field (hours) into storable minutes.
 *
 * NULL means "not reported", and it is reachable two ways on purpose: the
 * field is absent/empty (the optional field at submission time), or the
 * value is 0. Zero CLEARS: the owner-facing editor pre-fills the current
 * hours, so typing 0 and saving is the only gesture anyone reaches for when
 * they want the number gone, and an "invalid" refusal there would leave a
 * wrong figure on a published card with no way to remove it.
 *
 * Accepts a number (JSON body) or a string (FormData), because both write
 * lanes reach this function: the create route reads FormData, the
 * time-saved route reads JSON. */
export function parseTimeSavedHours(raw: unknown): TimeSavedParse {
  if (raw === undefined || raw === null) return { ok: true, minutes: null };
  // Only these two types are accepted BY TYPE. A bare `Number(raw)` would
  // quietly turn `true` into 1 hour and `[]` into 0, and both would look
  // like a deliberate report to every surface downstream.
  if (typeof raw !== "string" && typeof raw !== "number")
    return {
      ok: false,
      message: "Time saved must be a number of hours, like 6 or 6.5.",
    };
  let hours: number;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, minutes: null };
    // Number("") is 0 and Number(" 6.5 ") is 6.5, so the empty case above
    // has to be settled BEFORE this line or an empty field would read as a
    // deliberate zero. Number() also accepts "0x10" and "1e3"; both are
    // numbers a person could not have meant here but neither is dangerous,
    // and the range check below catches the ones that matter.
    hours = Number(trimmed);
  } else {
    hours = raw;
  }
  if (!Number.isFinite(hours))
    return {
      ok: false,
      message: "Time saved must be a number of hours, like 6 or 6.5.",
    };
  if (hours < 0)
    return {
      ok: false,
      message:
        "Time saved cannot be negative. Leave it empty if you are not reporting one.",
    };
  if (hours === 0) return { ok: true, minutes: null };
  if (hours > TIME_SAVED_MAX_HOURS)
    return {
      ok: false,
      message: `Time saved cannot be more than ${TIME_SAVED_MAX_HOURS} hours a month, which is every hour of a 31-day month.`,
    };
  // Clamped to at least 1: 0.005 hours rounds to 0 minutes, and storing that
  // as NULL would tell the submitter their report vanished. One minute is an
  // honest floor and satisfies the DB CHECK's lower bound. The upper Math.min
  // is defensive against a value that passed the hours check and still landed
  // a rounding tick over the cap; the CHECK would answer that with a 500.
  const minutes = Math.min(
    TIME_SAVED_MAX_MINUTES,
    Math.max(1, Math.round(hours * 60))
  );
  return { ok: true, minutes };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Prose for the published card and the row editor: "6 hours 30 minutes a
 * month". Returns null for "not reported" so every caller renders NOTHING
 * rather than a zero, which on a card would read as a claim that the work
 * saves no time. Non-positive and non-finite values fold into the same null
 * (a row that predates the CHECK, or a hand-edited database). */
export function formatTimeSavedPhrase(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0)
    return null;
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${plural(m, "minute")} a month`;
  if (m === 0) return `${plural(h, "hour")} a month`;
  return `${plural(h, "hour")} ${plural(m, "minute")} a month`;
}

/** Table-cell form for the scorecard column: "6h", "6h 30m", "45m". A zero
 * (or anything unreportable) renders as a bare "0" so the cell matches the
 * Published column's faint zero instead of inventing a unit for nothing. */
export function formatTimeSavedCompact(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0";
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Pre-fill value for the hours input: 390 -> "6.5", 360 -> "6", 45 ->
 * "0.75", nothing reported -> "". At most 2 decimals, no trailing zeros.
 * Not a browser constraint: every time-saved input is `step="any"`, so
 * nothing is rejected for sitting off a grid. The reason is the person: a
 * raw minutes/60 float tail like "6.500000000000001" turns a field someone
 * was asked to CORRECT into a machine's number they have to clean up first.
 * Two decimals is also exactly the precision that round-trips back through
 * parseTimeSavedHours to within a minute, which is the storage resolution. */
export function hoursFieldValue(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return "";
  // String() prints the shortest decimal that round-trips, so 0.75 stays
  // "0.75" and 6 stays "6" with no toFixed padding to strip afterwards.
  return String(Math.round((minutes / 60) * 100) / 100);
}
