"use client";

// One POST helper for every requested-work action island (§5.19). Returns
// the server's error message (or null on success) so a refused action is
// always explained; a silent no-op button is worse than an error.

export async function postRequestAction(
  path: string,
  body?: Record<string, unknown>
): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return data?.error?.message ?? "That did not work. Try again.";
  } catch {
    return "Network problem. Try again.";
  }
}
