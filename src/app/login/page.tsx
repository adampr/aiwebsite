"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

const ERROR_MESSAGES: Record<string, string> = {
  missing_params: "Sign-in was interrupted. Please try again.",
  invalid_state: "Your sign-in session expired. Please try again.",
  token_exchange: "We couldn't complete sign-in with the provider. Please try again.",
  userinfo: "We couldn't read your profile from the provider. Please try again.",
  no_email: "Your account didn't share an email address. Please try another account.",
  rejected: "Sign-in was rejected.",
  provider_unconfigured:
    "This sign-in provider isn't available yet. Please try the other one.",
};

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md pt-12 text-center">
          <p className="text-sm">Loading...</p>
        </div>
      }
    >
      <LoginCard />
    </Suspense>
  );
}

function LoginCard() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "";
  const errorCode = searchParams.get("error");
  const errorMessage = errorCode
    ? searchParams.get("message") || ERROR_MESSAGES[errorCode] || "Something went wrong. Please try again."
    : "";

  const redirectParam = redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : "";

  return (
    <div className="mx-auto max-w-md space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label">Account</span>
        <h1 className="mt-2 text-3xl font-bold">Sign In</h1>
        <p className="mt-2 text-sm">
          Sign in to XL.net AI with your Google or Microsoft account.
        </p>
      </div>

      <div className="panel panel--raised space-y-4">
        <a
          href={`/api/auth/google/start${redirectParam}`}
          className="flex w-full items-center justify-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium no-underline transition-opacity hover:opacity-80"
          style={{ borderColor: "var(--xl-line)", color: "var(--xl-text)" }}
        >
          <GoogleIcon />
          Continue with Google
        </a>

        <a
          href={`/api/auth/microsoft/start${redirectParam}`}
          className="flex w-full items-center justify-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium no-underline transition-opacity hover:opacity-80"
          style={{ borderColor: "var(--xl-line)", color: "var(--xl-text)" }}
        >
          <MicrosoftIcon />
          Continue with Microsoft
        </a>

        {errorMessage && (
          <p className="text-center text-sm" style={{ color: "#e5484d" }} role="alert">
            {errorMessage}
          </p>
        )}
      </div>

      <p className="text-center text-xs" style={{ color: "var(--xl-text-faint)" }}>
        We only use your name and email address to create your account. We never
        post on your behalf or access anything else.
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 23 23" className="h-5 w-5" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}
