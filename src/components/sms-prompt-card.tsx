"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/use-session";

// Post-sign-in SMS opt-in prompt. A polite, dismissible card — deliberately
// NOT a modal: SMS opt-in is optional (TCPA), so nothing may gate or steal
// focus. It only points at /texting; the wizard there remains the sole
// consent/verification surface.
//
// Show iff (all of):
//   signed in && server says smsPromptEligible   (no number, not "don't ask")
//   && not already shown this browser session    (sessionStorage)
//   && not snoozed via "Not now"                 (localStorage, 14 days)
//   && pathname is not /texting, /login, /admin* (reactive; reaching /texting
//                                                 counts as fulfilled)
// Fail toward silence: any storage/fetch error means no card.

const SHOWN_KEY = "aix_sms_prompt_shown"; // sessionStorage: once per session
const SNOOZE_UNTIL_KEY = "aix_sms_prompt_snooze_until"; // localStorage: ISO date
const SNOOZE_COUNT_KEY = "aix_sms_prompt_snoozes"; // localStorage: int
const SNOOZE_DAYS = 14;
const MAX_SNOOZES = 3; // then "Not now" quietly becomes permanent

function suppressedPath(pathname: string): boolean {
  return (
    pathname === "/texting" ||
    pathname === "/login" ||
    pathname.startsWith("/admin")
  );
}

function sendEvent(event: "shown" | "clicked" | "snoozed" | "dismissed") {
  fetch("/api/auth/sms-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
    keepalive: true, // survives the navigation on "clicked"
  }).catch(() => {});
}

export function SmsPromptCard() {
  const session = useSession();
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (session.status !== "signed-in" || !session.user.smsPromptEligible) {
      return;
    }
    try {
      if (sessionStorage.getItem(SHOWN_KEY)) return;
      const snoozeUntil = localStorage.getItem(SNOOZE_UNTIL_KEY);
      if (snoozeUntil && Date.parse(snoozeUntil) > Date.now()) return;
      if (suppressedPath(pathname)) {
        // They're already at (or headed into) the flow or a console page.
        // /texting in particular means the prompt's job is done this session.
        if (pathname === "/texting") sessionStorage.setItem(SHOWN_KEY, "1");
        return;
      }
      sessionStorage.setItem(SHOWN_KEY, "1");
      setVisible(true);
      sendEvent("shown");
    } catch {
      // storage unavailable (private mode etc.) — show nothing
    }
  }, [session, pathname]);

  // Reactive suppression: card is up and the user navigates client-side
  // into a suppressed area — hide it; /texting counts as fulfilled (the
  // sessionStorage flag set above already prevents a return this session).
  useEffect(() => {
    if (visible && suppressedPath(pathname)) setVisible(false);
  }, [visible, pathname]);

  if (!visible) return null;

  function notNow() {
    setVisible(false);
    try {
      const count =
        (parseInt(localStorage.getItem(SNOOZE_COUNT_KEY) || "0", 10) || 0) + 1;
      localStorage.setItem(SNOOZE_COUNT_KEY, String(count));
      localStorage.setItem(
        SNOOZE_UNTIL_KEY,
        new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString()
      );
      // Repeatedly snoozed = the answer is no; stop asking on every device.
      sendEvent(count >= MAX_SNOOZES ? "dismissed" : "snoozed");
    } catch {
      sendEvent("snoozed");
    }
  }

  function dontAskAgain() {
    setVisible(false); // optimistic; a failed POST just means it may return
    sendEvent("dismissed");
  }

  return (
    <section
      aria-labelledby="sms-prompt-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") notNow();
      }}
      className="panel panel--raised panel--lightline fixed bottom-4 left-4 right-24 z-30 sm:bottom-6 sm:left-6 sm:right-auto sm:w-[340px]"
      style={{ padding: "1.25rem" }}
    >
      <span className="sys-label">SMS Channel</span>
      <h3 id="sms-prompt-title" className="mt-3 text-base font-semibold">
        Text with Tron Netter
      </h3>
      <p className="mt-2 text-sm">
        Get answers from our AI agent by text, wherever you are — no browser
        needed. Optional, and never required to use this site.
      </p>
      <div className="mt-4 space-y-3">
        <Link
          href="/texting?utm_source=sms_prompt"
          prefetch={false}
          onClick={() => sendEvent("clicked")}
          className="btn btn--primary w-full text-xs no-underline"
        >
          Add my number
        </Link>
        <div className="flex items-center justify-between">
          <button onClick={notNow} className="btn btn--text text-xs">
            Not now
          </button>
          <button
            onClick={dontAskAgain}
            className="text-xs underline underline-offset-4 hover:opacity-80"
            style={{ color: "var(--xl-text-dim)" }}
          >
            Don&apos;t ask again
          </button>
        </div>
      </div>
    </section>
  );
}
