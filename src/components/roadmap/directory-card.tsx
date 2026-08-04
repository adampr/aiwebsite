"use client";

// Step 02 hub card (§5.18 round 3): the ONE owner of every directory-card
// state. Refuter ruling: a child island cannot rewrite a server-rendered
// parent, so the whole card is a client component; SSR paints the idle state
// and hydration matches because the busy state is only entered in useEffect.
//
// autoInit is computed SERVER-SIDE by page.tsx (admin + zero people + never
// imported + company active + roadmapEnabled + APOLLO_API_KEY present).
// The kick guard is sessionStorage under apolloKickGuardKey(domain) - the
// ONE shared key, so hub -> step navigation cannot double-kick - preset
// SYNCHRONOUSLY before the POST, plus a useRef did-run guard (StrictMode).
// Auto-lane failures (429/403/503/network/not_configured/apollo_down)
// degrade SILENTLY to the idle card: the step page's manual button is the
// retry lever, never an error banner on the hub. No em dashes.
//
// Round 5 (owner ask): admins get a "Recheck database" button on the idle
// card that re-runs the Apollo import from the hub (manual lane, same
// admin-gated route, the 3/h/company limiter is the fence). It is the
// card's deliberate SECOND interactive element, raised above the stretched
// overlay via .rmp-card-action (see roadmap.css). Unlike the auto lane, a
// clicked recheck reports its outcome: success renders the shared
// importLine (apollo-copy.ts, the step page renders the same line) and
// failures speak, because silence after a click reads as a broken button.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apolloKickGuardKey } from "@/lib/roadmap/config";
import { importLine, type ImportResult } from "@/lib/roadmap/apollo-copy";

const faint = { color: "var(--xl-text-faint)" } as const;

type Props = {
  autoInit: boolean;
  canRecheck: boolean;
  isAdmin: boolean;
  people: number;
  everImported: boolean;
  domain: string;
  href: string;
  num: string;
  title: string;
  blurb: string;
  ctaTodo: string;
  ctaDone: string;
};

export function DirectoryCard(props: Props) {
  const router = useRouter();
  const [kicked, setKicked] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [note, setNote] = useState<{
    role: "status" | "alert";
    text: string;
  } | null>(null);
  const ran = useRef(false);

  async function recheck() {
    setRecheckBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/roadmap/apollo-import", {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as
          | ImportResult
          | null;
        setNote({
          role: "status",
          text: importLine(
            data ?? {},
            props.domain,
            "Add your team by hand instead."
          ),
        });
        // The count line, CTA, and runway node are server-rendered; resync
        // them to the fresh rows.
        router.refresh();
        return;
      }
      if (res.status === 429) {
        setNote({ role: "status", text: "Give it a minute, then try again." });
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setNote({
        role: "alert",
        text:
          body?.error?.message ??
          "The recheck could not run just now. Try again shortly.",
      });
    } catch {
      setNote({
        role: "alert",
        text: "The recheck could not run just now. Check your connection and try again.",
      });
    } finally {
      setRecheckBusy(false);
    }
  }

  useEffect(() => {
    if (!props.autoInit || ran.current) return;
    ran.current = true;
    try {
      const key = apolloKickGuardKey(props.domain);
      if (window.sessionStorage.getItem(key) !== null) return;
      // Pre-set synchronously: the guard must exist BEFORE the POST so a
      // same-tab navigation to the step page cannot kick again mid-flight.
      window.sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // No sessionStorage means no reload fence: do not kick at all.
      return;
    }
    // Deferred a tick (codebase pattern: open-items-resolver) so the effect
    // body stays setState-free; the guard above already ran synchronously.
    // No cleanup cancel: StrictMode's immediate unmount would eat the only
    // kick (the ref guard blocks the remount's attempt).
    window.setTimeout(() => {
      setKicked(true);
      void (async () => {
        try {
          const res = await fetch("/api/roadmap/apollo-import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ trigger: "auto" }),
          });
          if (res.ok) {
            // The server re-renders with real people/everImported; the
            // refreshed idle state speaks, nothing else shows here. Stay
            // busy until the fresh props flip everImported.
            router.refresh();
            return;
          }
        } catch {
          // network: fall through to the silent degrade below
        }
        setKicked(false);
      })();
    }, 0);
  }, [props.autoInit, props.domain, router]);

  // Busy only while the auto-kick is in flight AND the server still says
  // nothing was ever imported (a completed run flips everImported on
  // refresh, ending the busy state even though `kicked` stays true).
  const busy = kicked && !props.everImported && props.people === 0;

  // Round 4 (+ round 5 recheck): while an import is in flight, the RUNWAY's
  // directory node pulses too. The node is server-owned DOM
  // (#rmp-node-directory), so the toggle is a data ATTRIBUTE, never a class
  // (React refresh would wipe a classList mutation of its managed
  // className), and the sr span (#rmp-sr-directory) is updated via the
  // existing TEXT NODE's nodeValue - NEVER textContent, which orphans
  // React's text fiber and breaks later refresh updates. The restore is
  // guarded: if a refresh already rewrote the phrase (governance completing
  // mid-import, or the import finishing), the fresh server text must win.
  // Round 5: the restore puts back the CAPTURED previous phrase, not a
  // hardcoded "Not started" - a recheck can run on a Done/Live directory.
  // Known accepted edge: a concurrent refresh mid-import can reclaim the sr
  // phrase while the node still pulses.
  const working = busy || recheckBusy;
  useEffect(() => {
    const node = document.getElementById("rmp-node-directory");
    const sr = document.getElementById("rmp-sr-directory");
    const srText = sr?.firstChild;
    const WORKING = ", Checking now, import running";
    // Capture the server phrase so the guarded restore puts back whatever
    // was really there (", Up next", ", Searched, none found on Apollo",
    // ", Done"...) instead of a hardcoded literal (both sessions converged
    // on this fix; a recheck can run on a Done/Live directory).
    let prev: string | null = null;
    // The hover tooltip reads the CELL's data-state (round 6); swap it in
    // step with the pulse and restore the captured prior value.
    const cell = node?.closest(".rmp-node-cell");
    let prevTip: string | null = null;
    if (working) {
      node?.setAttribute("data-working", "");
      if (cell) {
        prevTip = cell.getAttribute("data-state");
        cell.setAttribute("data-state", "Checking now");
      }
      if (srText?.nodeType === Node.TEXT_NODE) {
        prev = srText.nodeValue;
        srText.nodeValue = WORKING;
      }
    }
    return () => {
      node?.removeAttribute("data-working");
      if (cell && cell.getAttribute("data-state") === "Checking now" && prevTip !== null) {
        cell.setAttribute("data-state", prevTip);
      }
      if (
        srText?.nodeType === Node.TEXT_NODE &&
        srText.nodeValue === WORKING &&
        prev !== null
      ) {
        srText.nodeValue = prev;
      }
    };
  }, [working]);

  if (busy) {
    return (
      <div className="panel rise rmp-card" aria-busy="true">
        <div className="flex items-baseline justify-between gap-4">
          <span className="sys-label">{props.num}</span>
          <span className="rmp-state rmp-state--init">Initializing...</span>
        </div>
        <h3 className="mt-4">{props.title}</h3>
        {/* role=status: the one announcement channel for the import's
            resolution (WCAG 4.1.3); the runway is never a live region. */}
        <p className="mt-4 text-sm" role="status">
          Searching Apollo, a business directory, for people listed at{" "}
          {props.domain}.
        </p>
        <p className="mt-3 text-sm">
          Review the results and remove anyone you are not authorized to
          list. Removals survive future imports.
        </p>
      </div>
    );
  }

  const stampedZero =
    props.isAdmin && props.everImported && props.people === 0;
  const memberZero = !props.isAdmin && props.people === 0;

  const countLine =
    props.people > 0
      ? `${props.people} ${props.people === 1 ? "person" : "people"} listed`
      : stampedZero
        ? `Apollo had no people for ${props.domain}`
        : memberZero
          ? "Not set up yet"
          : "No one listed yet";

  const cta = stampedZero
    ? "Add your team by hand"
    : memberZero
      ? "See the directory"
      : props.people > 0
        ? props.ctaDone
        : props.ctaTodo;

  return (
    <div className="panel rise rmp-card">
      <div className="flex items-baseline justify-between gap-4">
        <span className="sys-label">{props.num}</span>
        <span className="mono text-xs" style={faint}>
          {countLine}
        </span>
      </div>
      <h3 className="mt-4">{props.title}</h3>
      <p className="mt-4 text-sm">{props.blurb}</p>
      {memberZero && (
        <p className="mt-3 text-sm">
          Your company admin can initialize this from Apollo.
        </p>
      )}
      {props.canRecheck && (
        <div className="mt-4">
          {/* The card's second interactive element (round 5, owner ask):
              .rmp-card-action raises it above the stretched overlay, which
              would otherwise swallow its clicks. */}
          <button
            type="button"
            className="btn rmp-card-action"
            disabled={recheckBusy}
            aria-busy={recheckBusy}
            onClick={() => void recheck()}
          >
            {recheckBusy ? "Rechecking..." : "Recheck database"}
          </button>
          {note && (
            <p
              role={note.role}
              className={`mono mt-3 text-xs ${
                note.role === "alert" ? "text-red-400" : "text-faint"
              }`}
            >
              {note.text}
            </p>
          )}
        </div>
      )}
      <Link href={props.href} className="rmp-card-cta">
        {cta}{" "}
        <span className="rmp-arrow" aria-hidden="true">
          →
        </span>
      </Link>
    </div>
  );
}
