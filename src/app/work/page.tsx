import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Our Work",
  description:
    "Ten real, running AI systems built by XL.net — the Software Brain engine, reusable AI-company middleware, two production sites, the QBR and onboarding client-delivery platforms, the vault-backed access layer behind them, and our autonomy experiments.",
  alternates: { canonical: "/work" },
  openGraph: {
    title: "Our Work — XL.net AI",
    description:
      "Ten real, running AI systems built by XL.net — the Software Brain engine, reusable AI-company middleware, two production sites, the QBR and onboarding client-delivery platforms, the vault-backed access layer behind them, and our autonomy experiments.",
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

      {/* Group: client delivery */}
      <div className="text-center">
        <span className="sys-label sys-label--center">
          03 · Client Delivery
        </span>
      </div>

      {/* 5. QBR Machine */}
      <section id="qbr-machine" className="panel panel--lightline rise">
        <div className="flex flex-wrap items-center gap-4">
          <span className="badge badge--ok">
            <span className="dot" /> In production
          </span>
          <span className="badge badge--light">Live client pipeline</span>
        </div>
        <h2 className="mt-6">QBR Machine</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          A client name in — a complete quarterly review package out.
        </p>
        <p className="mt-4 text-sm">
          The AI teammate working alongside our XL.net Technology Officers.
          Not a chatbot
          bolted onto a form: Claude Code running purpose-built, git-versioned
          skills that produce the actual deliverables XL.net presents to
          clients every quarter — sourced from live systems, with every number
          traceable to where it came from.
        </p>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <div className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--xl-light)" }}>
              <span style={{ color: "var(--xl-text-faint)" }}>01 · </span>
              Gap Analysis
            </h3>
            <p className="mt-3 text-sm">
              A scored assessment of the client&apos;s security, network,
              server, and workstation environment — validated and self-tested
              before a human ever sees it.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--xl-light)" }}>
              <span style={{ color: "var(--xl-text-faint)" }}>02 · </span>
              Asset Strategy
            </h3>
            <p className="mt-3 text-sm">
              A lifecycle plan for every asset: when the firewall gets
              replaced, when the switch stack ages out, what it costs and
              when.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--xl-light)" }}>
              <span style={{ color: "var(--xl-text-faint)" }}>03 · </span>
              QBR Deck
            </h3>
            <p className="mt-3 text-sm">
              The client-facing review itself: a frozen 11-slide template
              where only the words change — fed real numbers from the Gap
              Analysis and Asset Strategy, not estimates.
            </p>
          </div>
        </div>
        <p className="mt-8 text-sm">
          Every provider connection runs through{" "}
          <a href="#lakehouse">XL Lakehouse</a>, our scoped and
          audited access layer — no provider API keys ever live in the
          AI&apos;s workspace. Its memory persists, too: client context,
          feedback, and working agreements carry forward quarter to quarter
          instead of resetting every conversation.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          Claude Code + git-versioned skills · template-locked workbooks +
          frozen 11-slide deck · validate → approve → self-test · XL Lakehouse
          scoped access
        </p>
      </section>

      {/* 6. Onboarding Toolkit */}
      <section id="onboarding-toolkit" className="panel rise">
        <div className="flex flex-wrap items-center gap-4">
          <span className="badge badge--ok">
            <span className="dot" /> In production
          </span>
          <span className="badge badge--light">Live client pipeline</span>
        </div>
        <h2 className="mt-6">Onboarding Toolkit</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          A client name in — a documented IT environment out.
        </p>
        <p className="mt-4 text-sm">
          The platform XL.net techs use on every new MSP onboarding. One place
          to discover the network, capture identity and cloud posture,
          validate completeness, and generate client runbooks — sourced from
          on-site scans, cloud connectors, and uploaded vendor reports, with
          every field traceable to where it came from.
        </p>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <div className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--xl-light)" }}>
              <span style={{ color: "var(--xl-text-faint)" }}>01 · </span>
              Discovery
            </h3>
            <p className="mt-3 text-sm">
              On-site network scans, M365 tenants, and uploaded vendor reports
              merge into one inventory — deduplicated, classified, and ready
              for review.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--xl-light)" }}>
              <span style={{ color: "var(--xl-text-faint)" }}>02 · </span>
              Intake &amp; Review
            </h3>
            <p className="mt-3 text-sm">
              Structured forms capture what automation misses. A review
              dashboard shows what&apos;s complete, what&apos;s open, and
              what&apos;s still blocking export.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--xl-light)" }}>
              <span style={{ color: "var(--xl-text-faint)" }}>03 · </span>
              Runbooks
            </h3>
            <p className="mt-3 text-sm">
              Client IT runbooks — new hires, terminations, patch policy, LOB
              apps — pre-fill from discovery data and refine with AI before
              export to documentation.
            </p>
          </div>
        </div>
        <p className="mt-8 text-sm">
          Client data stays scoped to the project: SSO login, a full audit
          trail, human approval on every change. An in-app AI assistant
          proposes edits — nothing writes until a tech approves it.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          on-site discovery · cloud connectors · AI-assisted runbooks ·
          human-in-the-loop · audit everything
        </p>
      </section>

      <BuildersChip />

      {/* Group: the access layer */}
      <div className="text-center">
        <span className="sys-label sys-label--center">
          04 · The Access Layer
        </span>
      </div>

      {/* 7. XL Lakehouse */}
      <section id="lakehouse" className="panel panel--lightline rise">
        <div className="flex flex-wrap items-center gap-4">
          <span className="badge badge--ok">
            <span className="dot" /> In production
          </span>
          <span className="badge badge--light">Internal platform</span>
        </div>
        <h2 className="mt-6">XL Lakehouse</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          A scoped tool request in — a traceable upstream call out.
        </p>
        <p className="mt-4 text-sm">
          The access layer behind every XL.net AI teammate. Instead of
          scattering provider keys across workspaces, internal apps connect
          once to Lakehouse — which holds the credentials, enforces what each
          app is allowed to touch, and makes every upstream call itself, so
          secrets never leave the vault.
        </p>
        <div className="mt-8">
          <div className="border-t border-[var(--xl-line)] py-4 md:flex md:items-baseline md:gap-8">
            <h3
              className="mono text-xs uppercase tracking-[0.2em] md:w-44 md:flex-shrink-0"
              style={{ color: "var(--xl-light)" }}
            >
              <span style={{ color: "var(--xl-text-faint)" }}>01 · </span>
              Scoped Access
            </h3>
            <p className="mt-3 text-sm md:mt-0">
              Each AI workspace gets only the providers and operations it
              needs — nothing broader, nothing permanent without approval.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] py-4 md:flex md:items-baseline md:gap-8">
            <h3
              className="mono text-xs uppercase tracking-[0.2em] md:w-44 md:flex-shrink-0"
              style={{ color: "var(--xl-light)" }}
            >
              <span style={{ color: "var(--xl-text-faint)" }}>02 · </span>
              Curated Tools
            </h3>
            <p className="mt-3 text-sm md:mt-0">
              Common workflows ship as ready-made playbooks with guardrails:
              reads enabled, writes off by default, destructive actions
              structurally absent.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] py-4 md:flex md:items-baseline md:gap-8">
            <h3
              className="mono text-xs uppercase tracking-[0.2em] md:w-44 md:flex-shrink-0"
              style={{ color: "var(--xl-light)" }}
            >
              <span style={{ color: "var(--xl-text-faint)" }}>03 · </span>
              Audit Trail
            </h3>
            <p className="mt-3 text-sm md:mt-0">
              Every call is logged with who asked, which app, which
              credential, and what happened — so access can be reviewed,
              rotated, and revoked without guesswork.
            </p>
          </div>
        </div>
        <p className="mt-8 text-sm">
          Provider keys live in a dedicated secrets vault, not in
          anyone&apos;s chat session. Humans approve new apps and expanded
          access, and credentials stay tied to the person responsible for
          them. When the <a href="#qbr-machine">QBR Machine</a> pulls live
          Autotask and VSA numbers, it goes through here — so the deliverable
          stays traceable end to end.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          scoped access · per-human credentials · write-default-off · full
          audit log · self-service access requests
        </p>
      </section>

      {/* 8. XL API Gateway */}
      <section id="api-gateway" className="panel rise">
        <div className="flex flex-wrap items-center gap-4">
          <span className="badge">
            <span className="dot" /> In development
          </span>
          <span className="badge badge--light">Console live</span>
        </div>
        <h2 className="mt-6">XL API Gateway</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
          A consumer request in — an authenticated upstream API call out.
        </p>
        <p className="mt-4 text-sm">
          The platform XL.net uses to deploy and run API gateways inside each
          client&apos;s own cloud — so Cursor workspaces, internal tools, and
          developer VMs call one local proxy instead of scattering provider
          keys across every machine. Operators onboard a client once,
          provision a site from the console, and wire who may reach which
          upstream API from a single place. The console is live; client
          gateways are deploying now.
        </p>
        <div className="mt-8">
          <div className="border-t border-[var(--xl-line)] py-4 md:flex md:items-baseline md:gap-8">
            <h3
              className="mono text-xs uppercase tracking-[0.2em] md:w-44 md:flex-shrink-0"
              style={{ color: "var(--xl-light)" }}
            >
              <span style={{ color: "var(--xl-text-faint)" }}>01 · </span>
              Deploy
            </h3>
            <p className="mt-3 text-sm md:mt-0">
              Provision a gateway — and optional locked-down developer VMs —
              into the client&apos;s own subscription, with live health
              visibility and a controlled path to take a site down.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] py-4 md:flex md:items-baseline md:gap-8">
            <h3
              className="mono text-xs uppercase tracking-[0.2em] md:w-44 md:flex-shrink-0"
              style={{ color: "var(--xl-light)" }}
            >
              <span style={{ color: "var(--xl-text-faint)" }}>02 · </span>
              Govern Access
            </h3>
            <p className="mt-3 text-sm md:mt-0">
              Register consumer apps, map upstream providers, store
              credentials in the client&apos;s vault, and grant access per
              app — deactivated credentials fail closed, and every change
              leaves an audit trail.
            </p>
          </div>
          <div className="border-t border-[var(--xl-line)] py-4 md:flex md:items-baseline md:gap-8">
            <h3
              className="mono text-xs uppercase tracking-[0.2em] md:w-44 md:flex-shrink-0"
              style={{ color: "var(--xl-light)" }}
            >
              <span style={{ color: "var(--xl-text-faint)" }}>03 · </span>
              Route Traffic
            </h3>
            <p className="mt-3 text-sm md:mt-0">
              The gateway checks each caller&apos;s identity and permissions,
              attaches the right credential, forwards the request upstream,
              and returns the response unchanged — usage counted per app,
              provider, and credential.
            </p>
          </div>
        </div>
        <p className="mt-8 text-sm">
          Secrets never sit in the console database or in developer
          workspaces: they are fetched from the client&apos;s vault only when
          a permitted request needs them, verified before go-live, and cut
          off the moment a grant or credential is revoked. Fleet alerts and
          scheduled updates keep sites current — no mailing API keys around.
        </p>
        <p className="mono mt-6 text-xs" style={{ color: "var(--xl-text-faint)" }}>
          per-client isolation · vault-backed credentials · grant-checked
          proxy · audited fleet operations
        </p>
      </section>

      {/* Group: what we're testing */}
      <div className="text-center">
        <span className="sys-label sys-label--center">
          05 · What We&apos;re Testing
        </span>
      </div>

      {/* 9. Roleplay */}
      <section id="roleplay" className="panel panel--lightline rise">
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

      {/* 10. Leo Netter */}
      <section id="leo-netter" className="panel rise">
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
