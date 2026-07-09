"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/use-session";

export function UserMenu() {
  const session = useSession();
  const user = session.user;
  const loading = session.status === "loading";
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  if (loading) {
    return <span className="inline-block h-8 w-16" aria-hidden="true" />;
  }

  if (!user) {
    return (
      <Link href="/login" className="btn btn--text">
        Sign In
      </Link>
    );
  }

  const label = user.displayName || user.email.split("@")[0];

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="btn btn--text flex items-center gap-2 text-xs"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
          style={{ background: "var(--xl-accent, #0ea5a5)", color: "#fff" }}
        >
          {label[0].toUpperCase()}
        </span>
        <span className="max-w-[120px] truncate">{label}</span>
        <svg
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="panel panel--raised absolute right-0 z-50 mt-2 w-52 py-2"
          style={{ padding: "0.5rem 0" }}
        >
          <div className="px-4 py-2 text-xs" style={{ color: "var(--xl-text-faint)" }}>
            <div className="truncate font-medium" style={{ color: "var(--xl-text)" }}>
              {label}
            </div>
            <div className="truncate">{user.email}</div>
          </div>
          <hr className="rule my-1" />
          {user.isAdmin && (
            <Link
              href="/admin/analytics"
              role="menuitem"
              className="block w-full px-4 py-2 text-left text-sm no-underline hover:opacity-70"
              onClick={() => setOpen(false)}
            >
              Admin
            </Link>
          )}
          <button
            onClick={handleSignOut}
            role="menuitem"
            className="block w-full px-4 py-2 text-left text-sm hover:opacity-70"
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
