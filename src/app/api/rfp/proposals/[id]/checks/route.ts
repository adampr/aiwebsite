// POST /api/rfp/proposals/[id]/checks — ignore or restore one check finding.
//
//   { op: "ignore",  sig } — persistently dismiss the finding whose
//     findingSig matches `sig` ON THE LAST STORED RUN. The sig must match a
//     stored violation, which stops forged or blind dismissal writes: a
//     client can only dismiss what the gate actually reported.
//   { op: "restore", sig } — remove that dismissal.
//
// Both ops re-derive gate_json = applyIgnores(stored result, new ignores)
// and persist BOTH columns transactionally (writeProposalChecksState locks
// the row with SELECT ... FOR UPDATE and hands this route the in-tx values,
// so two racing ignores compose and the sig is re-validated against the row
// as read under the lock). No rev bump: an ignore changes no content.
// Responds with the updated GateResult so the client can setGateResult
// directly, exactly what the sibling gate route returns.

import { logRfpActivity } from "@/lib/rfp/activity";
import {
  appendIgnore,
  applyIgnores,
  findingSig,
  parseCheckIgnores,
} from "@/lib/rfp/check-ignores";
import { getOwnedProposal, writeProposalChecksState } from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import type { GateResult } from "@/lib/rfp/validators/gate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_SIG_CHARS = 1200;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/checks");
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

  let body: { op?: string; sig?: string };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const op = body.op;
  if (op !== "ignore" && op !== "restore")
    return rfpError("invalid_request", "op must be ignore or restore.", 400);
  const sig = body.sig;
  if (typeof sig !== "string" || !sig || sig.length > MAX_SIG_CHARS)
    return rfpError("invalid_request", "Send the finding's signature.", 400);

  // The decision runs INSIDE the row lock; these closures carry its verdict
  // out (mutate is synchronous and pure, so this is safe).
  let failure: { code: string; message: string; status: number } | null = null;
  let updated: GateResult | null = null;
  let meta: { ruleId: string; severity: string | null; ignored: number } | null =
    null;

  const written = await writeProposalChecksState(proposal.id, (current) => {
    // Re-checked under the lock: the unlocked check above answers fast for
    // the common case, but a proposal marked sent between that read and this
    // transaction must still refuse (the gap/references-gap precedent).
    if (current.status === "sent") {
      failure = {
        code: "immutable",
        message: "A sent proposal is never edited. A correction creates a new one.",
        status: 409,
      };
      return null;
    }
    let stored: GateResult | null = null;
    try {
      stored = current.gateJson ? JSON.parse(current.gateJson) : null;
    } catch {
      stored = null;
    }
    if (
      !stored ||
      !Array.isArray(stored.violations) ||
      !Array.isArray(stored.errors)
    ) {
      failure = {
        code: "run_checks_first",
        message:
          "The checks have not run on this draft yet. Run them first, then ignore a finding.",
        status: 409,
      };
      return null;
    }
    const ignores = parseCheckIgnores(current.checksIgnoresJson);

    if (op === "ignore") {
      const match = stored.violations.find(
        (v) => v && typeof v === "object" && v.locator && findingSig(v) === sig
      );
      if (!match) {
        failure = {
          code: "not_found",
          message:
            "That finding is not on the last check run. Run the checks again.",
          status: 404,
        };
        return null;
      }
      const next = appendIgnore(ignores, {
        sig,
        ruleId: match.ruleId,
        note: match.message.slice(0, 200),
        by: user.email,
        at: new Date().toISOString(),
      });
      updated = applyIgnores(stored, next);
      meta = { ruleId: match.ruleId, severity: match.severity, ignored: next.length };
      return {
        ignoresJson: JSON.stringify(next),
        gateJson: JSON.stringify(updated),
      };
    }

    const hit = ignores.find((e) => e.sig === sig);
    if (!hit) {
      failure = {
        code: "not_found",
        message: "That finding is not ignored.",
        status: 404,
      };
      return null;
    }
    const next = ignores.filter((e) => e.sig !== sig);
    updated = applyIgnores(stored, next);
    const match = stored.violations.find(
      (v) => v && typeof v === "object" && v.locator && findingSig(v) === sig
    );
    meta = {
      ruleId: hit.ruleId,
      severity: match?.severity ?? null,
      ignored: next.length,
    };
    return {
      ignoresJson: JSON.stringify(next),
      gateJson: JSON.stringify(updated),
    };
  });

  if (failure) {
    const f = failure as { code: string; message: string; status: number };
    return rfpError(f.code, f.message, f.status);
  }
  // The row vanished between the ownership check and the lock (a concurrent
  // admin delete): same 404 the ownership check would have given.
  if (!written || !updated || !meta) return notFound();

  const m = meta as { ruleId: string; severity: string | null; ignored: number };
  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: op === "ignore" ? "proposal.check_ignore" : "proposal.check_restore",
    subjectKind: "proposal",
    subjectId: proposal.id,
    // Shape only (house discipline: violation messages can quote the
    // client's RFP, and the sig embeds the excerpt): rule id, severity,
    // lengths and counts, never text.
    meta: {
      ruleId: m.ruleId,
      severity: m.severity,
      sigChars: sig.length,
      ignored: m.ignored,
    },
  });

  return rfpOk(updated);
}
