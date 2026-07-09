// Shared pieces of the /texting phone-verification flow. The consent text
// lives here so the string the UI shows and the string logged to
// sms_consent_logs are provably identical (TCPA proof-of-consent).

export const SMS_CONSENT_TEXT =
  "I agree to receive recurring AI assistant text messages from XL.net AI " +
  "(Tron Netter) at the phone number provided. Message frequency varies. " +
  "Message and data rates may apply. Reply STOP to unsubscribe, HELP for help. " +
  "Consent is not a condition of purchase.";

export const VERIFICATION_CODE_TTL_MIN = 10;
export const VERIFICATION_MAX_ATTEMPTS = 5;

// US/Canada numbers only (the Twilio number is US). Accepts common
// formatting; returns E.164 (+1XXXXXXXXXX) or null.
export function normalizeUsPhone(input: string): string | null {
  let digits = (input || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // NANP: area code and exchange can't start with 0 or 1.
  if (/[01]/.test(digits[0]) || /[01]/.test(digits[3])) return null;
  return `+1${digits}`;
}
