// Host mirror of the module's outbound email signature block,
// signatureBlock() in packages/aicompany/src/channels/email-inbound.ts
// (module §5.3; disclosure line per §1, memory line per §18). The module
// does not export it and the submodule is never modified, so the host
// rebuilds it from the SAME siteConfig fields. KEEP IN SYNC with the module
// function on every @aicompany/core upgrade; scripts/work-tests.ts pins
// both this mirror's exact output AND a hash of the module function's
// source, so drift on either side fails the suite.

import { formatSmsNumber } from "@aicompany/core/lib/phone";
import { siteConfig } from "site.config";

/** Tron's normal outbound email signature, byte-equal to the block the
 * module appends to his conversational replies from the same mailbox.
 * Owner ruling 2026-08-03: this block appears in ALL emails Tron sends,
 * including the /work intake's rejections and receipts. */
export function tronSignature(config = siteConfig): string {
  const lines = [
    config.persona.name,
    (config.oversight.aiDisclosure ? "AI Agent, " : "") + config.site.name,
    config.channels.email.mailbox,
  ];
  if (config.channels.sms.enabled) {
    const voice = config.channels.voice;
    const callout =
      voice.enabled || voice.externallyHandled ? "Call or Text" : "Text";
    lines.push(
      `${formatSmsNumber(config.channels.sms.phoneNumber)} · ${callout}`
    );
  }
  lines.push(config.site.baseUrl);
  if (config.memory.enabled && config.memory.emailDisclosure.trim()) {
    lines.push(config.memory.emailDisclosure.trim());
  }
  return lines.join("\n");
}

/** The From line for EVERY host-composed outbound email (owner ruling
 * 2026-08-06: exactly one persona). Derived from the SAME two config fields
 * the signature's first and third lines use, so the header and the block can
 * never name different people. site.config.ts keeps `oversight.mailFrom` as
 * a literal (this file imports site.config, so site.config must never import
 * this file); scripts/work-tests.ts pins the two strings equal. */
export const TRON_FROM = `${siteConfig.persona.name} <${siteConfig.channels.email.mailbox}>`;

// The signature is appended INSIDE the send helpers (email-intake's
// sendTronEmail, governance sendGovernanceEmail, sendRoadmapEmail, the two
// raw senders in src/lib/work/notify.ts, and the nightly governance script's
// own seam), never per call site: per-call-site signing is how unsigned
// lanes shipped twice (2026-08-03 and 2026-08-06 owner reports). The
// endsWith guard makes the wrapper idempotent so a body that already carries
// the block (or a future double-wrap) can never double-sign.
function signed(text: string, sig: string): string {
  const body = text.trimEnd();
  return body.endsWith(sig) ? body : `${body}\n\n${sig}`;
}

export function withTronSignature(text: string): string {
  return signed(text, tronSignature());
}
