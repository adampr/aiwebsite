// The ONE person-naming rule (owner ruling 2026-08-09): a rendered person
// label is either "First Last" or an email address, never a bare
// single-token first name. A stored name qualifies only when it has two or
// more whitespace-separated tokens after trim; otherwise the email wins; a
// bare single-token name renders only when there is no email at all (last
// resort, better than an empty cell). Pure, client-safe, no em dashes.
//
// Why stored names cannot be trusted here: work_submissions.submitter_name
// is BY DESIGN a validated single first name (the public-credit regex in
// the submissions route), and Apollo emits single-token names when a last
// name is unknown.
//
// DELIBERATE exclusions (do not route these through this rule):
//  - the public /work card credit and panel attribution: single first name
//    or team credit by privacy design; an email there would be a
//    disclosure regression on a public page;
//  - record views with separate Name and Email columns (directory table,
//    /admin/roadmap): those are fields, not labels;
//  - notify emails that render titles and addresses only.

export type PersonLabelKind = "name" | "email" | "bare";

export function personLabelParts(
  name: string | null | undefined,
  email: string | null | undefined
): { label: string; kind: PersonLabelKind } {
  const n = (name ?? "").trim();
  if (n.split(/\s+/).filter(Boolean).length >= 2)
    return { label: n, kind: "name" };
  const e = (email ?? "").trim();
  if (e) return { label: e, kind: "email" };
  return { label: n, kind: "bare" };
}

export function personLabel(
  name: string | null | undefined,
  email: string | null | undefined
): string {
  return personLabelParts(name, email).label;
}
