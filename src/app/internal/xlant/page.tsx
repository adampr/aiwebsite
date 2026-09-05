// /internal/xlant — XLAnt's human-facing home (ARCHITECTURE.md §5.22): the
// downloads, the per-user device-token mints, and how to set them up. XL.net
// staff only; the technician agent runs on XL-managed machines.
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
// rendered once and handed to every subsequent viewer, gate included.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import {
  latestInstaller,
  latestMacBundle,
  xlantConfig,
  type InstallerInfo,
} from "@/lib/xlant";
import { DeviceTokenButton } from "./token-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  // Absolute: the layout template would otherwise render "XLAnt — XL.net AI |
  // XL.net AI".
  title: { absolute: "XLAnt — XL.net AI" },
  // Also set on the /internal layout; repeated here so a future refactor of
  // either cannot quietly un-noindex a staff page.
  robots: { index: false, follow: false },
};

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
    num: "04",
    title: "Paste your Mac token, then Save & validate",
    body: "On first run XLAnt asks for a device token — that is how it knows the Mac is yours. Generate one below, paste it in, and click Save & validate. Because this build is unsigned, macOS will not let it update itself: when a new version is published, come back to this page and repeat these steps.",
  },
  {
    num: "05",
    title: "Install the administrator helper",
    body: "From the XLAnt menu choose “Install the administrator helper…”. macOS asks for an administrator’s password once. After that, anything that needs administrator rights runs without another password box — and XLAnt still asks you first, in words, before it does it. Skip this and XLAnt works, but a repair that needs an administrator has to go to XL.net instead.",
  },
] as const;

/** One download button, or the plain truth that there is nothing to offer.
 * The label is assembled as ONE string so it cannot ship with a stray double
 * space, and the MB is the size the browser will report. `forWhat` names the
 * machine rather than the file, because that is the choice a staffer is
 * actually making — "Apple silicon" or "Intel", not "arm64" or "x64". */
function DownloadButton({
  artifact,
  href,
  forWhat,
}: {
  artifact: InstallerInfo | null;
  href: string;
  forWhat: string;
}) {
  if (!artifact) {
    return (
      <p className="mt-4 text-sm" style={faint}>
        XLAnt for {forWhat}: not published yet.
      </p>
    );
  }
  return (
    <p className="mt-4">
      <a href={href} className="btn btn--primary no-underline">
        {`Download XLAnt ${artifact.version} for ${forWhat} (${Math.round(artifact.size / 1024 / 1024)} MB)`}
      </a>
    </p>
  );
}

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

  const cfg = xlantConfig();
  // Four reads of the same directory, all of which degrade to null: an
  // unarmed host, an unreadable directory or a platform nobody has published
  // yet each render as "not published yet" rather than refusing the page.
  const [installer, macArm64, macX64] = cfg
    ? await Promise.all([
        latestInstaller(cfg),
        latestMacBundle(cfg, "arm64"),
        latestMacBundle(cfg, "x64"),
      ])
    : [null, null, null];

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
          Click <strong>Yes</strong> and an XL.net technician agent goes to
          work on it, keeping you posted in plain language the whole time — no
          jargon, no ticket queue, no waiting on hold. Click <strong>No</strong>{" "}
          and it steps out of your way. You can also open the panel and simply
          ask XLAnt for a hand whenever you want one.
        </p>
        <p className="mt-4">
          The technician reaches your machine only through XLAnt, and only while
          you are watching. It never runs anything you would not want it to: a
          shell guard blocks destructive commands outright, and anything that
          needs a restart or administrator rights is asked for first, in words,
          before it happens.
        </p>
      </section>

      <hr className="horizon" />

      <section>
        <span className="sys-label">Download</span>
        <h2 className="mt-6">Get it on your machine</h2>
        <p className="mt-6">
          One token per machine, and one per kind: your Windows token and your
          Mac token are separate, and generating one never signs the other out.
          A token is shown <strong>once</strong>, right here, so copy it before
          you leave the page. Generating a new token of a kind replaces
          whatever XLAnt token of that kind you already had, wherever it came
          from — including one you generated on the old roleplay.xl.net
          downloads page, now retired — and the machine holding it is signed
          out. That is exactly what you want when you move to a new machine, and
          exactly what you do not want by accident.
        </p>
      </section>

      <section className="panel">
        <span className="sys-label">XLAnt for Windows</span>
        <h2 className="mt-6">Windows 11</h2>
        <DownloadButton
          artifact={installer}
          href="/api/internal/xlant/download"
          forWhat="Windows 11"
        />
        <p className="mono mt-4 text-xs" style={faint}>
          windows 11 · signed by XL.net · updates arrive as a tray banner
        </p>
        <SetupSteps steps={WINDOWS_STEPS} />
        <DeviceTokenButton kind="windows" />
      </section>

      <section className="panel">
        <span className="sys-label">XLAnt for Mac</span>
        <h2 className="mt-6">macOS 13 or later</h2>
        <p className="mt-6 text-sm">
          Two builds, and they are not interchangeable. Apple silicon is every
          Mac with an M-series chip; Intel is the older ones. If you are not
          sure, open the Apple menu → About This Mac and read the Chip or
          Processor line.
        </p>
        <DownloadButton
          artifact={macArm64}
          href="/api/internal/xlant/download?platform=mac&arch=arm64"
          forWhat="Apple silicon"
        />
        <DownloadButton
          artifact={macX64}
          href="/api/internal/xlant/download?platform=mac&arch=x64"
          forWhat="Intel"
        />
        <p className="mono mt-4 text-xs" style={faint}>
          macos 13+ · not signed by Apple yet · allow it once in Privacy &
          Security · no self-update
        </p>
        <SetupSteps steps={MAC_STEPS} />
        <DeviceTokenButton kind="mac" />
      </section>

      <section className="panel">
        <span className="sys-label">A note on privacy</span>
        <p className="mt-4 text-sm">
          XLAnt keeps its log on your own machine, and that log self-cleans
          after 90 days — adjustable, or off entirely, in the app&rsquo;s
          settings. Nothing runs on your machine until you click{" "}
          <strong>Yes</strong>: until then XLAnt is only watching for errors,
          and a <strong>No</strong> ends it there.
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
