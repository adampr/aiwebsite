import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Our Work",
  description:
    "Twenty real AI systems running in the open at XL.net: engine, middleware, live sites, client platforms, access layers, and a public AI governance writer.",
  alternates: { canonical: "/work" },
  openGraph: {
    title: "Our Work | XL.net AI",
    description:
      "Twenty real AI systems running in the open at XL.net: engine, middleware, live sites, client platforms, access layers, and a public AI governance writer.",
  },
};

function BuildersChip() {
  return (
    <div className="text-center">
      <Link href="/builders" className="btn btn--text no-underline">
        Learn to build things like this <span aria-hidden="true">→</span>
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
          firm using AI, including the site you&apos;re reading. Consider this
          a tour of the lab. Tron Netter, in the corner, will answer questions
          about any of it.
        </p>
      </section>

      <hr className="horizon" />

      {/* Group: the engine */}
      <section aria-label="The Engine" className="space-y-16">
        <div className="text-center">
          <span className="sys-label sys-label--center">01 · The Engine</span>
        </div>

        {/* 1. Software Brain */}
        <section id="brain" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> 110 automated checks passing
            </span>
            <span className="badge badge--light">Core engine</span>
          </div>
          <h2 className="mt-6">Software Brain</h2>
          <p className="mt-2 text-sm text-faint">
            The engine behind everything on this page.
          </p>
          <p className="mt-4 text-sm">
            A conversation-first, memory-bearing, tool-using AI architecture
            modeled on neurological principles, built as a TypeScript monorepo.
            Every other exhibit below runs on it.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Memory
              </h3>
              <p className="mt-3 text-sm">
                Scoped memory that persists across conversations, so every
                system built on the Brain remembers what matters instead of
                starting from zero each time.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Voice
              </h3>
              <p className="mt-3 text-sm">
                A full voice stack: speech-to-text, text-to-speech, and
                realtime conversation, the same packages that let you call
                Tron Netter from this page.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Rebuild-Ready
              </h3>
              <p className="mt-3 text-sm">
                A canonical architecture document specifies the whole system in
                enough detail that a competent team could reconstruct it from
                the document alone.
              </p>
            </div>
          </div>
          <p className="mono mt-6 text-xs text-faint">
            TypeScript monorepo · scoped memory · voice (STT/TTS/realtime) ·
            canonical architecture doc v17
          </p>
        </section>
      </section>

      {/* Group: what it runs */}
      <section aria-label="What It Runs" className="space-y-16">
        <div className="text-center">
          <span className="sys-label sys-label--center">02 · What It Runs</span>
        </div>

        {/* 2. @aicompany/core */}
        <section id="aicompany" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · 2 production sites
            </span>
            <span className="badge badge--light">Middleware</span>
          </div>
          <h2 className="mt-6">@aicompany/core</h2>
          <p className="mt-2 text-sm text-faint">
            An entire AI-company website in one config file.
          </p>
          <p className="mt-4 text-sm">
            Reusable middleware that gives any business an AI persona and
            everything a working AI company site needs around it. It ships
            today as a git submodule inside two live production sites: this one
            and IT Support Chicago.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Every Channel
              </h3>
              <p className="mt-3 text-sm">
                One persona across web chat, SMS, email, and voice, plus OAuth
                sign-in for visitors who want an account.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                The Whole Site
              </h3>
              <p className="mt-3 text-sm">
                An admin console, first-party analytics, SEO surfaces, a
                nightly knowledge crawler, and a single-VM deploy stack come
                with it.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                One Config File
              </h3>
              <p className="mt-3 text-sm">
                A single <span className="mono">site.config.ts</span> drives
                all of it: the host site supplies the config, the middleware
                does the rest.
              </p>
            </div>
          </div>
          <p className="mono mt-6 text-xs text-faint">
            chat / SMS / email / voice · admin console · analytics · nightly
            crawler · one config file
          </p>
        </section>

        {/* 3. ai.xl.net */}
        <section id="aiwebsite" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" />{" "}Live · you&apos;re on it
            </span>
          </div>
          <h2 className="mt-6">ai.xl.net</h2>
          <p className="mt-2 text-sm text-faint">
            The site you&apos;re reading right now: our maximum-oversight
            deployment.
          </p>
          <p className="mt-4 text-sm">
            Every constraint here is a decision, not a limitation. Safe by
            architecture, not by promise.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Human BCC
              </h3>
              <p className="mt-3 text-sm">
                Every email our AI sends is BCC&apos;d to a human, so nothing
                leaves unreviewed.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                No Tools, No Internet
              </h3>
              <p className="mt-3 text-sm">
                The public persona has no tools and no live internet access,
                so it can never take an action we haven&apos;t designed.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Published Knowledge Only
              </h3>
              <p className="mt-3 text-sm">
                Its knowledge is a nightly crawl of xl.net and ai.xl.net, so
                it only speaks about what we publish.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Try it: chat, text, email, or call Tron Netter on this page.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            human BCC on all outbound email · no tools, no internet · nightly
            knowledge crawl · single Azure VM behind a Cloudflare tunnel
          </p>
        </section>

        {/* 4. AI Governance Writer */}
        <section id="governance" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · public
            </span>
            <span className="badge badge--light">Sign in to create</span>
          </div>
          <h2 className="mt-6">AI Governance Writer</h2>
          <p className="mt-2 text-sm text-faint">
            A governance draft written with you, one question at a time, on
            screen as you answer.
          </p>
          <p className="mt-4 text-sm">
            A workbench where you and Tron Netter write your AI governance
            together. Pick one: a single AI Acceptable Use Policy (AUP), or a
            working-draft
            set of core documents for NIST AI RMF, the EU AI Act, or ISO/IEC
            42001, seven to ten documents per set. It runs right here on{" "}
            <a href="#aiwebsite">ai.xl.net</a>, drafting through the{" "}
            <a href="#brain">Software Brain</a>.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Researched First
              </h3>
              <p className="mt-3 text-sm">
                Before the first question, Tron reads your website, what the
                web says about you, and your industry, so the draft starts
                from your reality instead of a template.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Nothing Silently Accepted
              </h3>
              <p className="mt-3 text-sm">
                When coverage is complete the UI flips to review, and every
                assumption Tron flagged in the draft must be resolved by you
                before a final can exist. Downloads carry a DRAFT watermark
                until you confirm.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Yours, Then Gone
              </h3>
              <p className="mt-3 text-sm">
                Only the extracted text of a sample you upload is stored,
                never the file. Delete a project instantly, anytime;
                otherwise it hard-deletes 30 days after your last activity.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Upload a sample policy and the writer adopts its formatting,
            structure, and numbering. Word-friendly downloads (.docx, or .zip
            for the sets) work in every state. Drafts are a working starting
            point for your leadership and counsel to review, not legal
            advice. Sign in with Google or Microsoft to create a project.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            researched first · one question at a time · live side-by-side
            draft · zero unresolved items on finals · .docx / .zip in every
            state · 30-day hard delete
          </p>
          <Link href="/governance" className="btn mt-6 no-underline">
            Start your governance draft
          </Link>
        </section>

        {/* 5. IT Support Chicago */}
        <section id="itsupportchicago" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--warn">
              <span className="dot" /> Autonomy experiment
            </span>
          </div>
          <h2 className="mt-6">IT Support Chicago</h2>
          <p className="mt-2 text-sm text-faint">
            Our controlled autonomy experiment: the deliberate opposite of the
            site you&apos;re on.
          </p>
          <p className="mt-4 text-sm">
            itsupportchicago.net was designed as a test of a 100% autonomous
            organization: how far can an AI-run operation go with no human in
            the loop?
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Maximum Autonomy
              </h3>
              <p className="mt-3 text-sm">
                No human in the loop: the experiment exists to find out how
                far an AI-run operation can go on its own.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Hardened Sandbox
              </h3>
              <p className="mt-3 text-sm">
                A GCP confidential VM with AMD SEV memory encryption, Shielded
                VM boot integrity, IAP-only SSH, and deny-all ingress.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Fully Separate
              </h3>
              <p className="mt-3 text-sm">
                Its own infrastructure, completely separate from XL.net client
                systems, so the experiment can fail safely.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Maximum oversight here, maximum autonomy there: we run both, on
            purpose, to learn where the line is.
          </p>
          <p className="mono mt-6 text-xs text-faint">
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
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </section>
      </section>

      {/* Group: client delivery */}
      <section aria-label="Client Delivery" className="space-y-16">
        <div className="text-center">
          <span className="sys-label sys-label--center">
            03 · Client Delivery
          </span>
        </div>

        {/* 6. QBR Machine */}
        <section id="qbr-machine" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> In production
            </span>
            <span className="badge badge--light">Live client pipeline</span>
          </div>
          <h2 className="mt-6">QBR Machine</h2>
          <p className="mt-2 text-sm text-faint">
            A client name in, a complete quarterly review package out.
          </p>
          <p className="mt-4 text-sm">
            The AI teammate working alongside our XL.net Technology Officers.
            Not a chatbot bolted onto a form: Claude Code running purpose-built,
            git-versioned skills that produce the actual deliverables XL.net
            presents to clients every quarter, sourced from live systems, with
            every number traceable to where it came from.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Gap Analysis
              </h3>
              <p className="mt-3 text-sm">
                A scored assessment of the client&apos;s security, network,
                server, and workstation environment, validated and self-tested
                before a human ever sees it.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Asset Strategy
              </h3>
              <p className="mt-3 text-sm">
                A lifecycle plan for every asset: when the firewall gets
                replaced, when the switch stack ages out, what it costs and
                when.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                QBR Deck
              </h3>
              <p className="mt-3 text-sm">
                The client-facing review itself: a frozen 11-slide template
                where only the words change, fed real numbers from the Gap
                Analysis and Asset Strategy, not estimates.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Every provider connection runs through{" "}
            <a href="#lakehouse">XL Lakehouse</a>, our scoped and audited
            access layer. No provider API keys ever live in the AI&apos;s
            workspace. Its memory persists, too: client context, feedback, and
            working agreements carry forward quarter to quarter instead of
            resetting every conversation.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Claude Code · git-versioned skills · template-locked deliverables ·
            validate, approve, self-test · Lakehouse-scoped access
          </p>
        </section>

        {/* 7. Onboarding Toolkit */}
        <section id="onboarding-toolkit" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> In production
            </span>
            <span className="badge badge--light">Live client pipeline</span>
          </div>
          <h2 className="mt-6">Onboarding Toolkit</h2>
          <p className="mt-2 text-sm text-faint">
            A client name in, a documented IT environment out.
          </p>
          <p className="mt-4 text-sm">
            The platform XL.net techs use on every new MSP onboarding. One place
            to discover the network, capture identity and cloud posture,
            validate completeness, and generate client runbooks, sourced from
            on-site scans, cloud connectors, and uploaded vendor reports, with
            every field traceable to where it came from.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Discovery
              </h3>
              <p className="mt-3 text-sm">
                On-site network scans, M365 tenants, and uploaded vendor reports
                merge into one inventory: deduplicated, classified, and ready
                for review.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Intake &amp; Review
              </h3>
              <p className="mt-3 text-sm">
                Structured forms capture what automation misses. A review
                dashboard shows what&apos;s complete, what&apos;s open, and
                what&apos;s still blocking export.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Runbooks
              </h3>
              <p className="mt-3 text-sm">
                Client IT runbooks (new hires, terminations, patch policy, LOB
                apps) pre-fill from discovery data and refine with AI before
                export to documentation.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Client data stays scoped to the project: SSO login, a full audit
            trail, human approval on every change. An in-app AI assistant
            proposes edits; nothing writes until a tech approves it.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            on-site discovery · cloud connectors · AI-assisted runbooks ·
            human-in-the-loop · audit everything
          </p>
        </section>
      </section>

      <BuildersChip />

      {/* Group: the access layer */}
      <section aria-label="The Access Layer" className="space-y-16">
        <div className="text-center">
          <span className="sys-label sys-label--center">
            04 · The Access Layer
          </span>
        </div>

        {/* 8. XL Lakehouse */}
        <section id="lakehouse" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> In production
            </span>
            <span className="badge badge--light">Internal platform</span>
          </div>
          <h2 className="mt-6">XL Lakehouse</h2>
          <p className="mt-2 text-sm text-faint">
            One vault holds every key; apps borrow access, never secrets.
          </p>
          <p className="mt-4 text-sm">
            The access layer behind every XL.net AI teammate. Instead of
            scattering provider keys across workspaces, internal apps connect
            once to Lakehouse, which holds the credentials, enforces what each
            app is allowed to touch, and makes every upstream call itself, so
            secrets never leave the vault.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Scoped Access
              </h3>
              <p className="mt-3 text-sm">
                Each AI workspace gets only the providers and operations it
                needs: nothing broader, nothing permanent without approval.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Curated Tools
              </h3>
              <p className="mt-3 text-sm">
                Common workflows ship as ready-made playbooks with guardrails:
                reads enabled, writes off by default, destructive actions
                structurally absent.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Audit Trail
              </h3>
              <p className="mt-3 text-sm">
                Every call is logged with who asked, which app, which
                credential, and what happened, so access can be reviewed,
                rotated, and revoked without guesswork.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Provider keys live in a dedicated secrets vault, not in
            anyone&apos;s chat session. Humans approve new apps and expanded
            access, and credentials stay tied to the person responsible for
            them. When the <a href="#qbr-machine">QBR Machine</a> pulls live
            Autotask and VSA numbers, it goes through here, so the deliverable
            stays traceable end to end.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            scoped access · per-human credentials · write-default-off · full
            audit log · self-service access requests
          </p>
        </section>

        {/* 9. XL API Gateway */}
        <section id="api-gateway" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge">
              <span className="dot" /> In development
            </span>
            <span className="badge badge--light">Console live</span>
          </div>
          <h2 className="mt-6">XL API Gateway</h2>
          <p className="mt-2 text-sm text-faint">
            Your cloud, your keys, one governed front door.
          </p>
          <p className="mt-4 text-sm">
            What <a href="#lakehouse">XL Lakehouse</a>{" "}
            does inside XL.net, the Gateway does inside each
            client&apos;s own cloud: one local proxy
            that Cursor workspaces, internal tools, and developer VMs call
            instead of holding provider keys themselves. Operators onboard a
            client once, provision a site from the console, and wire who may
            reach which upstream API from a single place. The console is live;
            client gateways are deploying now.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Deploy
              </h3>
              <p className="mt-3 text-sm">
                Provision a gateway (and optional locked-down developer VMs)
                into the client&apos;s own subscription, with live health
                visibility and a controlled path to take a site down.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Govern Access
              </h3>
              <p className="mt-3 text-sm">
                Register consumer apps, map upstream providers, store
                credentials in the client&apos;s vault, and grant access per
                app. Deactivated credentials fail closed, and every change
                leaves an audit trail.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Route Traffic
              </h3>
              <p className="mt-3 text-sm">
                The gateway checks each caller&apos;s identity and permissions,
                attaches the right credential, forwards the request upstream,
                and returns the response unchanged, with usage counted per app,
                provider, and credential.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Secrets never sit in the console database or in developer
            workspaces: they are fetched from the client&apos;s vault only when
            a permitted request needs them, verified before go-live, and cut
            off the moment a grant or credential is revoked. Fleet alerts and
            scheduled updates keep sites current; no API keys get mailed
            around.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            per-client isolation · vault-backed credentials · grant-checked
            proxy · audited fleet operations
          </p>
        </section>
      </section>

      {/* Group: what we're testing */}
      <section aria-label="What We're Testing" className="space-y-16">
        <div className="text-center">
          <span className="sys-label sys-label--center">
            05 · What We&apos;re Testing
          </span>
        </div>

        {/* 10. Roleplay */}
        <section id="roleplay" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · public
            </span>
            <span className="badge badge--light">Sign-in with approval</span>
          </div>
          <h2 className="mt-6">Roleplay</h2>
          <p className="mt-2 text-sm text-faint">
            A public multi-user AI playground running directly on the Brain SDK.
          </p>
          <p className="mt-4 text-sm">
            roleplay.xl.net is our external-tenant experiment: what happens
            when the Software Brain powers a product that isn&apos;t about
            XL.net at all.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Brain SDK In-Process
              </h3>
              <p className="mt-3 text-sm">
                The Software Brain&apos;s orchestrator, memory, and voice
                packages run inside the app itself to power multi-user AI
                roleplay.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Realtime Voice
              </h3>
              <p className="mt-3 text-sm">
                Live voice via STT/TTS and the xAI realtime API, so characters
                can speak, not just type.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Gated and Isolated
              </h3>
              <p className="mt-3 text-sm">
                Google sign-in with admin approval gates entry, and the
                tenant&apos;s data lives in its own isolated databases: your
                data stays yours.
              </p>
            </div>
          </div>
          <p className="mono mt-6 text-xs text-faint">
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
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </section>

        {/* 11. Leo Netter */}
        <section id="leo-netter" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge">
              <span className="dot" /> Internal test
            </span>
          </div>
          <h2 className="mt-6">Leo Netter</h2>
          <p className="mt-2 text-sm text-faint">
            The AI teammate we test on ourselves first.
          </p>
          <p className="mt-4 text-sm">
            Leo Netter is our internal test bot: a memory-bearing assistant
            built on the Brain SDK, deployed to the people most likely to
            complain about it: us.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Slack DMs Only
              </h3>
              <p className="mt-3 text-sm">
                It lives only in Slack DMs for the XL.net team and never talks
                to customers.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Rough Edges First
              </h3>
              <p className="mt-3 text-sm">
                It exists so we hit the rough edges of a memory-bearing AI
                teammate before anyone else does.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Architecture Is Canonical
              </h3>
              <p className="mt-3 text-sm">
                Every behavior, tool, and test is written into the
                architecture document before code lands.
              </p>
            </div>
          </div>
          <p className="mono mt-6 text-xs text-faint">
            Slack DM-only · internal to the XL.net team · architecture-is-canonical
            governance
          </p>
        </section>

        {/* 12. SpamSlayer */}
        <section id="spamslayer" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Security tool</span>
          </div>
          <h2 className="mt-6">SpamSlayer</h2>
          <p className="mt-2 text-sm text-faint">
            Is this email safe to open? A five-second answer, in Slack.
          </p>
          <p className="mt-4 text-sm">
            A phishing-triage bot the team runs on itself. DM it a suspicious
            email, @mention it in any thread, or forward one into a channel, and
            it returns a clear verdict (Safe, Likely safe, Suspicious, or
            Dangerous), a recommended action, and the specific reasons behind
            the call. It turns &quot;hey, is this real?&quot; into a self-serve
            check with reasoning good enough to teach on.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Four Checks
              </h3>
              <p className="mt-3 text-sm">
                Sender and headers, phishing language and impersonation, URL
                safety, and attachment risk: four checks on every message, from
                a pasted email, raw headers, a bare URL, or a dropped .eml or
                .msg file.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Never Clicks the Link
              </h3>
              <p className="mt-3 text-sm">
                It judges a URL by its structure and destination, never by
                visiting it, and compares the visible link text to the real
                href: the tell on most credential-harvest emails, caught without
                handing attackers a fingerprint of the tool.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Errs Toward Caution
              </h3>
              <p className="mt-3 text-sm">
                Verdict first, reasoning below. When the evidence is mixed it
                returns Suspicious, not Likely safe: a false alarm costs a
                moment, a miss costs an account.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The same analysis rubric ships as a standalone Claude Skill
            (email-safety-check), so the exact logic also runs on a file inside
            a desktop Claude session, not just in the bot. It listens over an
            outbound WebSocket with no inbound ports of its own, and runs
            sandboxed on a low-cost VPS.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Python · slack-bolt (Socket Mode) · Claude Sonnet · .eml / .msg
            parsing · sandboxed systemd VPS · also a Claude Skill
          </p>
        </section>

        {/* 13. TicketScribe */}
        <section id="ticketscribe" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">TicketScribe</h2>
          <p className="mt-2 text-sm text-faint">
            Clean notes from messy tickets, and handoffs that carry facts
            instead of conclusions.
          </p>
          <p className="mt-4 text-sm">
            A Claude Skill used live on our own service desk. Paste raw
            troubleshooting activity (a call recap, DNS lookups, PowerShell
            output, admin center findings) into a Claude session and it kicks
            in, returning a chronological ticket note with findings stated
            inline, or, when you&apos;re handing the issue off, an escalation
            message stripped down to observable facts.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Chronological, Every Ticket
              </h3>
              <p className="mt-3 text-sm">
                However scrambled the input, the note comes back in time
                order, each finding noted where it happened, in the same
                format on every ticket, rushed or not. That is exactly what
                matters when someone else picks it up mid-issue.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Facts-Only Handoffs
              </h3>
              <p className="mt-3 text-sm">
                Escalations to other teams and vendors carry observed facts,
                not conclusions. A handoff that carries your conclusion makes
                the receiver react to your conclusion instead of diagnosing
                the problem, and that is what causes the rework when a
                handoff goes wrong.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                The Hypothesis Stays Home
              </h3>
              <p className="mt-3 text-sm">
                The thinking isn&apos;t thrown away: any working hypothesis
                comes back separately, as analysis for the tech sending the
                message, never folded into the message itself.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Same delivery as the <a href="#spamslayer">SpamSlayer</a> rubric:
            a plain .skill file that runs inside a desktop Claude session,
            nothing to host, just a documented procedure the model follows.
            Built for our own queue and in use on it now, not a product.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Claude Skill · triggers on pasted ticket activity · chronological
            notes, findings inline · facts-only escalations · hypothesis kept
            as separate analysis
          </p>
        </section>

        {/* 14. Autotask Ticket Summaries */}
        <section id="ticket-summaries" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">Autotask Ticket Summaries</h2>
          <p className="mt-2 text-sm text-faint">
            Catch up on every open ticket without re-reading a single one.
          </p>
          <p className="mt-4 text-sm">
            A Claude Skill that reads your open Autotask tickets through
            Google Chrome and hands back a brief for each: the issue, what
            has been done so far, and the next steps sitting in the notes.
            Ask naturally (&quot;what&apos;s on my plate in
            Autotask?&quot;, &quot;catch me up on my service desk&quot;) and
            the skill picks it up, no magic word required. Tell it to skip a
            queue and it filters.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Reads With Your Login
              </h3>
              <p className="mt-3 text-sm">
                Claude drives Chrome and reads the live Autotask screen in
                the tech&apos;s own session, in front of the tech: it sees
                exactly what the tech can already see, nothing more. When
                XL needs live Autotask numbers in a client deliverable, that
                goes through XL Lakehouse&apos;s scoped API. A personal
                read-only brief doesn&apos;t: no API keys, no integration
                project, no new credentials to mint and then guard.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Issue, Done, Next
              </h3>
              <p className="mt-3 text-sm">
                Every ticket collapses to the same three answers: what is
                wrong, what has been tried, and what happens next. A fixed
                shape means the whole queue scans like one ticket, and
                nothing hides in the formatting.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Looks, Never Touches
              </h3>
              <p className="mt-3 text-sm">
                The procedure has no write step: no edit, no save, no
                complete. Reading is the entire job. The summary informs the
                tech; every change to a ticket is still made by a human, on
                purpose.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Built for a real Monday problem: our service desk opens each day
            with a 15-minute review of current tickets, and after a weekend
            one of us kept re-reading Friday&apos;s tickets before the call.
            Now Claude does the re-reading. It is the return leg of{" "}
            <a href="#ticketscribe">TicketScribe</a>: that skill drafts the
            clean notes techs put into tickets, this one reads them back
            out, delivered the same way, with nothing to host.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Claude Skill · reads live Autotask in Chrome · issue / done so
            far / next steps per ticket · queue filters · view-only · no
            write step · changes stay human
          </p>
        </section>

        {/* 15. Auto-Draft Follow-Up Emails */}
        <section id="follow-up-emails" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">Auto-Draft Follow-Up Emails</h2>
          <p className="mt-2 text-sm text-faint">
            The post-call email, from copy-paste chore to a one-line request
            and a draft waiting in Gmail.
          </p>
          <p className="mt-4 text-sm">
            A Claude Skill our inside-sales team runs after calls. Even with
            a standard template on file, the follow-up email was a chore:
            open the template, look the contact up, paste in the name and
            the industry, edit in what the template can&apos;t know, on
            every call. Now it is a one-line request. The rep drops the
            contact&apos;s email address or phone number into chat, and a
            filled-in draft appears in their own Gmail, ready to review. Ask
            for a &quot;chill follow-up&quot; and the softer, low-pressure
            variant of the template comes back instead.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                One Line, Tokens Filled
              </h3>
              <p className="mt-3 text-sm">
                One pasted email address or phone number is the whole
                request. The skill finds the contact in PhoneBurner and
                fills the tokens, name, industry, the rest, in the standard
                XL.net follow-up, the one that introduces CEO Adam Radulovic
                and carries his booking link. The template was always the
                easy part; hunting down the details and fitting them in was
                the chore, and that is the part that is gone.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                The Call Gets Logged
              </h3>
              <p className="mt-3 text-sm">
                The same request updates the call disposition in
                PhoneBurner: contact, or no answer. The record of the call
                is up to date with no second trip into the CRM to log it.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                The Send Stays Human
              </h3>
              <p className="mt-3 text-sm">
                What comes back is a draft in the rep&apos;s own Gmail,
                addressed from the rep&apos;s work address. The procedure
                has no send step: the rep reads the email over, edits
                anything worth editing, and sends it themselves. A wrong
                detail is a quick fix in review, not an email already in a
                prospect&apos;s inbox.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The service desk got <a href="#ticketscribe">TicketScribe</a>
            {" "}and the{" "}
            <a href="#ticket-summaries">Autotask summaries</a>; this is the
            same pattern crossing to the sales floor, the email after the
            call instead of the note after the ticket. Where the Autotask
            skill&apos;s procedure has no write step, this one is allowed
            exactly two writes, a Gmail draft and a PhoneBurner disposition,
            and nothing reaches a prospect until the rep sends it. Delivery
            has not changed since <a href="#spamslayer">SpamSlayer</a>:
            write the procedure down, hand it to Claude, run nothing new.
            Live with our inside-sales team now, internal, not a product.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Claude Skill · paste an email address or phone number ·
            PhoneBurner lookup · XL.net template, tokens filled · CEO intro
            and booking link · &quot;chill follow-up&quot; variant · draft
            in the rep&apos;s Gmail · no send step · logs contact / no
            answer
          </p>
        </section>

        {/* 16. Beacon */}
        <section id="beacon" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge">
              <span className="dot" /> Built · final setup
            </span>
            <span className="badge badge--light">Internal Slack assistant</span>
          </div>
          <h2 className="mt-6">Beacon</h2>
          <p className="mt-2 text-sm text-faint">
            The channel assistant that answers &quot;has someone already built
            this?&quot; before anyone builds it twice.
          </p>
          <p className="mt-4 text-sm">
            Our own Slack, one channel: #claude-teamhub, where the team talks
            about what it wants to build next. Beacon sits in that
            conversation, built for a problem that grows with every automation
            a team ships: the same thing getting built twice because there was
            no quick way to ask whether it already exists. It matches new
            ideas against the team&apos;s tool registry, cites the relevant
            company procedure by name when a thread touches process or client
            data, and asks a clarifying question when an idea is genuinely
            new. Where <a href="#leo-netter">Leo Netter</a> is a teammate
            tested one DM at a time, Beacon works in the open channel.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Match Before Build
              </h3>
              <p className="mt-3 text-sm">
                Describe what you want to build and Beacon searches the
                team&apos;s registry of existing tools. A close match comes
                back as the tool&apos;s name and its owner, a person to talk
                to instead of a project to start. And once a week, or on
                demand, the manager gets a plain-language digest: what was
                asked, what matched existing work, and where effort looks
                duplicated.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Claude Talks, Code Decides
              </h3>
              <p className="mt-3 text-sm">
                Claude decides what to say in a reply. Beacon&apos;s own code,
                ordinary software outside the model, decides who receives each
                message, what gets written to storage, and whether restricted
                content moves at all. In the channel a restricted policy
                appears only as a title and its owning team; the full text
                arrives by direct message, after a live team-membership lookup
                confirms the requester belongs to that team. A permission
                decision is a lookup against records, not an inference from
                how convincing the request sounds.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Writes Wait for the Owner
              </h3>
              <p className="mt-3 text-sm">
                When a conversation confirms a tool is finished, Beacon drafts
                a registry entry rather than filing one. The proposal is
                sanitized first: length caps, stripped markup,
                instruction-like phrasing flagged. It commits only after the
                tool&apos;s owner approves it with a reaction in the thread,
                and an unconfirmed proposal expires after 72 hours.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Beacon holds no SweetProcess credential of its own. Every
            governance search and permission check is brokered through{" "}
            <a href="#lakehouse">XL Lakehouse</a>, scoped read-only and
            audited, against a library of roughly 5,755 procedures and 255
            policies refreshed on a 24-hour cycle. Slack connects directly
            because realtime events have no broker equivalent, and Google
            Drive connects directly because the tool registry and interaction
            log live in Google Docs, which Lakehouse&apos;s Google integration
            does not yet cover. The pipeline is built and tested, module by
            module, against real production data; what remains is the Slack
            app itself and a short list of setup steps before the channel gets
            its first reply.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Node.js · Slack Bolt (Socket Mode) · Claude tool-use loop · prompt
            caching · SweetProcess via Lakehouse (read-only) · 5,755
            procedures / 255 policies · 24-hour refresh · owner-reaction
            commit · 72-hour proposal expiry · weekly digest
          </p>
        </section>

        {/* 17. Morning Brief */}
        <section id="morning-brief" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">Morning Brief</h2>
          <p className="mt-2 text-sm text-faint">
            Thirty seconds, one drawing, and you know what kind of day this
            is.
          </p>
          <p className="mt-4 text-sm">
            Say &quot;run my morning brief&quot;, or just type /morning, and
            Claude answers with a page instead of a paragraph. Across the top
            runs a hand-drawn terrain line whose profile is the day&apos;s
            first reading: light, normal, or heavy, taken in before a word of
            text. Below it, two short lists finish the glance: what is
            waiting on you, and what stopped waiting.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                The Day, Drawn First
              </h3>
              <p className="mt-3 text-sm">
                The horizon line answers the morning&apos;s first question,
                how much day is there, before the reading starts; the lists
                underneath say what and who. Every skill before this one
                hands back words: notes, a verdict, a brief, a draft. This
                one hands back a picture of the day with the words
                underneath it.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                The List That Subtracts
              </h3>
              <p className="mt-3 text-sm">
                Status tools are good at adding to your plate. The
                brief&apos;s second list takes things off it: a thread that
                wrapped up on its own, a question that found its answer
                without you, a meeting that dropped off the calendar. Each
                line is something you no longer have to carry into the day,
                and what remains in the first list is the day&apos;s real
                size.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                No New Access
              </h3>
              <p className="mt-3 text-sm">
                The skill brings no connection step and adds no credential
                of its own. It reads the calendar, email, and chat you have
                already linked, for one purpose: drawing this page. A source
                that is not connected simply thins the brief; the page is
                drawn from whatever remains, and the page is the whole
                deliverable.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The other skills in this group face work the team shares: a
            triage rubric, the service queue, the sales call log.{" "}
            <a href="#beacon">Beacon</a>, just above, answers for a whole
            channel. Morning Brief is the first whose sources are yours
            alone: your calendar, your inbox, your morning. It is also the
            first that can keep its own appointment: ask once for a
            recurring run, weekday mornings if you like, and the page is
            waiting before you sit down. The rest of the group answers when
            asked. This one, once asked, is simply there when the day
            starts.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            one drawn page · light / normal / heavy · reads only what you
            already linked · /morning, on demand or on a schedule · a .skill
            file like the rest
          </p>
        </section>

        {/* 18. SP Writer */}
        <section id="sp-writer" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">SP Writer</h2>
          <p className="mt-2 text-sm text-faint">
            The fix is still warm when the draft comes back, already in
            house format.
          </p>
          <p className="mt-4 text-sm">
            The hard part of a procedure is rarely the knowledge; it is the
            formatting. SP Writer takes whatever an engineer has at hand,
            rough troubleshooting notes, a pasted ticket, an old Word
            document, or a walkthrough typed straight into chat, and
            returns a SweetProcess draft already in XL.net&apos;s house
            shape: a title prefixed the house way, client name for client
            work, software name for the generic, search tags an engineer
            would actually type, a purpose statement, and short numbered
            steps, one action or one decision apiece. The draft arrives
            twice, as markdown and as a matching Word file, because
            SweetProcess&apos;s editor keeps bold and drops code spans, and
            the Word copy is what lets the formatting survive the paste.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Every Path Reaches End
              </h3>
              <p className="mt-3 text-sm">
                A procedure that branches gets a real decision step: the
                step title is the question, and an answers block routes
                each reply to a numbered destination. Before the draft goes
                out, the skill walks every path from step one, through
                every branch and every jump, and confirms each one lands on
                the End step. No dead ends, no orphaned steps, no route
                that points at a step nobody wrote. If drafting adds or
                removes a step, the whole thing renumbers so the routing
                stays true.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Flagged, Never Filled In
              </h3>
              <p className="mt-3 text-sm">
                The skill&apos;s own file puts it plainly: a wrong SP is
                worse than no SP. An obvious hole in the notes becomes a
                question before drafting starts. A server name or URL the
                engineer did not mention comes back as a bracketed marker
                to confirm, not a plausible guess. A screenshot the
                procedure needs becomes a placeholder, not a description
                written from imagination, and credentials appear only as
                the name of the BitWarden entry that holds them. Nothing
                technical is invented to make a step read complete.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Two Files, Then a Tech
              </h3>
              <p className="mt-3 text-sm">
                The draft is where it stops. Creating the SP inside
                SweetProcess is not one of its steps, and nothing is
                connected that could: no SweetProcess login, no client
                system, only a conversation with an engineer. What leaves
                the chat is a pair of files, and both wait for the same
                thing every draft waits for: a tech reads it, corrects
                what needs correcting, and publishes it.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            <a href="#ticketscribe">TicketScribe</a>, earlier in this
            group, turns a single ticket&apos;s history into notes a tech
            pastes back in; SP Writer is for the part worth keeping once
            the ticket closes. It also has a neighbor:{" "}
            <a href="#beacon">Beacon</a>, still in its final setup, will
            answer questions out of the team&apos;s procedure library, and
            every draft that survives review will be one more procedure it
            can find. The trade is the one the skill was built for: an SP
            that used to cost an hour of formatting now costs a paste and
            a review, written while the fix is still fresh instead of
            waiting behind everything else.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            scratch notes in, house format out · every path traced to End ·
            gaps flagged to confirm, never guessed · the vault entry name,
            not the password · markdown and Word, bold intact · review and
            publish stay with a tech
          </p>
        </section>

        {/* 19. Kaseya AP Builder */}
        <section id="kaseya-ap-builder" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">Kaseya AP Builder</h2>
          <p className="mt-2 text-sm text-faint">
            The request is a sentence in plain English; the deliverable is
            a finished agent procedure, XML and all.
          </p>
          <p className="mt-4 text-sm">
            For Central Services, a plain-language request, install this
            agent, audit what&apos;s installed, uninstall the old copy,
            report a result into a custom column, comes back as a complete
            Kaseya VSA 9 agent procedure in the format Kaseya itself uses
            when a procedure is exported from the editor, fit for the
            editor&apos;s import. Installers come straight from the
            vendor&apos;s evergreen link when latest is the goal, or from a
            pinned copy on our S3 bucket when the version matters. Each run
            hands back two things: the .xml itself, and a short numbered
            account of what the procedure does, written for the description
            field and the client runbook. Every procedure lands in the same
            house shape, so the structure holds from one AP to the next and
            none of the XML is typed by hand.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                The Log Does the Talking
              </h3>
              <p className="mt-3 text-sm">
                On the endpoint, a generated procedure shows nothing:
                silent switches, SYSTEM context, no window for whoever is
                signed in at the keyboard. In the Kaseya agent log it hides
                nothing. Every meaningful step announces itself before it
                acts and confirms after, failures carry an ERROR: prefix,
                and when a check finds the work already done, the skip
                itself is written down, so a machine that needed nothing
                says so. Those checks lead: a registered service, a
                registry footprint, or an install path in either Program
                Files folder means the procedure logs a skip instead of an
                install. At the end, downloaded installers and scratch
                files are removed, and OS-specific steps carry an OS tag so
                a mixed Windows and macOS policy never sends one
                platform&apos;s commands to the other.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Built to Survive the Import
              </h3>
              <p className="mt-3 text-sm">
                One oversized field is enough to sink an entire import;
                Kaseya rejects the whole file with a database truncation
                error rather than trimming it. The skill treats that as a
                format rule, not a surprise. Ampersands, quotes, and angle
                brackets inside attribute values are escaped, newlines are
                encoded, and the bracketed managed-variable tokens are
                escaped along with them. Descriptions and inline commands
                stay under Kaseya&apos;s column limits, a script too long
                to inline is hosted and downloaded at runtime instead, and
                the finished file is parse-checked before it is handed
                over.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                No Connection, No Keys
              </h3>
              <p className="mt-3 text-sm">
                The skill has no session with Kaseya and no way to open
                one; it reads a request and writes a file, and its
                documentation is blunt on the point: it never connects,
                never runs anything, and holds no secrets. License keys and
                site tokens exist only in Kaseya&apos;s AP Variable
                Manager; Kaseya drops them in when the procedure runs. The
                skill knows variable names, wraps each in an exists-check,
                and a missing one surfaces as a plain log line naming the
                variable the client org still needs. The published copy is
                sanitized by design, placeholders where an installer host
                would go, no client names anywhere in it. Between the file
                and production stand two deliberate steps: a tech reviews
                and imports the XML, and the first run happens on a single
                lab machine, because a procedure that runs as SYSTEM across
                a fleet earns its trust on one box first.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            One card up, <a href="#sp-writer">SP Writer</a> drafts
            procedures for people to follow, step by step in SweetProcess.
            This skill drafts the other kind: procedures a Kaseya agent
            carries out on an endpoint with no one watching. Both end at a
            document, and both keep a tech between that document and the
            world: publish over there; review, import, and a lab run over
            here. The difference is the reader. A SweetProcess draft is
            judged by the engineer who follows it; an agent procedure is
            judged by its log, which is why every one of these is built to
            narrate itself.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            a sentence becomes a procedure · checks before installs ·
            every step in the agent log · names in the file, values at
            runtime · escaped, sized, parse-checked · a lab machine before
            any fleet
          </p>
        </section>

        {/* 20. TPS Client Count */}
        <section id="tps-client-count" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">TPS Client Count</h2>
          <p className="mt-2 text-sm text-faint">
            One scorecard number, backed by a sheet that keeps doing the
            math.
          </p>
          <p className="mt-4 text-sm">
            The department scorecard has a new line: how many clients sit
            at or below a target TPS of 0.45, where TPS is a client&apos;s
            tickets divided by its seats over a rolling window, four
            Thursdays back through yesterday. Producing that count by hand
            was an Excel job, several spreadsheets combined with vlookups
            and pivot tables, then a separate filter over the result, and
            the scorecard wants the number every week. This skill runs the
            chain on request: it opens Autotask in Chrome under your own
            sign-in, runs the two LiveReports, filling the date window
            into the one that takes it, and exports both to Excel. Then it
            folds the seats report into the ticket report, client by
            client, and writes the answer in: a TPS column, a headline
            count, and the exact dates used.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Arithmetic Left in the Cells
              </h3>
              <p className="mt-3 text-sm">
                Python does the merge, but no answer is pasted in as a
                plain number. Every TPS cell carries a live formula,
                tickets over seats at two decimals, and the headline count
                is a live COUNTIF at the 0.45 line, so a value edited by
                hand later moves the count with it; the arithmetic never
                leaves the sheet. A client with no row in the seats report
                stays blank, a blank stays out of the count, and the merge
                lists every client it skipped. Then the skill reopens the
                finished file and checks its own work: TPS against the
                ticket and seat columns, the count against the rows, the
                recorded dates against what went into the report filter.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Burned Twice, Written Down
              </h3>
              <p className="mt-3 text-sm">
                Two failures shaped this skill, and both are written into
                it. Autotask once slid an extra column into the ticket
                report, moving everything after it, and a script that
                trusted fixed column letters kept writing seats and TPS
                where those columns used to be; a person checking the
                numbers by hand caught it. The merge now locates tickets,
                seats, TPS, and account name by their headers, and if a
                header vanishes or gets renamed, the run stops and the
                error says which one. The date math had its turn too:
                written on a Tuesday, it ran a week short the first time
                it executed on a Thursday, when the most recent Thursday
                was that very day, and again a person caught the bad start
                date. The correction sits in the skill file beside a
                warning that the off-by-one is easy to bring back, so the
                mistake is part of what the model reads before it computes
                a single date.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Only the Downloads Folder
              </h3>
              <p className="mt-3 text-sm">
                Autotask is read through Chrome in your own signed-in
                session, the same two reports you could open yourself, and
                nothing travels the other way: no write into Autotask, no
                API key, no credential minted for the job. The only place
                the skill writes is your Downloads folder, two Excel
                files, and it looks before it lands there: a report you
                still have open in Excel stops the copy, and the skill
                tells you which file to close instead of retrying into a
                locked file. Scope is fenced on purpose, these two
                reports, this pod, this threshold; a different report is a
                new skill, not a setting on this one. The deliverable
                never grows extras either, no added sheets, no pivot
                tables, just the ticket report with seats, TPS, the
                count, and the dates filled in.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Autotask has come up twice before in this group:{" "}
            <a href="#ticketscribe">TicketScribe</a> drafts the clean
            notes a tech pastes into a ticket, and{" "}
            <a href="#ticket-summaries">Autotask Ticket Summaries</a>{" "}
            reads the open queue back as briefs, through Chrome, in a
            session the tech already owns. This skill uses that same
            Chrome door and comes back with something neither of them
            makes: not text for a person to read, but a number for the
            department scorecard to hold. The number does not arrive
            alone. The formulas under it stay live, the skipped clients
            are listed, and the window is printed on the sheet, so anyone
            who doubts the count can follow the cells and land on it
            themselves.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            two autotask livereports · your own chrome session · four
            thursdays back, through yesterday · merged on client name ·
            live formulas, two decimals · count at or below 0.45 ·
            columns found by header, not letter · finished file re-read
            and checked · writes only to downloads · nothing back to
            autotask
          </p>
        </section>
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
            workflows and automations, the smart and safe way.
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
