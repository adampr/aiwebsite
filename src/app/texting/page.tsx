"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SMS_CONSENT_TEXT } from "@/lib/texting";
import { useSession, invalidateSession, type SessionUser } from "@/lib/use-session";

type Step = "loading" | "signin" | "phone" | "code" | "done";

const inputClass =
  "w-full border-b border-[var(--xl-line-bright)] bg-transparent px-1 py-2 text-sm text-[var(--xl-text)] outline-none placeholder:text-[var(--xl-text-faint)] focus:border-[var(--xl-light)]";

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatE164(e164: string): string {
  return formatPhone(e164.replace(/^\+1/, ""));
}

export default function TextingPage() {
  const [step, setStep] = useState<Step>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState(""); // E.164 the code was texted to
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const session = useSession();

  useEffect(() => {
    if (session.status === "loading") return;
    // Only drive the wizard from session state while still on the initial
    // steps — never yank the user out of code entry or the done panel.
    setStep((current) => {
      if (current !== "loading" && current !== "signin" && current !== "phone") {
        return current;
      }
      if (session.status === "signed-out") return "signin";
      setUser(session.user);
      if (session.user.phone && session.user.smsOptIn) {
        setSentTo(session.user.phone);
        return "done";
      }
      return "phone";
    });
  }, [session]);

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const res = await fetch("/api/texting/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.replace(/\D/g, ""), smsOptIn }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
      } else {
        setSentTo(data.phone);
        setCode("");
        if (step === "code") setNotice("A new code is on its way.");
        setStep("code");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const res = await fetch("/api/texting/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
      } else {
        setSentTo(data.phone);
        setStep("done");
        invalidateSession();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label sys-label--center">SMS Channel</span>
        <h1 className="mt-4 text-3xl font-bold">Text with Tron Netter</h1>
        <p className="mx-auto mt-3 text-sm">
          Register your mobile number to text with Tron Netter, our AI agent.
          We&apos;ll verify the number with a one-time code before it&apos;s
          added to your account.
        </p>
      </div>

      <div className="panel panel--raised space-y-5">
        {step === "loading" && (
          <p className="text-center text-sm">Loading...</p>
        )}

        {step === "signin" && (
          <div className="space-y-4 text-center">
            <p className="text-sm">
              Sign in first so we can attach the number to your account.
            </p>
            <Link
              href={`/login?redirect=${encodeURIComponent("/texting")}`}
              className="btn btn--primary inline-block"
            >
              Sign In
            </Link>
          </div>
        )}

        {step === "phone" && (
          <form onSubmit={requestCode} className="space-y-5">
            <div>
              <label htmlFor="texting-phone" className="mb-1.5 block text-sm font-medium">
                Mobile phone number
              </label>
              <input
                id="texting-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(formatPhone(e.target.value))}
                placeholder="(312) 555-1234"
                required
                className={inputClass}
                inputMode="numeric"
                autoComplete="tel-national"
              />
            </div>

            <div
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--xl-line)", background: "var(--xl-bg-1)" }}
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={smsOptIn}
                  onChange={(e) => setSmsOptIn(e.target.checked)}
                  required
                  className="mt-1 h-4 w-4 shrink-0"
                />
                <span className="text-sm leading-relaxed">
                  {SMS_CONSENT_TEXT}{" "}
                  <Link href="/sms-terms">SMS Terms</Link> &middot;{" "}
                  <Link href="/privacy">Privacy Policy</Link>
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading || !smsOptIn || phone.replace(/\D/g, "").length !== 10}
              className="btn btn--primary w-full disabled:opacity-50"
            >
              {loading ? "Sending code..." : "Text me a verification code"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={verifyCode} className="space-y-5">
            <p className="text-sm">
              We texted a 6-digit code to{" "}
              <strong className="mono">{formatE164(sentTo)}</strong>. Enter it
              below to finish registering. It expires in 10 minutes.
            </p>
            <div>
              <label htmlFor="texting-code" className="mb-1.5 block text-sm font-medium">
                Verification code
              </label>
              <input
                id="texting-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                required
                className={`${inputClass} mono tracking-[0.4em]`}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>

            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="btn btn--primary w-full disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify & register number"}
            </button>

            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => {
                  setStep("phone");
                  setError("");
                  setNotice("");
                }}
                className="btn btn--text"
              >
                Change number
              </button>
              <button
                type="button"
                onClick={() => requestCode()}
                disabled={loading}
                className="btn btn--text disabled:opacity-50"
              >
                Resend code
              </button>
            </div>
          </form>
        )}

        {step === "done" && (
          <div className="space-y-4 text-center">
            <span className="sys-label sys-label--center sys-label--sand">
              Verified
            </span>
            <p className="text-sm">
              <strong className="mono">{sentTo ? formatE164(sentTo) : "Your number"}</strong>{" "}
              is registered for texting{user?.email ? ` on ${user.email}` : ""}.
            </p>
            <p className="text-sm">
              Text Tron Netter any time at{" "}
              <a href="sms:+18723504325" className="mono">
                (872) 350-4325
              </a>
              . Reply STOP to opt out.
            </p>
          </div>
        )}

        {notice && !error && (
          <p className="text-center text-sm" style={{ color: "var(--xl-ok)" }}>
            {notice}
          </p>
        )}
        {error && (
          <p className="text-center text-sm" style={{ color: "var(--xl-danger)" }} role="alert">
            {error}
          </p>
        )}
      </div>

      <p className="text-center text-xs" style={{ color: "var(--xl-text-faint)" }}>
        Opting in is optional and not required to use this site. Full details in
        the <Link href="/sms-terms">SMS Terms &amp; Conditions</Link> and{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}
