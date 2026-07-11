import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Our Work",
  description:
    "Six real, running AI systems built by XL.net — the Software Brain engine, reusable AI-company middleware, two production sites, and our autonomy experiments.",
  alternates: { canonical: "/work" },
  openGraph: {
    title: "Our Work — XL.net AI",
    description:
      "Six real, running AI systems built by XL.net — the Software Brain engine, reusable AI-company middleware, two production sites, and our autonomy experiments.",
  },
};

function BuildersChip() {
  return (
    <div className="text-center">
      <Link href="/builders" className="btn btn--text no-underline">
        Learn to build things like this →
      </Link>
    </div>
  );
}

export default function WorkPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-16">
      {/* Manifesto strip */}
      <section className="pt-8 text-center">
        <span className="sys-label sys-label--center">Home / Our Work</span>
        <h1 className="mt-8">
          We build with AI, <span className="glow">in the open</span>
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-lg">
          Everything below is real and running, built by a Chicago managed-IT
          firm using AI — including the site you&apos;re reading. Consider this
          a tour of the lab. Tron Netter, in the corner, will answer questions
          about any of it.
        </p>
      </section>

      <hr className="horizon" />

      {/* Group: the engine */}
      <div className="text-center">
        <span className="sys-label sys-label--center">01 · The Engine</span>
      </div>

      {/* 1. Software Brain */}
      <section id="brain" className="panel panel--lightline rise">
        <div className="flex flex-wrap items-center gap-4">
          <span className="badge badge--light">
            <span className="dot" /> Core engine
          </span>
          <span className="badge badge--ok">110 automated checks passing</span>
        </div>
        <h2 className="mt-6">Software Brain</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          The engine behind everything on this page.
        </p>
        <p className="mt-4 text-sm">
          A conversation-first, memory-bearing, tool-using AI architecture
          modeled on neurological principles, built as a TypeScript monorepo.
          It is rebuild-ready by design: a canonical architecture document
          specifies the whole system in enough detail that a competent team
          could reconstruct it from the document alone. Every other exhibit
          below runs on it.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          TypeScript monorepo · scoped memory · voice (STT/TTS/realtime) ·
          canonical architecture doc v17
        </p>
      </section>

      {/* Group: what it runs */}
      <div className="text-center">
        <span className="sys-label sys-label--center">02 · What It Runs</span>
      </div>

      {/* 2. @aicompany/core */}
      <section id="aicompany" className="panel rise">
        <span className="badge badge--light">
          <span className="dot" /> Middleware · 2 production sites
        </span>
        <h2 className="mt-6">@aicompany/core</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          An entire AI-company website in one config file.
        </p>
        <p className="mt-4 text-sm">
          Reusable middleware that gives any business an AI persona across web
          chat, SMS, email, and voice — plus OAuth sign-in, an admin console,
          first-party analytics, SEO surfaces, a nightly knowledge crawler, and
          a single-VM deploy stack. One <span className="mono">site.config.ts</span>{" "}
          drives all of it. It ships today as a git submodule inside two live
          production sites: this one and IT Support Chicago.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          chat / SMS / email / voice · admin console · analytics · nightly
          crawler · one config file
        </p>
      </section>

      {/* 3. ai.xl.net */}
      <section id="aiwebsite" className="panel panel--lightline rise">
        <span className="badge badge--ok">
          <span className="dot" /> Live — you&apos;re on it
        </span>
        <h2 className="mt-6">ai.xl.net</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          The site you&apos;re reading right now — our maximum-oversight
          deployment.
        </p>
        <p className="mt-4 text-sm">
          Every constraint here is a decision, not a limitation. Every email
          our AI sends is BCC&apos;d to a human — so nothing leaves
          unreviewed. The public persona has no tools and no live internet
          access — so it can never take an action we haven&apos;t designed.
          Its knowledge is a nightly crawl of xl.net and ai.xl.net — so it
          only speaks about what we publish. Safe by architecture, not by
          promise. Try it: chat, text, email, or call Tron Netter on this
          page.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          human BCC on all outbound email · no tools, no internet · nightly
          knowledge crawl · single Azure VM behind a Cloudflare tunnel
        </p>
      </section>

      {/* 4. IT Support Chicago */}
      <section id="itsupportchicago" className="panel rise">
        <span className="badge badge--warn">
          <span className="dot" /> Autonomy experiment
        </span>
        <h2 className="mt-6">IT Support Chicago</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          Our controlled autonomy experiment — the deliberate opposite of the
          site you&apos;re on.
        </p>
        <p className="mt-4 text-sm">
          itsupportchicago.net was designed as a test of a 100% autonomous
          organization: how far can an AI-run operation go with no human in
          the loop? It runs sandboxed, on its own hardened infrastructure —
          a GCP confidential VM with AMD SEV memory encryption, Shielded VM
          boot integrity, IAP-only SSH, and deny-all ingress — fully separate
          from XL.net client systems. Maximum oversight here, maximum autonomy
          there: we run both, on purpose, to learn where the line is.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          GCP confidential VM (AMD SEV) · Shielded VM · IAP-only SSH ·
          deny-all ingress
        </p>
        <a
          href="https://itsupportchicago.net"
          target="_blank"
          rel="noopener noreferrer"
          className="btn mt-6 no-underline"
        >
          Visit itsupportchicago.net
        </a>
      </section>

      <BuildersChip />

      {/* Group: what we're testing */}
      <div className="text-center">
        <span className="sys-label sys-label--center">
          03 · What We&apos;re Testing
        </span>
      </div>

      {/* 5. Roleplay */}
      <section id="roleplay" className="panel rise">
        <span className="badge badge--light">
          <span className="dot" /> Public · sign-in with approval
        </span>
        <h2 className="mt-6">Roleplay</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          A public multi-user AI playground running directly on the Brain SDK.
        </p>
        <p className="mt-4 text-sm">
          roleplay.xl.net is our external-tenant experiment: the Software
          Brain&apos;s orchestrator, memory, and voice packages running
          in-process to power multi-user AI roleplay, with real-time voice via
          STT/TTS and xAI realtime. Google sign-in with admin approval gates
          entry, and the tenant&apos;s data lives in its own isolated
          databases, completely separate from everything else we run — your
          data stays yours.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          Brain SDK in-process · realtime voice · Google sign-in + approval ·
          isolated per-tenant databases
        </p>
        <a
          href="https://roleplay.xl.net"
          target="_blank"
          rel="noopener noreferrer"
          className="btn mt-6 no-underline"
        >
          Visit roleplay.xl.net
        </a>
      </section>

      {/* 6. Leo Netter */}
      <section id="leo-netter" className="panel panel--lightline rise">
        <span className="badge">
          <span className="dot" /> Internal test
        </span>
        <h2 className="mt-6">Leo Netter</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          The AI teammate we test on ourselves first.
        </p>
        <p className="mt-4 text-sm">
          Leo Netter is an internal-only Slack bot test: a Slack DM-only,
          memory-bearing assistant for the XL.net team, built on the Brain
          SDK. It never talks to customers — it exists so we hit the rough
          edges before anyone else does. Its development is governed by a
          strict architecture-is-canonical contract: every behavior, tool, and
          test is written into the architecture document before code lands.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          Slack DM-only · internal to the XL.net team · architecture-is-canonical
          governance
        </p>
      </section>

      {/* Closing CTA */}
      <section className="beams panel--void relative overflow-hidden text-center">
        <div className="relative z-10 mx-auto max-w-2xl px-6">
          <span className="sys-label sys-label--sand sys-label--center">
            Your Turn
          </span>
          <h2 className="mt-8">Want to build things like this?</h2>
          <p className="mx-auto mt-6">
            You just toured our lab. We teach teams to build their own AI
            workflows and automations — the smart and safe way.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-6">
            <Link href="/builders" className="btn btn--sand no-underline">
              Join the AI Builders
            </Link>
            <Link href="/contact" className="btn no-underline">
              Ask us anything
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
