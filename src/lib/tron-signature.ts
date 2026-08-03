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
