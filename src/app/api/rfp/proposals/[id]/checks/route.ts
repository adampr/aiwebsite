// POST /api/rfp/proposals/[id]/checks: ignore or restore check findings.
//
//   { op: "ignore",  sig } — persistently dismiss the finding whose
//     findingSig matches `sig` ON THE LAST STORED RUN. The sig must match a
//     stored violation, which stops forged or blind dismissal writes: a
//     client can only dismiss what the gate actually reported.
//   { op: "restore", sig } — remove that dismissal.
//   { op, sigs: string[] }: the same for a grouped row (§5.17.8: one row
//     per rule id and message, each member its own stored violation). All or
//     nothing: EVERY sig must qualify (ignore: matches a stored violation;
//     restore: is ignored) or nothing is written. 1..50 distinct sigs.
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
/** A grouped row's member count is bounded by what one run reports; 50 is
 *  far above any real duplicate-phrase group and bounds the lock's work. */
const MAX_SIGS = 50;

const validSig = (sig: unknown): sig is string =>
  typeof sig === "string" && sig.length > 0 && sig.length <= MAX_SIG_CHARS;

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

  let body: { op?: string; sig?: unknown; sigs?: unknown };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const op = body.op;
  if (op !== "ignore" && op !== "restore")
    return rfpError("invalid_request", "op must be ignore or restore.", 400);
  // `sigs` (a grouped row) or `sig` (one finding, the original shape, whose
  // behaviour is unchanged). A batch is validated whole before the lock.
  const batch = body.sigs !== undefined;
  let sigs: string[];
  if (batch) {
    const raw = body.sigs;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > MAX_SIGS ||
      !raw.every(validSig) ||
      new Set(raw).size !== raw.length
    )
      return rfpError(
        "invalid_request",
        `Send 1 to ${MAX_SIGS} distinct finding signatures.`,
        400
      );
    sigs = raw;
  } else {
    if (!validSig(body.sig))
      return rfpError("invalid_request", "Send the finding's signature.", 400);
    sigs = [body.sig];
  }

  // The decision runs INSIDE the row lock; these closures carry its verdict
  // out (mutate is synchronous and pure, so this is safe).
  let failure: { code: string; message: string; status: number } | null = null;
  let updated: GateResult | null = null;
  let meta: {
    ruleId: string;
    severity: string | null;
    ignored: number;
  } | null = null;

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
    const storedResult: GateResult = stored;
    const ignores = parseCheckIgnores(current.checksIgnoresJson);
    const matchFor = (sig: string) =>
      storedResult.violations.find(
        (v) => v && typeof v === "object" && v.locator && findingSig(v) === sig
      );

    if (op === "ignore") {
      // Every sig is resolved BEFORE anything is appended: one unmatched
      // member refuses the whole batch with nothing written.
      const matches = sigs.map((sig) => ({ sig, match: matchFor(sig) }));
      if (matches.some((m) => !m.match)) {
        failure = {
          code: "not_found",
          message:
            "That finding is not on the last check run. Run the checks again.",
          status: 404,
        };
        return null;
      }
      const at = new Date().toISOString();
      let next = ignores;
      for (const { sig, match } of matches)
        next = appendIgnore(next, {
          sig,
          ruleId: match!.ruleId,
          note: match!.message.slice(0, 200),
          by: user.email,
          at,
        });
      updated = applyIgnores(storedResult, next);
      const first = matches[0].match!;
      meta = { ruleId: first.ruleId, severity: first.severity, ignored: next.length };
      return {
        ignoresJson: JSON.stringify(next),
        gateJson: JSON.stringify(updated),
      };
    }

    const hits = sigs.map((sig) => ignores.find((e) => e.sig === sig));
    if (hits.some((h) => !h)) {
      failure = {
        code: "not_found",
        message: "That finding is not ignored.",
        status: 404,
      };
      return null;
    }
    const drop = new Set(sigs);
    const next = ignores.filter((e) => !drop.has(e.sig));
    updated = applyIgnores(storedResult, next);
    const match = matchFor(sigs[0]);
    meta = {
      ruleId: hits[0]!.ruleId,
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
    // A batch adds its size; the single-sig shape stays byte-for-byte.
    meta: batch
      ? {
          ruleId: m.ruleId,
          severity: m.severity,
          sigChars: sigs.reduce((n, s) => n + s.length, 0),
          ignored: m.ignored,
          count: sigs.length,
        }
      : {
          ruleId: m.ruleId,
          severity: m.severity,
          sigChars: sigs[0].length,
          ignored: m.ignored,
        },
  });

  return rfpOk(updated);
}
