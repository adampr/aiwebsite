"use client";

import { useEffect, useState } from "react";

// Shared client-side session state. UserMenu, the SMS prompt card, and the
// /texting page all need GET /api/auth/session on page load — this hook
// dedupes them to ONE fetch per hard navigation via a module-level promise.
// A fetch failure resolves to signed-out (fail toward silence).

export type SessionUser = {
  email: string;
  displayName: string | null;
  provider: "google" | "microsoft";
  isAdmin: boolean;
  phone: string | null;
  smsOptIn: boolean;
  smsPromptEligible: boolean;
};

export type SessionState =
  | { status: "loading"; user: null }
  | { status: "signed-out"; user: null }
  | { status: "signed-in"; user: SessionUser };

let cached: Promise<SessionState> | null = null;

export function fetchSession(force = false): Promise<SessionState> {
  if (!cached || force) {
    cached = fetch("/api/auth/session")
      .then((res) => res.json())
      .then((data): SessionState =>
        data.authenticated
          ? { status: "signed-in", user: data.user }
          : { status: "signed-out", user: null }
      )
      .catch((): SessionState => ({ status: "signed-out", user: null }));
  }
  return cached;
}

// Call after a mutation that changes session-derived state (e.g. completing
// phone verification) so the next consumer refetches.
export function invalidateSession(): void {
  cached = null;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    user: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchSession().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
