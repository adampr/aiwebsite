// /internal/xlant — XLAnt's human-facing home (ARCHITECTURE.md §5.22): the
// Windows installer download, the per-user device-token mint, and how to set
// it up. XL.net staff only; the technician agent runs on XL-managed PCs.
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
import { latestInstaller, xlantConfig } from "@/lib/xlant";
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

const SETUP_STEPS = [
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

export default async function XlantPage() {
  const gate = await requireRfpPage("/internal/xlant");
  if (!gate.ok) return null; // the layout renders the denial

  const cfg = xlantConfig();
  const installer = cfg ? await latestInstaller(cfg) : null;
  // One string, so the button label cannot ship with a stray double space.
  const downloadLabel = installer
    ? `Download XLAnt ${installer.version} for Windows 11 (${Math.round(installer.size / 1024 / 1024)} MB)`
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-16">
      <section className="pt-4">
        <span className="sys-label">XL.net / Internal Tools</span>
        <h1 className="mt-6">
          XLAnt, a friendly <span className="glow">IT helper</span> in your tray
        </h1>
        <p className="mt-6 text-lg">
          XLAnt sits quietly in your system tray and watches for the moment
          something goes wrong on your PC — an app crashes, a program stops
          responding, an error window appears. When it notices, it asks you one
          plain question: <strong>&ldquo;Can I help attempt to resolve the
          error?&rdquo;</strong>
        </p>
        <p className="mt-4">
          Click <strong>Yes</strong> and an XL.net technician agent goes to
          work on it, keeping you posted in plain language the whole time — no
          jargon, no ticket queue, no waiting on hold. Click <strong>No</strong>{" "}
          and it steps out of your way. You can also open the panel and simply
          ask XLAnt for a hand whenever you want one.
        </p>
        <p className="mt-4">
          The technician reaches your PC only through XLAnt, and only while you
          are watching. It never runs anything you would not want it to: a shell
          guard blocks destructive commands outright, and anything that needs a
          restart or administrator rights is asked for first, in words, before
          it happens.
        </p>
      </section>

      <hr className="horizon" />

      <section>
        <span className="sys-label">Download</span>
        <h2 className="mt-6">Get it on your PC</h2>
        {downloadLabel ? (
          <>
            <p className="mt-6">
              <a
                href="/api/internal/xlant/download"
                className="btn btn--primary no-underline"
              >
                {downloadLabel}
              </a>
            </p>
            <p className="mono mt-4 text-xs" style={faint}>
              windows 11 · signed by XL.net · updates arrive as a tray banner
            </p>
          </>
        ) : (
          <p className="mt-6">
            No installer has been published yet — check back shortly.
          </p>
        )}
      </section>

      <section>
        <span className="sys-label">Setting it up</span>
        <h2 className="mt-6">Three steps, about a minute</h2>
        <div className="mt-8 space-y-6">
          {SETUP_STEPS.map((step) => (
            <div
              key={step.num}
              className="border-t border-[var(--xl-line)] pt-4"
            >
              <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                <span className="text-faint">{step.num} · </span>
                {step.title}
              </h3>
              <p className="mt-3 max-w-none text-sm">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <span className="sys-label">Device token</span>
        <h2 className="mt-6">One token per PC</h2>
        <p className="mt-6">
          The token is how XLAnt proves the PC is yours. It is shown{" "}
          <strong>once</strong>, right here, so copy it before you leave the
          page. Generating a new one replaces whatever XLAnt token you already
          had, wherever it came from — including one you generated on the old
          roleplay.xl.net downloads page, now retired — and the
          PC holding it is signed out. That is exactly what you want when you
          move to a new machine, and exactly what you do not want by accident.
        </p>
        <DeviceTokenButton />
      </section>

      <section className="panel">
        <span className="sys-label">A note on privacy</span>
        <p className="mt-4 text-sm">
          XLAnt keeps its log on your own PC, and that log self-cleans after 90
          days — adjustable, or off entirely, in the app&rsquo;s settings.
          Nothing runs on your PC until you click <strong>Yes</strong>: until
          then XLAnt is only watching for errors, and a <strong>No</strong>{" "}
          ends it there.
        </p>
      </section>

      <div className="flex justify-center">
        <p className="staff-bar">
          <span className="badge badge--sand">Internal</span>
          <span className="text-faint">
            XL.net staff tool. The technician agent runs on XL-managed PCs.
          </span>
        </p>
      </div>
    </div>
  );
}
