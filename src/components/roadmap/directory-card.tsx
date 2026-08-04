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

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apolloKickGuardKey } from "@/lib/roadmap/config";

const faint = { color: "var(--xl-text-faint)" } as const;

type Props = {
  autoInit: boolean;
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
  const ran = useRef(false);

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

  if (busy) {
    return (
      <div className="panel rise rmp-card" aria-busy="true">
        <div className="flex items-baseline justify-between gap-4">
          <span className="sys-label">{props.num}</span>
          <span className="rmp-state rmp-state--init">Initializing...</span>
        </div>
        <h3 className="mt-4">{props.title}</h3>
        <p className="mt-4 text-sm">
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
      <Link href={props.href} className="rmp-card-cta">
        {cta}{" "}
        <span className="rmp-arrow" aria-hidden="true">
          →
        </span>
      </Link>
    </div>
  );
}
