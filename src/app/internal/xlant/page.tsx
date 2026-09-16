// /internal/xlant — XLAnt's TOKEN AND COMPUTERS page for XL.net staff
// (ARCHITECTURE.md §5.22). The per-computer device-token mints, how to set a
// machine up, and the list of the caller's own computers holding a live token.
// XL.net staff only; the technician agent runs on XL-managed machines.
//
// THE BYTES LEFT THIS PAGE ON 2026-09-15, AND THE TOKEN DID NOT. Until then
// this page also served the installers, streamed from /opt/xlant-artifacts on
// this VM by a staff-gated route. XLAnt's own site now publishes them —
// https://xlant.ai/account/download — so the three Download buttons and the
// four artifacts reads behind them are gone, and one link takes their place.
//
// WHY THE SPLIT IS NOT ARBITRARY. A download is bytes; a mint is an act by a
// named member of XL.net staff. The bytes can live anywhere that can prove the
// person is entitled to them, and xlant.ai proves that by reading the relay's
// own monthly allowance for whoever is signed in there. The mint cannot move
// with them: it is authorised by an XL.net STAFF SESSION, that cookie lives on
// the xl.net zone, and xlant.ai is a different domain that cannot see it. So
// this page stays at exactly the URL every shipping XLAnt build already prints
// under its token box — "From https://ai.xl.net/internal/xlant" — for a build
// that will never update its own strings. Do not move it, do not redirect it.
//
// THE REST OF THAT PRINTED LINE IS NOW HALF TRUE, AND HONESTY ABOUT IT IS THE
// POINT. It ends "(Internal Tools → XLAnt)", and since 2026-09-15 no row in
// that menu is called "XLAnt": the owner asked that picking XLAnt out of the
// pulldown lead to the download, so the menu holds "XLAnt (download)" →
// xlant.ai and "XLAnt token & computers" → here. The URL still lands here
// whoever pastes it; the menu path is the part a fielded build now gets wrong,
// and the only real fix is a desktop release, tracked with the other four help
// strings in the xlant repo's docs/SETUP.md §3. Nothing on this page may claim
// that line is still correct word for word — it is not.
//
// ONE TOKEN PER COMPUTER SINCE 2026-09-08, and the token paragraph is the
// page's statement of it. The old paragraph said a new token of a kind
// replaced whatever token of that kind the person held and signed that machine
// out — which was true of the relay then, was the defect a person with two
// laptops reported, and is false now. A mint replaces NOTHING today: a token
// nobody pastes anywhere expires seven days after it was generated, and
// signing a computer out is a deliberate act in "Your computers" below, which
// is why that section exists at all.
//
// AND THE REINSTALL SENTENCE NAMES THE RIGHT MOMENT (refuter R2, F8). The
// relay binds a device to a computer NAME at `/incident/start`, not at hello,
// so a reinstalled XLAnt does not retire the computer's old token by
// connecting — it retires it the first time it reports something, which is
// either a problem it spotted or the daily check-up. Until then BOTH rows are
// live and "Your computers" shows two of them for one laptop, under a section
// whose own sentence says a row is one computer. The paragraph says so, and
// points at Sign out for the spare, because the person who has just handed a
// laptop back is exactly the person acting on this sentence.
//
// TWO CARDS SINCE CONTRACT 0.5.0, one per client kind, because the two are
// separate all the way down: a different build, a different token, a different
// first-run story (a Mac has to be walked past Gatekeeper; a PC does not). One
// merged set of steps would have to hedge every line, so the page repeats the
// shape instead and each card says one true thing.
//
// The layout has already gated, and this page re-reads the gate itself because
// a layout is not an authorization boundary for anything but the initial
// render (the /rfp doctrine — src/app/rfp/page.tsx does the same). The layout
// renders the denial screen, so a refusal here returns null rather than a
// second explainer.
//
// force-dynamic + revalidate 0 are load-bearing, not defaults: the house
// posture for public pages is ISR, and a gated page inheriting that would be
// rendered once and handed to every subsequent viewer, gate included. They
// stay after the artifact reads went: the two islands below are client
// components, but the GATE above them is this render's.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { DevicesList } from "./devices-list";
import { DeviceTokenButton } from "./token-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  // Absolute: the layout template would otherwise render "XLAnt — XL.net AI |
  // XL.net AI".
  title: { absolute: "XLAnt tokens & computers — XL.net AI" },
  // Also set on the /internal layout; repeated here so a future refactor of
  // either cannot quietly un-noindex a staff page.
  robots: { index: false, follow: false },
};

/** XLAnt's download area, spelled once and linked once. The same string lives
 * in src/components/nav-links.ts's Internal Tools submenu; if the two ever
 * disagree, one of them leads to a 404. */
const DOWNLOAD_URL = "https://xlant.ai/account/download";

const faint = { color: "var(--xl-text-faint)" } as const;

interface SetupStep {
  num: string;
  title: string;
  body: string;
}

const WINDOWS_STEPS: readonly SetupStep[] = [
  {
    num: "01",
    title: "Install it",
    body: "Run the installer and launch XLAnt. A small icon appears in your system tray and stays there — there is no window to keep open.",
  },
  {
    num: "02",
    title: "Open the panel from the tray",
    body: "Click the tray icon. The XLAnt panel opens: a thin card with a chat box, which is the only place XLAnt ever talks to you.",
  },
  {
    num: "03",
    title: "Paste your Windows token, then Save & validate",
    body: "On first run XLAnt asks for a device token — that is how it knows the PC is yours. Generate one below, paste it in, and click Save & validate. That is the whole setup. When a new version is out the tray shows a banner: one click downloads it, and it installs when you next quit XLAnt.",
  },
] as const;

// Five steps rather than three, and every extra one is a real difference: a
// zip is not an installer, /Applications is where the app has to live before
// the helper will install (a root daemon must not run code from a place the
// user can write), and this build is not signed by Apple, so the FIRST open is
// refused by Gatekeeper. Saying that plainly is the point — a staffer who is
// not warned reads "Apple cannot check it for malicious software" as a broken
// download and stops.
const MAC_STEPS: readonly SetupStep[] = [
  {
    num: "01",
    title: "Unzip it",
    body: "Double-click the download. macOS unpacks it into an XLAnt app beside it in your Downloads folder.",
  },
  {
    num: "02",
    title: "Drag XLAnt into Applications",
    body: "Open your Applications folder and drag XLAnt in. It has to live there: the administrator helper in step 05 refuses to install for an app anywhere else, because a helper that runs as root must not run code from a folder you can edit.",
  },
  {
    num: "03",
    title: "Open it — and allow it once",
    body: "This build is not signed by Apple yet, so macOS blocks the first open and says XLAnt “cannot be opened because Apple cannot check it for malicious software”. Click Done, open System Settings → Privacy & Security, scroll to Security, and click Open Anyway beside XLAnt. Open XLAnt again and confirm. That is a one-off; every later launch is ordinary. XLAnt has no window — it lives in the menu bar at the top of your screen.",
  },
  {
    // The update sentence names the DOWNLOAD AREA, not this page. This page has
    // not held the builds since 2026-09-15, so "come back to this page and
    // repeat these steps" would send a Mac staffer somewhere with nothing on
    // it — and a Mac cannot update itself, so that sentence is the only thing
    // standing between them and a build that never moves again.
    num: "04",
    title: "Paste your Mac token, then Save & validate",
    body: "On first run XLAnt asks for a device token — that is how it knows the Mac is yours. Generate one below, paste it in, and click Save & validate. Because this build is unsigned, macOS will not let it update itself: when a new version is published, download it again from XLAnt's download area at the top of this page and set it up the same way.",
  },
  {
    num: "05",
    title: "Install the administrator helper",
    body: "From the XLAnt menu choose “Install the administrator helper…”. macOS asks for an administrator’s password once. After that, anything that needs administrator rights runs without another password box — and XLAnt still asks you first, in words, before it does it. Skip this and XLAnt works, but a repair that needs an administrator has to go to XL.net instead.",
  },
] as const;

function SetupSteps({ steps }: { steps: readonly SetupStep[] }) {
  return (
    <div className="mt-8 space-y-6">
      {steps.map((step) => (
        <div key={step.num} className="border-t border-[var(--xl-line)] pt-4">
          <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
            <span className="text-faint">{step.num} · </span>
            {step.title}
          </h3>
          <p className="mt-3 max-w-none text-sm">{step.body}</p>
        </div>
      ))}
    </div>
  );
}

export default async function XlantPage() {
  const gate = await requireRfpPage("/internal/xlant");
  if (!gate.ok) return null; // the layout renders the denial

  return (
    <div className="mx-auto max-w-3xl space-y-16">
      <section className="pt-4">
        <span className="sys-label">XL.net / Internal Tools</span>
        <h1 className="mt-6">
          XLAnt, a friendly <span className="glow">IT helper</span> in your tray
        </h1>
        <p className="mt-6 text-lg">
          XLAnt sits quietly in your system tray — the menu bar, on a Mac — and
          watches for the moment something goes wrong on your machine: an app
          crashes, a program stops responding, an error window appears. When it
          notices, it asks you one plain question:{" "}
          <strong>&ldquo;Can I help attempt to resolve the error?&rdquo;</strong>
        </p>
        <p className="mt-4">
          Click <strong>Yes</strong> and XLAnt goes to work on it, keeping you
          posted in plain language the whole time — no jargon, no ticket queue,
          no waiting on hold. Click <strong>No</strong> and it steps out of
          your way. You can also open the panel and simply ask XLAnt for a hand
          whenever you want one.
        </p>
        <p className="mt-4">
          XLAnt works on your machine only through this connection, and
          nothing on it is changed until you click <strong>Yes</strong>. Once a
          day it takes a look at how the machine is doing without being asked —
          that check-up only looks. It never runs anything you would not want
          it to: a shell guard blocks destructive commands outright, and
          anything that needs a restart or administrator rights is asked for
          first, in words, before it happens.
        </p>
      </section>

      <hr className="horizon" />

      <section>
        <span className="sys-label">Download</span>
        <h2 className="mt-6">Get it on your machine</h2>
        <p className="mt-6">
          The builds live on XLAnt&rsquo;s own site — Windows, and both Mac
          builds — and you sign in there with your work address to get them:
        </p>
        <p className="mt-4">
          {/* A plain anchor, not <Link>: another origin. The visible text is
              the URL itself so it can be read off a screen and typed into a
              machine that is not this one — which is exactly the situation a
              person setting up a second laptop is in. */}
          <a href={DOWNLOAD_URL} rel="noopener" className="btn btn--primary no-underline">
            {DOWNLOAD_URL}
          </a>
        </p>
        <p className="mt-4 text-sm" style={faint}>
          Two Mac builds are offered there and they are not interchangeable:
          Apple silicon is every Mac with an M-series chip, Intel is the older
          ones. If you are not sure, open the Apple menu → About This Mac and
          read the Chip or Processor line.
        </p>
        <p className="mt-4 text-sm">
          The token each machine needs is generated here, on this page, and
          nowhere else — the download area does not issue one.
        </p>
      </section>

      <section>
        <span className="sys-label">Tokens</span>
        <h2 className="mt-6">One token per computer</h2>
        <p className="mt-6">
          One token per computer, and as many computers as you have: a Windows
          token for each PC, a Mac token for each Mac. A token is shown{" "}
          <strong>once</strong>, right here, so copy it before you leave the
          page. Generating a token never signs another computer out — every
          machine you have already set up keeps working, whichever kind it is,
          and generating a second token changes nothing about the first. A
          token you generate and never paste anywhere expires on its own{" "}
          <strong>seven days</strong>{" "}
          later, so one that gets away from you stops being useful without
          anybody having to do anything. And when you set XLAnt up again on a
          computer that already had it, the old token there is retired the
          first time the new one reports something — a problem it has spotted,
          or the daily check-up — so until that happens you may see two rows
          below for the one computer, the newer of them still without a name.
          To sign a computer out on purpose — a laptop you have handed back,
          one you have lost, the spare row after a reinstall — use{" "}
          <strong>Your computers</strong> below.
        </p>
      </section>

      <section className="panel">
        <span className="sys-label">XLAnt for Windows</span>
        <h2 className="mt-6">Windows 11</h2>
        <p className="mono mt-6 text-xs" style={faint}>
          windows 11 · signed by XL.net · updates arrive as a tray banner
        </p>
        <SetupSteps steps={WINDOWS_STEPS} />
        <DeviceTokenButton kind="windows" />
      </section>

      <section className="panel">
        <span className="sys-label">XLAnt for Mac</span>
        <h2 className="mt-6">macOS 13 or later</h2>
        <p className="mono mt-6 text-xs" style={faint}>
          macos 13+ · not signed by Apple yet · allow it once in Privacy &amp;
          Security · no self-update
        </p>
        <SetupSteps steps={MAC_STEPS} />
        <DeviceTokenButton kind="mac" />
      </section>

      <section className="panel">
        <span className="sys-label">Your computers</span>
        <h2 className="mt-6">Signed in right now</h2>
        <p className="mt-6 text-sm">
          A row is one token and the computer holding it: sign it out and that
          token stops working the moment you click, and none of your other
          computers is touched. A computer puts its name here the first time it
          reports something, so a row can sit without a name for a while — that
          is normal, and the computer is working.
        </p>
        <DevicesList />
      </section>

      <section className="panel">
        <span className="sys-label">A note on privacy</span>
        <p className="mt-4 text-sm">
          XLAnt keeps its log on your own machine, and that log self-cleans
          after 90 days — adjustable, or off entirely, in the app&rsquo;s
          settings. Nothing on your machine is changed until you click{" "}
          <strong>Yes</strong>: until then XLAnt is watching for errors and
          taking its daily look, neither of which changes anything, and a{" "}
          <strong>No</strong> ends it there.
        </p>
      </section>

      <div className="flex justify-center">
        <p className="staff-bar">
          <span className="badge badge--sand">Internal</span>
          <span className="text-faint">
            XL.net staff tool. The technician agent runs on XL-managed machines.
          </span>
        </p>
      </div>
    </div>
  );
}
