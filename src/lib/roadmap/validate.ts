// Shared request-field validation for the roadmap portal (§5.18).

export function parsePersonFields(body: Record<string, unknown>):
  | {
      ok: true;
      name: string;
      email: string | null;
      phone: string | null;
    }
  | { ok: false; message: string } {
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (name.length < 2) return { ok: false, message: "Give the person a name." };
  const emailRaw =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw))
    return { ok: false, message: "That email address does not look right." };
  const phoneRaw =
    typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  if (phoneRaw && !/^[0-9+()\-. ext]+$/i.test(phoneRaw))
    return { ok: false, message: "That phone number does not look right." };
  return {
    ok: true,
    name,
    email: emailRaw || null,
    phone: phoneRaw || null,
  };
}
