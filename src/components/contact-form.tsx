"use client";

import { useState } from "react";

interface FormState {
  status: "idle" | "submitting" | "success" | "error";
  message?: string;
}

export function ContactForm() {
  const [state, setState] = useState<FormState>({ status: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ status: "submitting" });

    const form = e.currentTarget;
    const data = new FormData(form);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          company: data.get("company"),
          phone: data.get("phone"),
          message: data.get("message"),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Something went wrong");
      }

      setState({ status: "success", message: "Thank you! We'll be in touch soon." });
      form.reset();
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    }
  }

  if (state.status === "success") {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center dark:border-green-800 dark:bg-green-950/20">
        <p className="font-semibold text-green-800 dark:text-green-300">
          {state.message}
        </p>
        <button
          onClick={() => setState({ status: "idle" })}
          className="mt-3 text-sm text-green-600 underline hover:text-green-800 dark:text-green-400 dark:hover:text-green-300"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Name <span className="text-[var(--xl-cta)]">*</span>
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="input"
            placeholder="Your name"
          />
        </div>
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            Email <span className="text-[var(--xl-cta)]">*</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="input"
            placeholder="you@company.com"
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="company" className="mb-1 block text-sm font-medium">
            Company
          </label>
          <input
            id="company"
            name="company"
            type="text"
            className="input"
            placeholder="Company name"
          />
        </div>
        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium">
            Phone
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            className="input"
            placeholder="(555) 123-4567"
          />
        </div>
      </div>
      <div>
        <label htmlFor="message" className="mb-1 block text-sm font-medium">
          Message <span className="text-[var(--xl-cta)]">*</span>
        </label>
        <textarea
          id="message"
          name="message"
          required
          rows={4}
          className="input"
          placeholder="Tell us how we can help..."
        />
      </div>

      {state.status === "error" && (
        <p className="text-sm text-[var(--xl-cta)]">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={state.status === "submitting"}
        className="btn-cta w-full sm:w-auto"
      >
        {state.status === "submitting" ? "Sending..." : "Send Message"}
      </button>
    </form>
  );
}
