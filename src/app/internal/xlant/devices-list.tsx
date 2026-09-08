"use client";

// "Your computers" — the caller's own signed-in machines, and the button that
// signs one out (§5.22). A client island because the list is a live reading
// rather than a property of the page: it changes when the staffer mints a
// token in the card above, and it changes again when they sign a computer out,
// and a server-rendered snapshot would be stale in both directions.
//
// IT IMPORTS NOTHING FROM `@/lib/xlant`, and that is a rule rather than an
// accident: that module reads node:fs and the XLAnt shared secret, and
// bundling it into a client would ship both. The row shape below is therefore
// a hand-kept mirror of `XlantDeviceSummary` there, exactly as the token
// button inlines the two device kinds. A test pins the absence of the import
// for both files.
//
// WHY THIS SECTION EXISTS. Until 2026-09-08 a person held one token per kind
// and every mint signed their previous machine out, so there was nothing to
// list: the answer was always "the last computer you set up". A person now
// holds one token per COMPUTER, minting never signs anything out, and the only
// way to take a lost or finished machine off the air is to aim at it — which
// needs a list to aim with. It is also where the SPARE ROW after a reinstall
// gets dealt with: the relay retires a computer's older token when the new
// install first reports something, so until then one laptop legitimately has
// two rows here and the person picks the one to sign out.
//
// THE MINT AND THIS LIST ARE COUPLED BY ONE EVENT. Both token buttons are
// mounted separately from this island (one per platform card, and the page
// draws them inside their own sections), so there is no shared React state to
// lift and no parent that owns both. After a successful mint the button
// dispatches `xlant:devices-changed` on `window`; this island listens and
// re-reads the list, where the fresh token appears as a computer that has not
// connected yet. A window event rather than a router refresh because the token
// is held in the button's own state and nowhere else — re-rendering the server
// component would blank a token the staffer has not copied yet.

import { useCallback, useEffect, useState } from "react";

/** The event the token buttons fire after a successful mint. Declared here
 * because this is the listener; the buttons carry the same literal and a test
 * pins that the two spellings match. */
export const DEVICES_CHANGED_EVENT = "xlant:devices-changed";

/** One computer, as `GET /api/internal/xlant/devices` answers it — the mirror
 * of `XlantDeviceSummary` in `@/lib/xlant`, which this file must not import.
 * `kind` is null when the host did not recognise the relay's word for it. */
interface DeviceRow {
  deviceId: string;
  kind: "windows" | "mac" | null;
  machineName: string | null;
  userName: string | null;
  clientVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** ISO instant while an unused token is still inside its seven-day window;
   * null once the computer has reported in, or when the row is not on a
   * clock. */
  expiresAt: string | null;
  openIncidents: number;
}

// The routes answer typed reasons, not prose — the same contract the token
// button reads. A code is a fine thing to log and a poor thing to be shown, so
// each one a staffer can actually provoke gets a sentence that says what is
// true of their computers RIGHT NOW ("nothing has changed", "it is still
// signed in"), because that is the question they are about to ask. Anything
// unmapped falls through to the code itself rather than to a guess.
const MESSAGES: Record<string, string> = {
  unauthenticated:
    "Your sign-in has expired. Reload this page and sign in again to see your computers.",
  wrong_domain: "This is open to XL.net staff accounts only.",
  wrong_provider:
    "This session could not verify your address. Sign in again with your xl.net Google or Microsoft account.",
  "XLAnt is not configured on this host":
    "XLAnt is not configured on this server yet. Tell whoever set it up.",
  "the XLAnt relay did not answer":
    "The XLAnt relay did not answer, so this list could not be read. Nothing has changed on your computers. Try again in a moment.",
  "relay refused the device list":
    "The XLAnt relay refused to list your computers. Nothing has changed on them.",
  "relay returned no device list":
    "The XLAnt relay answered without a list. Nothing has changed on your computers — try again in a moment.",
  "relay refused the sign-out":
    "The XLAnt relay refused the sign-out. That computer is still signed in.",
  "that computer is not yours or is already signed out":
    "That computer is already signed out. The list has been refreshed.",
  "deviceId must be a device id":
    "That row could not be identified. Reload the page and try again.",
};

/** How long ago, in the words a person uses. Exported for the test, which
 * pins the boundaries and the singulars rather than trusting the arithmetic.
 *
 * A time in the FUTURE reads "just now": the timestamp is the relay's clock
 * and this runs on the staffer's, and a machine seen four seconds ago must not
 * read "in a moment". An unparseable value is "unknown" and never a fabricated
 * duration — the row is still worth showing and still worth signing out. */
export function lastSeenWords(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const seconds = Math.round((now - t) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** What to call the machine in a heading. Never "Windows" for a kind this
 * host did not recognise. */
export function kindWords(kind: DeviceRow["kind"]): string {
  return kind === "windows" ? "Windows" : kind === "mac" ? "Mac" : "Computer";
}

/** The name slot, and it has THREE answers rather than two.
 *
 * The relay binds `machineName` at the computer's first `/incident/start`, so
 * a nameless row is not necessarily an unused token: an install that has said
 * hello and had nothing go wrong yet has connected, is working, and still has
 * no name. Calling that "not connected yet" would tell a staffer their working
 * PC never arrived — and, worse, invite them to mint another token for it. So
 * `lastSeenAt` decides: never seen is "not connected yet"; seen but unnamed is
 * "no name yet", which is the truth and reads correctly beside the "last seen"
 * words on the line below. */
export function machineWords(
  machineName: string | null,
  lastSeenAt: string | null
): string {
  if (machineName !== null) return machineName;
  return lastSeenAt === null ? "not connected yet" : "no name yet";
}

/** When an unused token runs out, in the same register as the "last seen"
 * words. null renders NOTHING — a row with no clock says nothing about one.
 *
 * The remaining days are FLOORED, never rounded up: 47 hours left reads
 * "expires in 1 day". Overstating the time somebody has is the expensive
 * direction of that error, and under a day the answer is "expires today"
 * rather than a count of hours nobody acts on. An instant already past reads
 * "expired" — the relay lists active devices only, so this should not arrive,
 * and inventing a positive countdown for it would be worse than saying so. */
export function expiryWords(
  expiresAt: string | null,
  now: number = Date.now()
): string | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  const ms = t - now;
  if (ms <= 0) return "expired";
  const DAY = 24 * 60 * 60 * 1000;
  if (ms < DAY) return "expires today";
  const days = Math.floor(ms / DAY);
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

function messageFor(code: string, fallback: string): string {
  return MESSAGES[code] || code || fallback;
}

/** The one line the Sign out button asks before it acts. Exported so the test
 * pins both shapes of it rather than trusting a template literal.
 *
 * It names the CONSEQUENCE rather than asking "are you sure", and since
 * refuter R2 (F10) it names the whole consequence: `revokeDevice` on the relay
 * closes EVERY non-terminal piece of work of that device as `superseded` —
 * a ticket being verified and a wrap-up included, with no successor to move
 * them to — and the only party it notifies is the device that has just been
 * signed out, so nobody hears about it. The row already shows "N open" a few
 * pixels away; a confirm that stayed silent about it would be asking the
 * person to agree to something the page had already told them was there. */
export function confirmWords(name: string, openIncidents: number): string {
  const base =
    `Sign ${name} out of XLAnt? Its token stops working immediately, and ` +
    `that computer needs a new one from this page to come back.`;
  if (openIncidents <= 0) return base;
  return openIncidents === 1
    ? `${base} The one piece of work XLAnt still has open on it ends with it.`
    : `${base} The ${openIncidents} pieces of work XLAnt still has open on it end with it.`;
}

export function DevicesList() {
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // NOTHING IS SET SYNCHRONOUSLY HERE. The mount effect below calls this
  // directly, and a setState before the first `await` would run inside the
  // effect body and cascade a second render for no reason (react-hooks'
  // set-state-in-effect). `loading` therefore STARTS true and is turned off
  // when the answer lands; the callers that re-read the list turn it back on
  // themselves, from inside an event handler where that is the right place.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/internal/xlant/devices", {
        // The route already answers no-store; asked for here too so a
        // bfcache-warm tab cannot draw yesterday's list.
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as {
        devices?: DeviceRow[];
        error?: string;
      };
      if (!res.ok || !Array.isArray(json.devices)) {
        throw new Error(
          messageFor(json.error ?? "", "Your computers could not be listed.")
        );
      }
      setRows(json.devices);
      // Cleared on success rather than on entry, so a failed read leaves its
      // sentence up until a good one replaces it.
      setError(null);
    } catch (e) {
      // The previous list is NOT cleared. It was true a moment ago, and
      // showing an empty section under an error message would read as "you
      // have no computers", which is the one thing this list must never say
      // by accident.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The first read happens in a TIMER callback rather than in this effect's
    // body — the same shape `work/submit/review-progress.tsx` uses, and for
    // the same reason: a setState reached synchronously from an effect body
    // cascades a second render, and there is nothing to gain from it here
    // because the first paint already says "Reading your computers…". The
    // delay is 0, so the list is asked for within a frame of mounting.
    const first = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    const onChanged = () => {
      if (cancelled) return;
      setLoading(true);
      void load();
    };
    window.addEventListener(DEVICES_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      clearTimeout(first);
      window.removeEventListener(DEVICES_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  async function signOut(row: DeviceRow) {
    // The machine name if there is one, and a pronoun if there is not — never
    // "not connected yet", which would read as a name in the confirm sentence.
    const name = row.machineName ?? "this computer";
    if (!window.confirm(confirmWords(name, row.openIncidents))) return;
    setBusyId(row.deviceId);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/internal/xlant/devices/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: row.deviceId }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(
          messageFor(json.error ?? "", "That computer could not be signed out.")
        );
      }
      setNote(`${name} is signed out.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      // Reloaded either way. A refusal can mean the relay had already signed
      // that computer out, so the list is the honest answer to both outcomes.
      setLoading(true);
      await load();
    }
  }

  const empty = rows !== null && rows.length === 0;
  // The sign-out note and the empty line are not alternatives: signing the
  // last computer out produces both, and dropping either would lose the
  // confirmation or the explanation of the blank space below it.
  const status = loading
    ? "Reading your computers…"
    : [note, empty ? "No computers yet — generate a token above." : ""]
        .filter(Boolean)
        .join(" ");

  return (
    <div className="mt-8">
      {/* Polite, not assertive: everything here happens in response to the
          viewer's own click or their arrival on the page. */}
      <p className="text-sm text-faint" aria-live="polite">
        {status}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-2 text-sm"
          style={{ color: "var(--xl-danger)" }}
        >
          {error}
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-4 space-y-6">
          {rows.map((row) => {
            // Computed per render rather than per row-state: the countdown is
            // read off the clock at draw time, like the "last seen" words, so
            // a tab left open does not have to hold a timer to stay honest the
            // next time React paints.
            const expiry = expiryWords(row.expiresAt);
            return (
              <div
                key={row.deviceId}
                className="border-t border-[var(--xl-line)] pt-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                      <span className="text-faint">{kindWords(row.kind)} · </span>
                      {machineWords(row.machineName, row.lastSeenAt)}
                    </h3>
                    <p className="mt-2 text-sm text-faint">
                      <span className="mono">{row.clientVersion ?? "—"}</span>
                      {" · last seen "}
                      {lastSeenWords(row.lastSeenAt)}
                      {expiry && ` · ${expiry}`}
                      {row.openIncidents > 0 && ` · ${row.openIncidents} open`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void signOut(row)}
                    disabled={busyId !== null}
                    aria-busy={busyId === row.deviceId}
                  >
                    {busyId === row.deviceId ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
