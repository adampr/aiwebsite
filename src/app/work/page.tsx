import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Our Work",
  description:
    "Twelve real, running AI systems built in the open by XL.net: engine, middleware, live sites, client platforms, access layers, and a public AI governance writer.",
  alternates: { canonical: "/work" },
  openGraph: {
    title: "Our Work | XL.net AI",
    description:
      "Twelve real, running AI systems built in the open by XL.net: engine, middleware, live sites, client platforms, access layers, and a public AI governance writer.",
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
