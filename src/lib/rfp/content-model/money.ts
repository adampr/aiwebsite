/**
 * Money is integer cents, everywhere, with no exceptions.
 *
 * DOMAIN-RULES B3: a draft once quoted a blended "$275.20 per user" that came from dividing a
 * total by a headcount and printing the result. Float money makes that class of error harder to
 * see, not easier. Integer cents plus a formatter that never rounds silently makes it visible.
 */

export type Currency = "USD";

export type Money = { cents: number; currency: Currency };

export function usd(cents: number): Money {
  if (!Number.isInteger(cents)) {
    throw new Error(`Money must be integer cents, received ${cents}`);
  }
  return { cents, currency: "USD" };
}

/** Convenience for authoring seed data and fixtures from dollar figures. */
export function dollars(amount: number): Money {
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    throw new Error(`Dollar amount ${amount} does not convert cleanly to integer cents`);
  }
  return usd(cents);
}

export function addMoney(...values: Money[]): Money {
  return usd(values.reduce((sum, v) => sum + v.cents, 0));
}

export function multiplyMoney(value: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new Error(`Quantity must be an integer, received ${quantity}`);
  }
  return usd(value.cents * quantity);
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.cents === b.cents && a.currency === b.currency;
}

export const ZERO: Money = { cents: 0, currency: "USD" };

/**
 * The only currency formatter in the system.
 *
 * DOMAIN-RULES B2 forbids "approximately $3,705", "about $3,705", "~$3,705" and "$3,700". The
 * figure is rendered exactly or not at all, so this formatter has no rounding or abbreviating
 * mode to reach for.
 */
export function formatMoney(value: Money, options: { cents?: "auto" | "always" | "never" } = {}): string {
  const mode = options.cents ?? "auto";
  const negative = value.cents < 0;
  const abs = Math.abs(value.cents);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;

  const showCents = mode === "always" || (mode === "auto" && fraction !== 0);
  const groupedWhole = whole.toLocaleString("en-US");
  const body = showCents ? `${groupedWhole}.${String(fraction).padStart(2, "0")}` : groupedWhole;

  return `${negative ? "-" : ""}$${body}`;
}
