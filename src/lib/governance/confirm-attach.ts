// Pure decision helpers + copy for the confirm-final panel's AI Roadmap
// auto-attach lane (§5.12, owner directive 2026-08-20: confirming a final
// draft attaches it to the company's AI Roadmap governance file by DEFAULT,
// with a visible opt-out before anything fires). Pure so the tests pin the
// decision table and the copy; the workspace and the question pane import
// from here rather than duplicating either.
//
// Copy rule (site-wide): no em or en dashes; ASCII plus the middle dot only.

/** Eligibility as the workspace holds it: null until the one lazy probe of
 * GET /api/roadmap/nav resolves (the route's own-lane `attach` verdict:
 * company member on the company lane, global admin on the staff lane). A
 * probe that failed or has not landed stays null and reads exactly like
 * ineligible: the panel withholds the roadmap line rather than promising a
 * lane that would 403. */
export type AttachEligibility = boolean | null;

/** Offer the roadmap line + checkbox only on a KNOWN-eligible lane. */
export function offerAttach(eligible: AttachEligibility): boolean {
  return eligible === true;
}

/** Fire the attach only when the offer was actually RENDERED (latched at
 * panel open, so a probe landing mid-panel cannot arm a checkbox the user
 * never saw) and the user left it checked. */
export function shouldAttach(offered: boolean, checked: boolean): boolean {
  return offered && checked;
}

export const CONFIRM_PANEL_LEAD =
  "Ready to finish? This marks the draft final.";

export const CONFIRM_ATTACH_LABEL =
  "Add the finished document to your company's AI Roadmap governance file.";

export const CONFIRM_ATTACH_HINT =
  "Uncheck this to skip it; you can add it later from the AI Roadmap governance page while this project is still on file.";

/** The panel-open announcement: one self-contained replacement for the live
 * region, naming the attach default only when the checkbox is on screen. */
export function confirmPanelAnnouncement(offered: boolean): string {
  return offered
    ? "Ready to finish. Make it final marks the draft final and adds the finished document to your company's AI Roadmap governance file; uncheck the box first if you do not want that."
    : "Ready to finish. Make it final marks the draft final.";
}

export const CONFIRM_CANCELLED_ANNOUNCE =
  "Okay. Nothing is final yet; the draft stays in review.";

/** The confirm receipt. The attaching variant is interim (the attach call
 * is still in flight); its outcome lands as a notice that replaces it. */
export function confirmedAnnouncement(attaching: boolean): string {
  return attaching
    ? "Final draft saved. Adding the document to your AI Roadmap."
    : "Final draft saved. Ready to download.";
}

export const ATTACHED_NOTICE =
  "Final draft saved. The document is on your company's AI Roadmap governance page.";

/** Attach failed AFTER a successful confirm: the draft's finality is never
 * in doubt, the server's own message explains the refusal, and the manual
 * lane is named as the recovery. */
export function attachFailedText(serverMessage: string): string {
  return [
    "The draft is final, but the document was not added to the AI Roadmap.",
    serverMessage.trim(),
    "You can add it from the AI Roadmap governance page.",
  ]
    .filter(Boolean)
    .join(" ");
}
