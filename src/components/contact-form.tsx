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
      <div className="panel panel--lightline text-center">
        <span className="badge badge--ok">
          <span className="dot" /> Message received
        </span>
        <p className="mx-auto mt-4">{state.message}</p>
        <button
          onClick={() => setState({ status: "idle" })}
          className="btn btn--text mt-6"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div className="grid gap-8 sm:grid-cols-2">
        <div className="field">
          <label htmlFor="name">
            Name <span className="glow--sand">*</span>
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
        <div className="field">
          <label htmlFor="email">
            Email <span className="glow--sand">*</span>
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
      <div className="grid gap-8 sm:grid-cols-2">
        <div className="field">
          <label htmlFor="company">Company</label>
          <input
            id="company"
            name="company"
            type="text"
            className="input"
            placeholder="Company name"
          />
        </div>
        <div className="field">
          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            className="input"
            placeholder="(555) 123-4567"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="message">
          Message <span className="glow--sand">*</span>
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
        <p className="text-sm" style={{ color: "var(--xl-danger)" }}>
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={state.status === "submitting"}
        className="btn btn--sand w-full sm:w-auto"
      >
        {state.status === "submitting" ? "Transmitting..." : "Send Message"}
      </button>
    </form>
  );
}
