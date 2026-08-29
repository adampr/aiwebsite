import type { Metadata } from "next";
import Link from "next/link";
import { CommunitySection } from "./community";
import { StaffSubmitLink } from "./staff-submit-link";
import { WorkRegistry } from "./registry";
import { WorkPager } from "./pager";
import { publishedCards, type PublishedCard } from "@/lib/work/db";
import { INTERNAL_SCOPE } from "@/lib/work/scope";
import staticTitles from "@/lib/work/static-titles.json";

// Team-submitted cards (§5.16) publish to this page without a deploy, so a
// hard-coded count in the metadata would go false on the first publish;
// the description is count-free by rule. ISR keeps the page static-fast
// while letting publishes appear within minutes (the blog precedent);
// publish/delete also call revalidatePath as the fast path.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Our Work: Real AI Systems Running in the Open",
  description:
    "Real AI systems running in the open at XL.net: engine, middleware, live sites, client platforms, a public AI governance writer, and tools built by the team.",
  alternates: { canonical: "/work" },
  openGraph: {
    title: "Our Work: Real AI Systems Running in the Open | XL.net AI",
    description:
      "Real AI systems running in the open at XL.net: engine, middleware, live sites, client platforms, a public AI governance writer, and tools built by the team.",
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

export default async function WorkPage() {
  // ONE guarded fetch feeds the registry, the pager counts, and the team
  // section, so the index can never list a card the body failed to render.
  // DB down or empty -> team=[] -> statics-only page, exactly today's
  // degradation (§5.16: the hand-authored exhibits never depend on the DB).
  let team: PublishedCard[] = [];
  try {
    // INTERNAL_SCOPE (§5.18): the public page renders ONLY the staff lane;
    // company cards are company_id-scoped and never appear here.
    team = await publishedCards(INTERNAL_SCOPE);
  } catch {
    // the static exhibits are the page
  }
  return (
    <div className="work-page mx-auto max-w-5xl space-y-16">
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
        {/* Staff-only submit entry (§5.16): client island, renders only for
            signed-in @xl.net accounts; opens the submission dialog. */}
        <StaffSubmitLink variant="top" />
      </section>

      <hr className="horizon" />

      {/* Works registry + console pager (2026-08-04): the registry is the
          always-complete anchor index of every exhibit; the pager island
          windows the card sequence below it (Show 5/10/25/All, default 10).
          Both are additive chrome - the static card sections stay
          byte-identical, and with JS off the pager strip never appears and
          every card renders visible. */}
      <WorkRegistry team={team} />
      <WorkPager
        staticCount={staticTitles.exhibits.length}
        teamCount={team.length}
      />

      {/* Group: the engine */}
      <section
        aria-label="The Engine"
        className="space-y-16"
        id="works-start"
      >
        <div className="text-center" data-bay-head>
          <span className="sys-label sys-label--center">01 · The Engine</span>
        </div>

        {/* 1. Software Brain */}
        <section id="brain" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> In production
            </span>
            <span className="badge badge--light">Core engine</span>
          </div>
          <h2 className="mt-6">Software Brain</h2>
          <p className="mt-2 text-sm text-faint">
            The engine behind everything on this page.
          </p>
          <p className="mt-4 text-sm">
            A conversation-first, memory-bearing, tool-using AI architecture
            modeled on neurological principles, built as a TypeScript monorepo
            and reachable at brain.xl.net. A handful of services sit over a
            shared core of orchestrator, memory, providers and auth, with SDKs
            for callers in other repositories. Every other exhibit below either
            runs on it or was built with it, and on the days it has taken one
            of them down, the incident is written into the same documents as
            the design.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Remembers Whose Memory It Is
              </h3>
              <p className="mt-3 text-sm">
                Every stored fact is scoped as it is written: private to the
                person who said it by default, private to a group, or public.
                Facts carry validity dates instead of being overwritten, so a
                superseded answer is retired rather than erased, and recall
                combines keyword search, embedding similarity and a reranking
                pass. The rule the documents will not bend is that memory
                survives a restart, a new session and any version upgrade:
                wipe and recreate is not an upgrade path.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Speech In, Speech Back
              </h3>
              <p className="mt-3 text-sm">
                Transcription runs on Deepgram and spoken replies default to
                OpenAI text-to-speech, streamed in pieces so the first audio
                arrives in a fraction of the wait a rendered answer would cost.
                A second mode hands the conversation to a realtime voice model,
                with the key for it never leaving the server, and a telephony
                path lets the same engine pick up a phone call. This is the
                stack behind the phone number on this page.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Rebuilt From the Document Alone
              </h3>
              <p className="mt-3 text-sm">
                One master architecture document is the source of truth,
                required to carry enough implementation detail to rebuild the
                entire codebase to functional equivalence. It is updated first
                or alongside the code, never after, and that is enforced rather
                than encouraged: a commit touching the packages, the apps or the
                scripts is refused unless the documentation is staged with it.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            A release is not done when the code works. A layered QA harness runs
            from unit checks up through browser and restart runs,
            the security scan has to come back with zero findings straight
            after it, and the written definition of done carries a clause most
            specifications do not: the document must not overstate guarantees
            relative to the code. Nothing a visitor reads is assembled, either:
            no canned replies, no pattern-matched answers, no template
            acknowledgements anywhere in the response path. It also strips em
            dashes from its own writing, twice over, because someone here
            objects to them.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            TypeScript monorepo · scoped memory with validity dates · Deepgram
            in, spoken reply out · one rebuild-ready master document ·
            doc-before-code enforced at commit · layered QA, then a clean
            security scan · brain.xl.net
          </p>
        </section>
      </section>

      {/* Group: what it runs */}
      <section aria-label="What It Runs" className="space-y-16">
        <div className="text-center" data-bay-head>
          <span className="sys-label sys-label--center">02 · What It Runs</span>
        </div>

        {/* 2. @aicompany/core */}
        <section id="aicompany" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> In production
            </span>
            <span className="badge badge--light">Shared module</span>
          </div>
          <h2 className="mt-6">@aicompany/core</h2>
          <p className="mt-2 text-sm text-faint">
            Everything an AI company needs around its website, driven by one
            config object.
          </p>
          <p className="mt-4 text-sm">
            The generic extraction of what our sites have in common: a persona
            reachable over chat, text, email and the phone, sign-in and
            sessions, an admin console, first-party analytics, a knowledge
            crawler, and a deploy and operations stack for a single server.
            The host site keeps its pages, its brand and its own features and
            mounts the rest in wrapper files a few lines long. It runs{" "}
            <a href="#aiwebsite">this site</a>,{" "}
            <a href="#itsupportchicago">IT Support Chicago</a> and{" "}
            <a href="#roleplay">Roleplay</a> and the metro ranking site Top MSP
            Near Me, and its own release notes treat those hosts as one fleet.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Configure It, Never Fork It
              </h3>
              <p className="mt-3 text-sm">
                A new site is a new repository, a config object, brand assets,
                content pages and vendor accounts. If a host has to fork a
                shared component, the module treats that as its own design bug.
                The panel that signs off on its design carries a standing
                question pointed the other way: does sharing make the third site
                faster to launch without making it read as a clone of the
                first?
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                The Same Promises on Every Site
              </h3>
              <p className="mt-3 text-sm">
                A few behaviors are invariants rather than options, so they
                cannot be quietly switched off on one property:
                outbound email is copied to a human, the persona says it is an
                AI in its signature and in its first reply to a new texter,
                inbound webhooks are signature-checked with no flag to skip it,
                and visitor tracking refuses to run at all on a site that has
                not published a privacy policy.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Each Release States Its Blast Radius
              </h3>
              <p className="mt-3 text-sm">
                Every release entry is titled with what it will cost a host:
                nothing, a re-render of the deploy scripts, or a database
                migration that has to run first. One host takes each release
                first and sits on it before the others follow. Deploy scripts
                are rendered from templates and stamped, and the deploy
                refuses both a stamp mismatch and a dirty working tree.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The boundary is drawn as carefully as the features. Page metadata
            stays with the host on purpose, because that is where sites stop
            looking alike. Voice is a documented contract rather than module
            code: the call goes to the engine directly and the module
            contributes the routing around it. Every subsystem is expected to
            fail on its own and say so, a disabled feature rendering a designed
            explanation rather than a blank page that reads as an outage.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            one config object · chat / text / email / phone · admin console ·
            first-party analytics · nightly crawler · signature-checked
            webhooks with no off switch · no privacy policy, no tracking ·
            stamped deploy templates
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
            This page, the chat widget in the corner, and the number and mailbox
            Tron Netter answers on are one application on one VM behind a
            Cloudflare tunnel. No load balancer, no container runtime, no
            managed cloud database: a web server, a process manager, Postgres
            and the tunnel. What is worth showing is not the stack but the
            constraints, which are written down as invariants a rebuild may
            not drop, beside the note of the day one of them turned out to be
            only half true.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Every Send Copies a Person
              </h3>
              <p className="mt-3 text-sm">
                Every email this site sends is copied to a human overseer, by
                two mechanisms rather than one, because for a while the second
                did not exist and the senders that skip the shared mail seam
                copied nobody. Both paths normalize addresses before comparing,
                so an overseer who is also the recipient gets one copy rather
                than two. Exactly one send is carved out on purpose, with the
                reason written at the call site.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Nothing to Reach For
              </h3>
              <p className="mt-3 text-sm">
                The public persona has no tools and no internet. Chat, text and
                email each declare a tool policy of none, and every call
                passes the engine&apos;s entire tool list back as the list to
                disable. That list is assembled fail-closed: if the
                inventory cannot be read, a pinned set of names is disabled
                instead, because an empty disable list would quietly mean
                everything is allowed.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Only What We Published
              </h3>
              <p className="mt-3 text-sm">
                What it knows is a nightly crawl of ai.xl.net and xl.net,
                written by replacing what was there rather than adding to it,
                so a page we take down stops being something it knows. A crawl
                that comes back empty, or nearly empty, aborts and keeps
                yesterday&apos;s knowledge rather than publishing a blank one,
                and either outcome is mailed as a report.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Memory follows the same posture. An anonymous conversation is not
            stored at all, what a signed-in or phone-verified person tells it
            stays private to them, and a sweep runs before and after every
            remembering turn to invalidate any fact that tried to write itself
            public, because a stranger planting a memory every visitor could
            read is the interesting failure here. Texting the word FORGET
            erases that number&apos;s memories outright. The exhibits on this
            page are written into the application itself, so an unreachable
            database costs the cards submitted by the team and nothing else.
            Try it: chat, text, email, or call Tron Netter on this page.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            human copy on every outbound email · tools disabled fail-closed ·
            nightly crawl, replaced not appended · anonymous turns unstored ·
            FORGET erases a number · one VM behind a Cloudflare tunnel
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
            <span className="badge badge--ok">
              <span className="dot" /> Live · public
            </span>
            <span className="badge badge--light">Almost entirely AI-run</span>
          </div>
          <h2 className="mt-6">IT Support Chicago</h2>
          <p className="mt-2 text-sm text-faint">
            A ranking site that runs itself, published by a firm that appears
            on its own list.
          </p>
          <p className="mt-4 text-sm">
            itsupportchicago.net ranks Chicago managed IT providers against a
            scoring formula it publishes in full, built from third-party data,
            with the worked arithmetic and the evidence shown on every vendor
            page. It is free, nothing on it can be bought, and it is almost
            entirely operated by AI agents: collection, scoring, drafting and
            review run without a person in the chair. Maximum oversight on{" "}
            <a href="#aiwebsite">this site</a>, near-total delegation on that
            one. We run both on purpose, because the question worth answering
            is where the line falls.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Nobody Can Buy a Place
              </h3>
              <p className="mt-3 text-sm">
                The formula is published, each score shows the calculation and
                the evidence under it, and every page carries the date the data
                behind it was last checked. The methodology page declines to
                call any of it objectively verified, because the wording would
                claim more than the process delivers. A vendor&apos;s operating
                status is the one field no agent flips on a single signal; it
                waits for an evidence gate.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                The Publisher Is on the List
              </h3>
              <p className="mt-3 text-sm">
                XL.net owns and operates the site and is itself one of the
                firms it ranks, which the site says on its own about page
                rather than in a footnote. That paragraph is the one piece of
                copy no automated agent may write, alter or remove: changing it
                is a human decision, and the rule is written into the component
                that renders it.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Where the Agents Stop
              </h3>
              <p className="mt-3 text-sm">
                Delegation is not the same as absence. Outreach is drafted and
                queued, and a person approves before anything sends. An article
                whose adversarial review panel did not convene publishes
                unindexed and out of the sitemap rather than quietly going
                out. Deploys still begin at somebody&apos;s keyboard, and the
                legally load-bearing copy is frozen against the agents that
                write everything else.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The sandbox is built to let all of that fail safely. Its own cloud
            project, a confidential virtual machine with encrypted memory and
            verified boot, no external address, and a firewall that denies
            inbound traffic outright: visitors arrive through a tunnel the box
            opens from the inside. A watchdog checks the services every minute
            and restarts what died, security patches land unattended overnight,
            and the backups are not taken on faith. They are restored into a
            scratch database on a schedule and counted, on the principle its
            documentation states plainly: a backup that cannot be restored is
            not a backup.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            published formula, shown arithmetic · common ownership disclosed
            on the site · frozen copy no agent may touch · outreach drafted,
            a person sends · confidential VM, deny-all inbound · restore-tested
            backups
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

        {/* 6. Roleplay */}
        <section id="roleplay" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · public
            </span>
            <span className="badge badge--light">Approval to enter</span>
          </div>
          <h2 className="mt-6">Roleplay</h2>
          <p className="mt-2 text-sm text-faint">
            Live practice against an AI buyer, then a debrief that scores you
            off the transcript.
          </p>
          <p className="mt-4 text-sm">
            roleplay.xl.net is the answer to what the{" "}
            <a href="#brain">Software Brain</a> does when it powers a product
            that is not about XL.net at all. Salespeople and service reps run a
            live audio or video session against an AI buyer with a hidden
            agenda, hang up, and get coaching graded against what was actually
            said. Its users are people who do not work for XL.net: it is the
            external tenant, on its own machine with its own database, running
            the engine and <a href="#aicompany">the shared module</a> together.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                The Buyer Does Not Repeat Itself
              </h3>
              <p className="mt-3 text-sm">
                Scenarios are archetypes with difficulty ratings, and the
                learner gets a pre-call brief and nothing else: the buyer&apos;s
                agenda stays hidden, the way it would be. Every run samples a
                different objection and different stalling tactics and is told
                to open differently, so the second attempt cannot be beaten
                from memory.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Scored Off the Stored Copy
              </h3>
              <p className="mt-3 text-sm">
                The debrief scores each dimension, names one thing to change,
                and caps the misses, every one of them citing the turn it came
                from with the line to say instead. Grading reads the
                transcript the server stored rather than the browser&apos;s
                copy, which becomes worth editing the moment a score exists,
                and a degraded model response is never written down as a scored
                session at all.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Compiled In, Not Called Over
              </h3>
              <p className="mt-3 text-sm">
                The engine&apos;s orchestrator, memory, voice and storage
                packages are imported straight into the practice service rather
                than reached over HTTP, so a live turn crosses no network hop
                of ours. The audio itself goes from the browser to the voice
                model directly and never transits the server, while the
                ordinary chat persona on the same site talks to the shared
                engine like every other property here.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Anyone can sign in, with Google, with Microsoft, or with a link
            mailed to them, and nobody reaches the practice stage until an
            admin approves them, an invitation from their own company is
            accepted, or a plan is paid for. Both of its services check that
            independently rather than trusting the browser&apos;s claim.
            Recordings and transcripts belong to the learner, every read is
            ownership-checked, and a manager&apos;s reach stops at the edge of
            their own email domain. If the camera is on but too few frames
            were usable, the coach is told to skip body language rather than
            guess.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            practice against an AI buyer · hidden agenda, varied every run ·
            graded off the stored transcript, with turn citations · sign in
            freely, enter on approval · engine compiled in, audio direct from
            the browser
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

        {/* 7. Leo Netter */}
        <section id="leo-netter" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> In production
            </span>
            <span className="badge badge--light">Internal-facing</span>
          </div>
          <h2 className="mt-6">Leo Netter</h2>
          <p className="mt-2 text-sm text-faint">
            A teammate in Slack, with most of what it could reach deliberately
            switched off.
          </p>
          <p className="mt-4 text-sm">
            Leo Netter is a conversation-first, memory-bearing assistant for
            the XL.net team, built on the{" "}
            <a href="#brain">Software Brain</a> and described by its own
            documents as the slow and deliberate successor to the sales
            assistant it replaced. That handover is finished and it answers in
            Slack every working day. The part worth exhibiting is the
            restraint around it: nearly every lane this thing could speak on is
            built, tested, and dark until a person names what it may touch.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Built, Then Left Switched Off
              </h3>
              <p className="mt-3 text-sm">
                It works in direct messages and in a named list of channels,
                and nowhere else yet. In a channel it runs with its writing and
                identity tools stripped out and remembers nothing past the
                conversation. The lanes for email, text, the phone and meeting
                audio are built and shipped behind switches that default to
                off, and its document search stays invisible to the model until
                somebody names the folders it may read.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                It Has to Admit It Cannot
              </h3>
              <p className="mt-3 text-sm">
                A standing rule forbids the offer it cannot keep: before
                promising an action it has to establish that the action maps to
                a call it could make right now, and otherwise say so and stop.
                The tools that read business systems refuse anything that
                would write. Sending an email takes two steps with a person&apos;s
                click between them, a second click sends nothing twice, and an
                approval left too long is refused rather than sent late.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Architecture Is Canonical
              </h3>
              <p className="mt-3 text-sm">
                Every tool, behavior, memory scope, environment switch and test
                is written into the architecture document before the code for
                it exists. The document commit comes first and the code commit
                second, which is enforced rather than trusted: a commit that
                touches the application without staging that document is
                refused outright.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Memory is classified one turn at a time into private to the person,
            shared with the team, or public, and anything short of a confident
            call files the fact as private, because over-scoping is the mistake
            you can recover from. Two people&apos;s private memories cannot
            surface in each other&apos;s conversations, and a channel writes
            nothing durable at all. The test list works like the architecture:
            a defect becomes a numbered entry before anyone writes the fix, and
            a closed one is marked resolved rather than deleted, so what went
            wrong stays in the document that specifies what replaced it.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Slack first, every other lane dark by default · read-only business
            tools · two steps and a human click to send mail · over-scope to
            private when unsure · doc before code, enforced at commit ·
            append-only test list
          </p>
        </section>

        {/* 8. RFP Response */}
        <section id="rfp-response" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Proposal workspace</span>
          </div>
          <h2 className="mt-6">RFP Response</h2>
          <p className="mt-2 text-sm text-faint">
            From an uploaded or pasted RFP to a priced, checked proposal, one
            section at a time.
          </p>
          <p className="mt-4 text-sm">
            RFP Response is the section of this site where an XL.net proposal
            gets written, visible to signed-in XL.net staff. It reads the
            client&apos;s document, then drafts each section through the{" "}
            <a href="#brain">Software Brain</a> against a knowledge base of
            facts the firm keeps about itself. Reading one real client RFP
            measured at 94 seconds, and drafting runs one section per call, so
            a deploy landing mid-run costs a section rather than the document.
            A wrong fact in that knowledge base is retired and superseded
            rather than edited in place, so a proposal written earlier still
            resolves against what it actually cited.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Neither Prompt Sees Both
              </h3>
              <p className="mt-3 text-sm">
                Drafting is two separate calls, and the split is the control.
                The one that reads the client&apos;s document sees that
                document and nothing else, so an instruction smuggled into an
                RFP has nothing behind it to give away. The one that writes
                sees the firm&apos;s own facts and never a rate-card unit
                price.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                No Figure Without the Engine
              </h3>
              <p className="mt-3 text-sm">
                Pricing takes counts and choices, and a deterministic engine
                computes the quote from the rate card in force. The model is
                never asked for a number, and a currency figure in the prose
                that the engine did not produce is a blocking failure.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Checked Against What Ships
              </h3>
              <p className="mt-3 text-sm">
                Compliance rules live as code in this repository, and an
                export runs them against the exact content being emitted, Word
                and PDF alike. Editing a section or a price clears the stored
                result, so a passing verdict can never describe a draft that
                has since changed. An unresolved proposal still downloads,
                and the file itself stays clean; what is still outstanding
                is reported in the workspace beside the download, never
                stamped into a document a prospect might one day hold.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The cover letter drafts last, once there are sections for it to
            summarize, and signs with the standard XL.net block, varying only
            the personal lines above it. A letter someone has edited by hand
            is replaced only by the button that says it will. The section
            itself stays where proposals belong: signed-in XL.net staff only,
            rendered per request, marked not to be indexed, and absent from
            the sitemap.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            94-second read, then one section per call · gap questions capped
            at two per section · counts in, figures computed · every export
            re-runs the checks · open items reported beside the download ·
            cover letter written last
          </p>
        </section>

        {/* 9. Your AI Roadmap */}
        <section id="your-ai-roadmap" className="panel panel--lightline rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · client companies
            </span>
            <span className="badge badge--light">Client portal</span>
          </div>
          <h2 className="mt-6">Your AI Roadmap</h2>
          <p className="mt-2 text-sm text-faint">
            A company&apos;s own roadmap, from a governance document on
            file to a scorecard of its builders.
          </p>
          <p className="mt-4 text-sm">
            A client company gets its own private corner of{" "}
            <a href="#aiwebsite">ai.xl.net</a>, free, keyed to the domain of
            its work email. The steps sit on one line, from an AI governance
            document on file through the work its own people build to the
            platform, data and tools it gives them. No step is locked behind
            another, and one company sees nothing of any other.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                Keyed by a Proven Domain
              </h3>
              <p className="mt-3 text-sm">
                There is no invite list. Who belongs to a workspace is worked
                out on every lookup from the domain of an address proven at
                sign-in, and the one authorization fact stored is who the
                company admins are. A session without that proof gets no
                company data, not even the name. Shared mailbox domains are
                refused, since they would make strangers colleagues.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Same Panel, Private Page
              </h3>
              <p className="mt-3 text-sm">
                The submission step is the pipeline behind the team cards
                further down this page, scoped to the company: the same
                editorial panel reviews the build and what passes publishes to
                the company&apos;s own work page. Its email lane opens only
                once mail from that domain proves where it came from.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                What the Import Keeps
              </h3>
              <p className="mt-3 text-sm">
                Fill the directory from an Apollo import or by hand. What
                persists is a name, an email address, a phone number, and the
                import id; the raw response is never stored, and a row someone
                edited by hand is not overwritten by a later import. Removing
                an imported person can also record a fingerprint of the
                address rather than the address, so the next import skips
                them.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            The governance step takes a governance document a company already has, or one
            written in the <a href="#governance">AI Governance Writer</a> and
            attached as a snapshot of the moment it was attached, which stands
            on its own once the source project reaches the end of its own
            30-day life. The scorecard counts published cards only, never
            drafts or attempts, per person in the directory, under a
            disclosure that stays on screen; a person with none stays on the
            board rather than disappearing from it.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            no step locked · one workspace per work-email domain ·
            proof at sign-in or no company data · company cards never appear
            on this page · published work only on the scorecard · free
          </p>
          <Link href="/roadmap" className="btn mt-6 no-underline">
            See your AI Roadmap
          </Link>
        </section>
      </section>

      {/* Group: client delivery */}
      <section aria-label="Client Delivery" className="space-y-16">
        <div className="text-center" data-bay-head>
          <span className="sys-label sys-label--center">
            03 · Client Delivery
          </span>
        </div>

        {/* 10. QBR Machine */}
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

        {/* 11. Onboarding Toolkit */}
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
        <div className="text-center" data-bay-head>
          <span className="sys-label sys-label--center">
            04 · The Access Layer
          </span>
        </div>

        {/* 12. XL Lakehouse */}
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

        {/* 13. XL API Gateway */}
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
      <section aria-label="What We Have Built" className="space-y-16">
        <div className="text-center" data-bay-head>
          <span className="sys-label sys-label--center">
            05 · What We Have Built
          </span>
        </div>

        {/* 14. SpamSlayer */}
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
            A Claude Skill our inside-sales team runs after calls. The rep
            drops the contact&apos;s email address or phone number into chat,
            and a filled-in draft appears in their own Gmail, ready to
            review. Ask for a &quot;chill follow-up&quot; and the softer,
            low-pressure variant of the template comes back instead.
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
                the chore.
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
            The service desk got this idea first, as ticket-note and
            ticket-summary skills; this is the same pattern crossing to the
            sales floor, the email after the call instead of the note after
            the ticket. Where those skills have no write step at all, this
            one is allowed exactly two writes, a Gmail draft and a
            PhoneBurner disposition, and nothing reaches a prospect until the
            rep sends it.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            Claude Skill · PhoneBurner lookup · XL.net template, tokens
            filled · &quot;chill follow-up&quot; variant · draft in the
            rep&apos;s Gmail, no send step · logs contact / no answer
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
            no quick way to ask whether it already exists.
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
                to instead of a project to start.
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
          <details className="card-more mt-8">
            <summary aria-label="Full detail: Beacon">Full detail</summary>
            <p className="mt-4 text-sm">
              Beacon also cites the relevant company procedure by name when a
              thread touches process or client data, and asks a clarifying
              question when an idea is genuinely new. Once a week, or on
              demand, the manager gets a plain-language digest: what was
              asked, what matched existing work, and where effort looks
              duplicated. Where <a href="#leo-netter">Leo Netter</a> is a
              teammate tested one DM at a time, Beacon works in the open
              channel.
            </p>
          </details>
          <p className="mono mt-6 text-xs text-faint">
            Node.js · Slack Bolt (Socket Mode) · Claude tool-use loop ·
            SweetProcess via Lakehouse (read-only) · 5,755 procedures / 255
            policies, 24-hour refresh · owner-reaction commit, 72-hour expiry
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
                underneath say what and who. It hands back a picture of the
                day with the words underneath it.
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
                without you, a meeting that dropped off the calendar. What
                remains in the first list is the day&apos;s real size.
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
                drawn from whatever remains.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            Morning Brief is the first in this group whose sources are yours
            alone: your calendar, your inbox, your morning. It is also the
            first that can keep its own appointment: ask once for a
            recurring run, weekday mornings if you like, and the page is
            waiting before you sit down.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            one drawn page · light / normal / heavy · reads only what you
            already linked · /morning, on demand or on a schedule · a .skill
            file like the rest
          </p>
        </section>

        {/* 18. Autotask CI Intake */}
        <section id="autotask-ci-intake" className="panel rise">
          <div className="flex flex-wrap items-center gap-4">
            <span className="badge badge--ok">
              <span className="dot" /> Live · internal
            </span>
            <span className="badge badge--light">Claude Skill</span>
          </div>
          <h2 className="mt-6">Autotask CI Intake</h2>
          <p className="mt-2 text-sm text-faint">
            Configuration items built from what the tech already has, laid
            out in the order the entry form asks for them.
          </p>
          <p className="mt-4 text-sm">
            Documenting a client&apos;s hardware in Autotask is mostly
            typing, the same fields device after device into the New
            Configuration Item form. This skill does the reading first. The
            input is whatever the tech already has: a photographed serial
            label, an iDRAC or vCenter screen, an RMM or tool export, or
            pasted text. It sorts what it is given into the CI categories XL
            documents, among them Physical Server, Virtual Server, Storage,
            Network Devices, and Vendor, then picks the type inside. Back
            comes a field block per device, plus a row on the
            client&apos;s running inventory sheet. It prepares the entry,
            not the record: a tech pastes the block in and confirms the
            values before saving.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">01 · </span>
                A Column Is Not a Field
              </h3>
              <p className="mt-3 text-sm">
                In one documented run, backfilling a client environment, the
                main input was an RMM agent export, 23 columns across eight
                machines. Manufacturer read VMware on every row, so all
                eight logged as virtual servers. The serial column was
                populated on all eight, but with a VMware UUID, written down
                as such rather than entered as hardware. The operating
                system arrived in two pieces, a bare year and a build
                string, and resolved into four Windows Server releases.
                Purchase date was empty on every row, so each install date
                is the day that agent first checked in, derived rather than
                read.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">02 · </span>
                Parents Already on File
              </h3>
              <p className="mt-3 text-sm">
                A configuration item search export put the two hypervisor
                hosts in front of the run, already on file in Autotask as
                Physical Server records, and each virtual machine came back
                naming one of them as its parent rather than proposing a new
                host. Which host a machine ran on is nowhere in the agent
                export. That came from a vCenter view supplied with it, and
                the eight split across the two.
              </p>
            </div>
            <div className="border-t border-[var(--xl-line)] pt-4">
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">03 · </span>
                Where a Person Comes In
              </h3>
              <p className="mt-3 text-sm">
                What each machine was for appeared in neither input. That
                column came back from the one round of questions the run
                asked, roles a person supplied, among them a domain
                controller, a SQL server, an RDS session host, and a backup
                server. Status, installer, and location sat on our defaults,
                so nobody was asked. On one row the vCenter name disagreed
                with the name the agent reported. The row keeps the reported
                name, records the other beside it, and asks the tech which
                machine it is.
              </p>
            </div>
          </div>
          <p className="mt-8 text-sm">
            A Kaseya agent-procedure builder points into Kaseya: a tech
            imports its XML and an agent runs it on an endpoint. This one
            points the other way, turning what those agents already reported
            into an entry for a system that has no record of the machines
            yet. A log analyzer reads an export to explain a machine that is
            misbehaving. This reads one to establish what the machine is.
          </p>
          <p className="mono mt-6 text-xs text-faint">
            a photographed label, a management screen, or a 23-column agent
            export · category and type chosen per device · fields in new
            configuration item form order · per-client sheet, one tab per
            category · eight vms onto two hosts already on file · keyed into
            autotask by a tech, confirmed before saving
          </p>
        </section>

        {/* Team-submitted cards (§5.16) render inside this group (owner
            directive 2026-07-30: no separate numbered section). Renders
            nothing while empty; the DB read is guarded in WorkPage above,
            so the static exhibits never depend on it. */}
        <CommunitySection cards={team} />
      </section>

      {/* Bottom pager strip portal target: the island fills it only when
          there is more than one page; :empty keeps it out of the layout
          otherwise. */}
      <div id="work-pager-foot" className="work-pager-foot" />

      {/* Staff-only submit entry point: client-side session check, invisible
          to everyone else (§5.16). */}
      <StaffSubmitLink />

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
