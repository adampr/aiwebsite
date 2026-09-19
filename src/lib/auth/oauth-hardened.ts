// Host-owned OAuth callback handlers for Google and Microsoft (§5.18).
//
// WHY THESE EXIST (and the module's createOAuthCallbackHandler is not used):
// the roadmap's tenancy boundary is the session's email DOMAIN, so the email
// claim must be VERIFIED, and this site records that verdict in a per-login
// HMAC-covered session claim `mv: true` that the module's own callback does
// not mint. The claim is per-login, never a stored users-row flag — a stored
// flag would let a later forged login inherit an earlier genuine
// verification. Sessions minted here are byte-compatible with the module's
// (same signSession, same cookie); everything else on the site ignores `mv`.
//
// THE IDENTITY BINDING IS THE MODULE'S, NOT A FORK OF IT (v1.137, §5.5).
// Believing the email a provider reports was the defect: Microsoft's Graph
// `mail` is PATCH-writable by the admin of whatever Entra tenant the account
// lives in, and under MICROSOFT_TENANT_ID=common anyone can bring their own
// tenant (the published nOAuth forgery); Google's userinfo was read without
// looking at `email_verified` at all. The module now binds the provider's
// IMMUTABLE account id (google `sub`; microsoft `tid:oid`, both from the ID
// TOKEN) to the address, and this file calls exactly those exported
// functions — gateOAuthIdentity() for the provider round trip and
// consumeOAuthConfirmation() for the emailed link. There is no second copy of
// that judgement here: googleVouch/microsoftVouch/decode*IdToken all come
// from @aicompany/core/auth/oauth-identity. A host that kept its own copy
// would be a host where the module's next fix does not land.
//
// `mv` KEEPS ITS EXACT MEANING: the PROVIDER's own word proved this address
// (Google `email_verified` on an id token whose account Google runs, or the
// Microsoft `xms_edov` domain-ownership claim about the token's own email).
// googleVerdict()/microsoftVerdict() below are that rule, expressed through
// the module's vouch functions. The operator's trusted-tenant word
// (auth.oauthBinding.trustedMicrosoftTenants) is enough to BIND an identity
// with no confirmation email, and deliberately does NOT mint `mv`: "the
// operator trusts that directory" is not "the provider vouched for this
// mailbox", and /rfp's staff gate rests on the second (src/lib/rfp/access.ts).
//
// PIPELINE-PARITY RULE (do not break): because this file REIMPLEMENTS the
// pipeline, nothing the module adds to `handleOAuthUser()` reaches the live
// site automatically. Every refusal the module gates sign-in on must be
// mirrored here by hand. Today that is `isEmailArchived()` (module §5.5
// v1.74) and the v1.137 binding gate. Both callbacks on this site (Google and
// Microsoft) and the §5.18 silent re-verify lane all mint their session
// inside completeSignIn() below, so a refusal placed before it covers every
// session-minting path.
//
// EVERY SESSION THIS FILE MINTS CARRIES emailProof: "oauth-binding", and it
// is minted ONLY after the gate answered `bound` or the emailed link answered
// `confirmed`. The module's verifySessionToken REFUSES a google/microsoft
// cookie without that claim, so the claim is not decoration: omit it and the
// person is bounced back to /login in a loop. It is spread LAST, after the
// sessionExtras hook, and stripped from those extras — a reserved claim, like
// userId and email.
//
// EMAIL CONTINUITY (do not change): the upsert email stays EXACTLY what the
// module used — Google userinfo `email`, Microsoft Graph `mail ||
// userPrincipalName`. users.email is UNIQUE and keys the upsert; sourcing it
// from the id_token instead would fork existing accounts whose token email
// differs from their Graph mail (aliases are common in M365). The id_token is
// used only to JUDGE the email and to NAME THE ACCOUNT, never to BE it.
//
// STRICTNESS RULE: Entra serializes manifest-declared optional claims as
// JSON strings on some tenants, so `xms_edov` can arrive as the STRING
// "false" — and Boolean("false") is true. Every verification claim goes
// through the module's strictClaimTrue(), which accepts ONLY boolean true or
// the exact string "true". It is re-exported here because this file is where
// scripts/roadmap-tests.ts pins that rule.
//
// Signature verification of the id_token is deliberately skipped and
// documented in the module's decoder: the token arrives directly from the
// provider's token endpoint over TLS in a confidential-client exchange (OIDC
// Core §3.1.3.7 permits TLS channel validation in exactly this flow), so a
// JWKS round-trip would add a failure mode without adding trust. aud/iss/exp
// are still validated, by decodeGoogleIdToken/decodeMicrosoftIdToken.

import { cookies } from "next/headers";
import {
  consumeOAuthRedirect,
  consumeOAuthState,
  insertAuthLog,
  isEmailArchived,
  RejectedError,
  upsertUser,
  validateRedirect,
} from "@aicompany/core/auth/helpers";
import { archivedLoginMessage } from "@aicompany/core/auth/login-errors";
import {
  consumeOAuthConfirmation,
  decodeGoogleIdToken,
  decodeMicrosoftIdToken,
  gateOAuthIdentity,
  googleVouch,
  isOAuthConfirmRequest,
  microsoftPinnedTenant,
  microsoftVouch,
  trustedMicrosoftTenants,
  type GoogleIdClaims,
  type MicrosoftIdClaims,
  type OAuthVouch,
} from "@aicompany/core/auth/oauth-identity";
import { signSession } from "@aicompany/core/auth/session";
import { logStage } from "@aicompany/core/lib/log";
import type { SiteConfig } from "@aicompany/core/config/types";
import {
  REVERIFY_COOKIE,
  REVERIFY_STATE_COOKIE,
  reverifyBinding,
} from "@/lib/auth/reverify";

/** ONLY boolean true or the exact string "true" count as verified. The
 * module's implementation, re-exported: one rule, and the pins in
 * scripts/roadmap-tests.ts keep watching the door they were written for. */
export { strictClaimTrue } from "@aicompany/core/auth/oauth-identity";

type TokenSet = { accessToken: string; idToken: string | null };

async function exchangeGoogle(
  config: SiteConfig,
  code: string
): Promise<TokenSet | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri:
        process.env.GOOGLE_REDIRECT_URI ||
        `${config.site.baseUrl}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as {
    access_token?: string;
    id_token?: string;
  };
  if (!tokens.access_token) return null;
  return { accessToken: tokens.access_token, idToken: tokens.id_token ?? null };
}

async function exchangeMicrosoft(
  config: SiteConfig,
  code: string
): Promise<TokenSet | null> {
  const tenant = process.env.MICROSOFT_TENANT_ID || "common";
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID || "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
        redirect_uri:
          process.env.MICROSOFT_REDIRECT_URI ||
          `${config.site.baseUrl}/auth/microsoft/callback`,
        grant_type: "authorization_code",
      }),
    }
  );
  if (!res.ok) return null;
  const tokens = (await res.json()) as {
    access_token?: string;
    id_token?: string;
  };
  if (!tokens.access_token) return null;
  return { accessToken: tokens.access_token, idToken: tokens.id_token ?? null };
}

/**
 * `mv` for the Google lane: did GOOGLE prove this address? The module's
 * googleVouch answers "provider" only when the id token's own email claim IS
 * the address we are about to sign in, `email_verified` is strictly true, and
 * Google actually runs that mailbox (@gmail.com / @googlemail.com) or `hd`
 * names the Workspace domain the address sits in. That is stricter than the
 * pre-v1.137 rule here, which trusted `email_verified` alone on any domain;
 * Google says of such addresses that it "initially verified the user when the
 * Google account was created, however ownership of the third party email
 * account may have since changed", which is not a verdict about who reads the
 * mailbox today. Those people now prove the address once by email instead,
 * and the binding is what admits them (isTrustedSession, roadmap/access.ts).
 */
export function googleVerdict(args: {
  claims: GoogleIdClaims | null;
  email: string | null;
}): boolean {
  if (!args.claims || !args.email) return false;
  return googleVouch({ claims: args.claims, email: args.email }) === "provider";
}

/**
 * `mv` for the Microsoft lane: did MICROSOFT prove this address? Unchanged
 * rule, now expressed through the module's microsoftVouch with NO operator
 * trust passed in, which is exactly the old microsoftVerdict: `xms_edov`
 * strictly true AND the id token's own `email` claim equal (case-insensitively)
 * to the address the session will carry. aud / iss / exp / GUID checks already
 * happened in decodeMicrosoftIdToken, which is the only way to obtain claims.
 *
 * The empty `trusted` map and null `pinnedTenant` are the point, not an
 * omission: microsoftVouch answers "trusted-tenant" for the OPERATOR's word
 * about a directory, and that word binds an identity without a confirmation
 * email but must never mint `mv`, which /rfp reads as "the provider proved
 * the domain" (src/lib/rfp/access.ts header).
 */
export function microsoftVerdict(args: {
  claims: MicrosoftIdClaims | null;
  email: string | null;
}): boolean {
  if (!args.claims || !args.email) return false;
  return (
    microsoftVouch({
      claims: args.claims,
      email: args.email,
      trusted: {},
      pinnedTenant: null,
    }) === "provider"
  );
}

function sessionCookieOptions(config: SiteConfig) {
  // Replicates the module's private cookieOptions() — the price of signing a
  // session with a per-login claim the module's setSessionCookie cannot
  // carry (its extras hook sees only the users row).
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: config.auth.sessionTtlDays * 24 * 60 * 60,
  };
}

/** Inline replica of the module's private loginErrorRedirect, reusing its
 * error-code vocabulary so the login page's error map needs no changes. */
function loginErrorRedirect(config: SiteConfig, code: string): Response {
  return Response.redirect(
    new URL(`/login?error=${code}`, config.site.baseUrl),
    302
  );
}

export function createHardenedCallbackHandler(
  config: SiteConfig,
  provider: "google" | "microsoft"
): (req: Request) => Promise<Response> {
  const slug = config.site.slug;
  return async (req: Request): Promise<Response> => {
    const fail = (code: string): Response => {
      logStage({
        slug,
        channel: "auth",
        stage: "dropped",
        ok: false,
        detail: `${provider} hardened callback: ${code}`,
      });
      return loginErrorRedirect(config, code);
    };

    logStage({
      slug,
      channel: "auth",
      stage: "inbound",
      ok: true,
      detail: `${provider} callback`,
    });

    const params = new URL(req.url).searchParams;
    const jar = await cookies();
    const configured =
      provider === "google"
        ? Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
        : Boolean(
            process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
          );

    // §5.5 v1.137 THE ONE PLACE A SESSION IS MINTED. Both entries below reach
    // it, so classifyUser, upsertUser, auth_logs, `mv` and the emailProof
    // claim cannot drift apart between the provider round trip and the
    // emailed confirmation link. Callers run the refusals first and only call
    // this once the address is theirs to sign in.
    const completeSignIn = async (args: {
      /** Already lowercased. */
      email: string;
      displayName: string | null;
      /** Did the PROVIDER prove the address? See googleVerdict/microsoftVerdict. */
      mv: boolean;
    }) => {
      const profile = {
        email: args.email,
        displayName: args.displayName,
        provider,
      };
      const extra = (await config.auth.classifyUser?.(profile)) ?? {};
      const user = await upsertUser(config, profile, extra);
      await insertAuthLog(config, {
        userId: user.id,
        email: args.email,
        provider,
        req,
        success: true,
      });

      // The one deviation from the module pipeline: sign the session
      // ourselves so the per-login `mv` claim rides under the HMAC.
      // emailProof is a RESERVED claim exactly as it is in the module's
      // setSessionCookie — stripped from the host extras and spread last, so
      // a sessionExtras hook can neither forge it nor drop it.
      const { emailProof: _reserved, ...extras } =
        (await config.auth.sessionExtras?.(user)) ?? ({} as Record<string, unknown>);
      void _reserved;
      const token = signSession(config, {
        ...extras,
        userId: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
        provider: user.authProvider,
        ...(args.mv ? { mv: true } : {}),
        emailProof: "oauth-binding" as const,
      });
      jar.set(config.auth.sessionCookieName, token, sessionCookieOptions(config));
      return user;
    };

    // ── ENTRY A: the emailed confirmation link (`?confirm=`) ───────────────
    // It lands on THIS path on purpose: reusing the registered callback URL
    // means no new route, no middleware matcher and no CSRF-list entry, and
    // the link arrives at the origin that holds the nonce cookie. Decided
    // before anything else, because it carries no `code`/`state` and would
    // otherwise be refused as missing_params. A request shaped like both a
    // link and a provider round trip is neither.
    if (params.has("confirm")) {
      if (!isOAuthConfirmRequest(req)) return fail("missing_params");
      if (!configured) return fail("provider_unconfigured");
      // Runs the token/nonce match, the single-use consume, rejectEmail and
      // the archived check ITSELF (fail-closed), and writes the binding. A
      // missing or wrong nonce cookie leaves the link ALIVE and binds
      // nothing, so a mail scanner's pre-fetch and a click in the wrong
      // browser both cost the person only a second attempt.
      const confirmed = await consumeOAuthConfirmation(config, provider, req);
      if (confirmed.kind === "refused") return confirmed.response;
      try {
        // mv: false. The emailed link proves the MAILBOX, which is what
        // isTrustedSession now asks for (sessionProvesMailbox); it is not the
        // provider's word about the address, which is what `mv` means and
        // what /rfp's staff gate reads. Widening `mv` here would quietly
        // widen that gate.
        const user = await completeSignIn({
          email: confirmed.email,
          displayName: confirmed.displayName,
          mv: false,
        });
        // A deliberate sign-in supersedes any pending silent round trip, so
        // the guard goes (same rule as the interactive branch below); the hub
        // can arm a fresh one later if it ever needs to.
        if (jar.get(REVERIFY_COOKIE)?.value !== undefined) {
          jar.delete(REVERIFY_COOKIE);
          jar.delete(REVERIFY_STATE_COOKIE);
        }
        // The stored target is RAW, exactly as requested before the hold, and
        // is validated here rather than trusted as stored.
        const requested = confirmed.redirect
          ? validateRedirect(config, confirmed.redirect)
          : null;
        const redirect =
          config.auth.postLoginRedirect?.(user, requested) ?? requested ?? "/";
        logStage({
          slug,
          channel: "auth",
          stage: "reply_sent",
          ok: true,
          detail: `${provider} sign-in (confirmed by email, mv=false)`,
        });
        return Response.redirect(new URL(redirect, config.site.baseUrl), 302);
      } catch (err) {
        const reason =
          err instanceof RejectedError ? err.reason : "sign-in completion failed";
        await insertAuthLog(config, {
          userId: null,
          email: confirmed.email,
          provider,
          req,
          success: false,
          failureReason: reason,
        });
        return fail("rejected");
      }
    }

    // ── ENTRY B: the provider round trip (`?code=&state=`) ─────────────────
    // §5.18 silent re-verify (aix_rv present = a silent round-trip is in
    // flight for an EXISTING session). aix_rv_state pins WHICH round-trip:
    // the cookie is path=/ for 10 minutes, so without it an interactive
    // sign-in landing here while it is set would be judged by the binding
    // below too (parity round 2026-08-09; see src/lib/auth/reverify.ts).
    const rvCookie = jar.get(REVERIFY_COOKIE)?.value ?? null;
    const rvState = jar.get(REVERIFY_STATE_COOKIE)?.value ?? null;
    // "/" is validateRedirect's rejection sentinel, not a destination in this
    // lane: the whole point is landing back where verification began.
    const validatedTarget = (raw: string | null): string => {
      const validated = raw ? validateRedirect(config, raw) : "/roadmap";
      return validated === "/" ? "/roadmap" : validated;
    };
    const containedTarget = async (): Promise<string> =>
      validatedTarget(await consumeOAuthRedirect(config));
    // CONTAINED ERROR BRANCH - scoped to exactly the prompt=none failure
    // shape (an error param while the guard cookie is set). Both authorities
    // answer login_required / interaction_required (Entra also
    // consent_required) when they cannot proceed invisibly; bouncing that to /login?error would strand a SIGNED-IN
    // user on the login page, which is the reported bug. Every OTHER
    // failure (invalid_state, exchange, userinfo) keeps today's
    // /login?error path: invalid_state is the CSRF control's signal and
    // must stay user-visible.
    if (rvCookie !== null && params.get("error")) {
      logStage({
        slug,
        channel: "auth",
        stage: "dropped",
        ok: false,
        detail: `${provider} silent reverify declined: ${params.get("error")?.slice(0, 40)}`,
      });
      // Keep aix_rv: it is the loop guard; the hub now renders the
      // verification screen instead of redirecting again.
      return Response.redirect(
        new URL(await containedTarget(), config.site.baseUrl),
        302
      );
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return fail("missing_params");
    if (!(await consumeOAuthState(config, state))) return fail("invalid_state");
    if (!configured) return fail("provider_unconfigured");

    const tokens = await (provider === "google"
      ? exchangeGoogle(config, code)
      : exchangeMicrosoft(config, code)
    ).catch(() => null);
    if (!tokens) return fail("token_exchange");

    // Profile fetch: SAME email source and precedence as the module (email
    // continuity; see header). What is NEW is the SUBJECT — the provider's own
    // immutable account id, read from the ID TOKEN only. No id token, or one
    // that fails aud / exp / iss (and for Microsoft the GUID shapes), means
    // there is nothing to bind and the sign-in fails "userinfo", exactly as
    // the module's own providers do.
    let email: string | null = null;
    let displayName: string | null = null;
    let subject: string | null = null;
    let vouch: OAuthVouch | null = null;
    let mv = false;
    if (provider === "google") {
      const claims = tokens.idToken
        ? decodeGoogleIdToken(tokens.idToken, {
            clientId: process.env.GOOGLE_CLIENT_ID || "",
          })
        : null;
      if (!claims) return fail("userinfo");
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }).catch(() => null);
      if (!res || !res.ok) return fail("userinfo");
      const info = (await res.json()) as {
        sub?: unknown;
        email?: string;
        name?: string;
      };
      // OIDC Core 5.3.4: the userinfo `sub` MUST match the id token's. The
      // address below comes from userinfo and the subject from the id token,
      // so this is what ties the two to ONE account. Absent counts as different.
      if (typeof info.sub !== "string" || info.sub !== claims.sub) {
        return fail("userinfo");
      }
      email = info.email || null;
      displayName = info.name || null;
      subject = claims.sub;
      vouch = email ? googleVouch({ claims, email }) : null;
      mv = googleVerdict({ claims, email });
    } else {
      const claims = tokens.idToken
        ? decodeMicrosoftIdToken(tokens.idToken, {
            clientId: process.env.MICROSOFT_CLIENT_ID || "",
          })
        : null;
      if (!claims) return fail("userinfo");
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }).catch(() => null);
      if (!res || !res.ok) return fail("userinfo");
      const info = (await res.json()) as {
        mail?: string | null;
        userPrincipalName?: string | null;
        displayName?: string | null;
      };
      email = info.mail || info.userPrincipalName || null;
      displayName = info.displayName || null;
      // Graph `id` is deliberately NOT compared with `oid`: for personal
      // Microsoft accounts they are not documented to be equal, and that
      // check would lock every outlook.com user out (module v1.137 note).
      subject = `${claims.tid}:${claims.oid}`;
      vouch = email
        ? microsoftVouch({
            claims,
            email,
            trusted: trustedMicrosoftTenants(config),
            pinnedTenant: microsoftPinnedTenant(),
          })
        : null;
      mv = microsoftVerdict({ claims, email });
    }
    if (!email) return fail("no_email");
    if (!subject) return fail("userinfo");

    // §5.18 IDENTITY BINDING: a silent-reverify round-trip may only refresh
    // the session it was started for. login_hint is non-binding in OIDC, so
    // a browser signed into a DIFFERENT account at the same provider would
    // otherwise get that account silently swapped into this session with
    // zero UI. On
    // mismatch: no upsert, no cookie write - the existing session stays -
    // and the user lands on the verification screen (aix_rv retained stops
    // the redirect loop).
    // Applies ONLY to the silent round-trip aix_rv_state names. A
    // user-initiated sign-in (different state, or no state cookie) proceeds
    // normally: it is deliberate, has full UI, and discarding it silently
    // was the reported dead end.
    const isSilentRoundTrip = rvCookie !== null && rvState === state;
    if (isSilentRoundTrip && reverifyBinding(email) !== rvCookie) {
      logStage({
        slug,
        channel: "auth",
        stage: "dropped",
        ok: false,
        detail: `${provider} silent reverify account mismatch; session untouched`,
      });
      await insertAuthLog(config, {
        userId: null,
        email,
        provider,
        req,
        success: false,
        failureReason: "silent reverify account mismatch",
      });
      return Response.redirect(
        new URL(await containedTarget(), config.site.baseUrl),
        302
      );
    }

    try {
      const lowered = email.toLowerCase();
      // §5.5 v1.74 ARCHIVED ACCOUNTS — the module's handleOAuthUser() refusal
      // never runs on this site (see PIPELINE-PARITY RULE in the header), so
      // without this an archived operator-blocked account would get a SUCCESS
      // auth_log, a refreshed last_login_at, and a signed session cookie.
      // Placed before rejectEmail and before any write, and returned rather
      // than thrown so it keeps its own error code instead of collapsing into
      // the catch's generic "rejected". FAILS CLOSED: a throwing query lands
      // in the catch below (auth_logs failure + /login?error=rejected) — a
      // revocation control must not open on a DB blip. It is ALSO the gate's
      // documented precondition: a rejected or archived address must never be
      // sent a confirmation email.
      if (await isEmailArchived(lowered)) {
        await insertAuthLog(config, {
          userId: null,
          email: lowered,
          provider,
          req,
          success: false,
          failureReason: "archived",
        });
        logStage({
          slug,
          channel: "auth",
          stage: "dropped",
          ok: false,
          detail: `${provider} hardened callback: account_archived`,
        });
        return Response.redirect(
          new URL(
            `/login?error=account_archived&message=${encodeURIComponent(
              archivedLoginMessage(config)
            )}`,
            config.site.baseUrl
          ),
          302
        );
      }
      const reason = await config.auth.rejectEmail?.(lowered);
      if (reason) throw new RejectedError(reason);

      // The post-login target is consumed HERE, before the gate, because a
      // HOLD has to carry it across the trip to the inbox (the cookie is
      // single-use; the gate stores the raw value and it is re-validated when
      // the link is used).
      const requestedRaw = await consumeOAuthRedirect(config);

      // §5.5 v1.137 THE BINDING GATE. `bound` = this provider account has
      // proved this address (an existing live binding, or a vouch strong
      // enough to write one now). `held` = it has not: the module has already
      // mailed the one-time link (or refused to), written the auth_logs row
      // and built the /login redirect, and NO session cookie was set — an
      // existing one is left exactly as it was. There is no third answer and
      // no fallback to trusting the email; the gate never throws.
      const gate = await gateOAuthIdentity(config, {
        provider,
        subject,
        email: lowered,
        displayName,
        vouch,
        req,
        redirect: requestedRaw,
        // §5.18: a prompt=none round trip has no UI, so it must never mail
        // anybody. silent:true makes the gate decide WITHOUT doing anything
        // durable — no confirmation row, no mail, no rate-limit spend, no
        // auth_logs row — and its `held` response is discarded below.
        silent: isSilentRoundTrip,
      });
      if (gate.kind === "held") {
        if (isSilentRoundTrip) {
          // Re-verify FAILED, treated exactly as a silent round trip that came
          // back without mv: the existing session is untouched, the aix_rv
          // guard is KEPT so the hub renders the verification screen instead
          // of bouncing again, and the person lands back where they started.
          // The gate sent no mail and wrote no row, so this is the only trace.
          logStage({
            slug,
            channel: "auth",
            stage: "dropped",
            ok: false,
            detail: `${provider} silent reverify: no binding for this account; session untouched`,
          });
          await insertAuthLog(config, {
            userId: null,
            email: lowered,
            provider,
            req,
            success: false,
            failureReason: "silent reverify unbound account",
          });
          return Response.redirect(
            new URL(validatedTarget(requestedRaw), config.site.baseUrl),
            302
          );
        }
        return gate.response;
      }

      const user = await completeSignIn({
        email: lowered,
        displayName,
        mv,
      });

      const requested = requestedRaw
        ? validateRedirect(config, requestedRaw)
        : null;
      let redirect =
        config.auth.postLoginRedirect?.(user, requested) ?? requested ?? "/";
      // §5.18 reverify lifecycle: delete the guard ONLY when mv was actually
      // minted (success-without-mv must not re-arm the auto-redirect - that
      // would loop full OAuth rounds); on success-without-mv, flag the
      // return so the verification screen can say what happened instead of
      // silently re-rendering itself after a manual attempt.
      if (rvCookie !== null && !isSilentRoundTrip) {
        // An interactive login superseded the pending silent round-trip:
        // drop the guard entirely so the hub can arm a fresh one later.
        jar.delete(REVERIFY_COOKIE);
        jar.delete(REVERIFY_STATE_COOKIE);
      } else if (rvCookie !== null) {
        if (mv) {
          jar.delete(REVERIFY_COOKIE);
          jar.delete(REVERIFY_STATE_COOKIE);
        } else if (redirect.startsWith("/") && !redirect.includes("verify=")) {
          redirect += `${redirect.includes("?") ? "&" : "?"}verify=${provider}_unverified`;
        }
      }
      logStage({
        slug,
        channel: "auth",
        stage: "reply_sent",
        ok: true,
        detail: `${provider} sign-in (bound ${gate.via}, mv=${mv})`,
      });
      return Response.redirect(new URL(redirect, config.site.baseUrl), 302);
    } catch (err) {
      const reason =
        err instanceof RejectedError ? err.reason : "sign-in completion failed";
      await insertAuthLog(config, {
        userId: null,
        email,
        provider,
        req,
        success: false,
        failureReason: reason,
      });
      return fail("rejected");
    }
  };
}
