// PUT /api/rfp/proposals/[id]/pricing — set quantities, get a computed quote.
//
// The body carries QUANTITIES AND CHOICES ONLY (user counts, retention tier,
// flags). Every dollar figure in the stored quote is computed server-side by
// src/lib/rfp/quote.ts from the rate card in force; a figure arriving in the
// request body has nowhere to land. This is rule B5/B7's premise made
// structural. No brain call: the update is instant, which is what lets the
// workspace's pricing questions update the document as each answer lands.

import { logRfpActivity } from "@/lib/rfp/activity";
import { currentRateCard, getOwnedProposal, writeProposalPricing } from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import {
  buildQuote,
  parseInputsSource,
  parseQuoteInputs,
  toRateCard,
} from "@/lib/rfp/quote";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("PUT /api/rfp/proposals/[id]/pricing");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  if (proposal.status === "sent")
    return rfpError(
      "immutable",
      "A sent proposal is never edited. A correction creates a new one.",
      409
    );

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const inputs = parseQuoteInputs(body);

  // Provenance is server-derived, never client-asserted: parseQuoteInputs
  // cannot yield fullyManagedUsersSource, so the only way "rfp" survives a
  // save is the stored count arriving back unchanged. Any other value is a
  // staff entry from here on.
  const stored = proposal.pricingInputsJson
    ? (JSON.parse(proposal.pricingInputsJson) as unknown)
    : null;
  const storedSource = parseInputsSource(stored);
  const nextSource =
    inputs.fullyManagedUsers === parseQuoteInputs(stored).fullyManagedUsers
      ? storedSource
      : "staff";

  const cardView = await currentRateCard();
  if (!cardView)
    return rfpError(
      "unavailable",
      "No rate card is loaded, so nothing can be priced.",
      503
    );

  const built = buildQuote(toRateCard(cardView), inputs, proposal.id);

  const ok = await writeProposalPricing(
    proposal.id,
    proposal.rev,
    JSON.stringify({ ...inputs, fullyManagedUsersSource: nextSource }),
    built.ready ? JSON.stringify(built.quote) : null
  );
  if (!ok)
    return rfpError(
      "conflict",
      "This draft changed while you were answering. Reload to see the latest.",
      409
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.pricing_set",
    subjectKind: "proposal",
    subjectId: proposal.id,
    // Shape only, never money: counts say a quote exists, not what it says.
    meta: {
      illustrations: built.quote.illustrations.length,
      lines: built.quote.illustrations.reduce((n, i) => n + i.lines.length, 0),
      notes: built.quote.notes.length,
      ready: built.ready,
    },
  });

  return rfpOk({
    quote: built.ready ? built.quote : null,
    ready: built.ready,
    missing: built.missing,
    rev: proposal.rev + 1,
    // The client adopts the SERVER's verdict on inputs and provenance; a
    // client mirroring the flip locally could keep a stale "From the RFP"
    // chip on a hand-edited number.
    inputs: { ...inputs, fullyManagedUsersSource: nextSource },
  });
}
