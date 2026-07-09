import type { Metadata } from "next";
import Link from "next/link";
import { EmailLink } from "@/components/email-link";

export const metadata: Metadata = {
  title: "SMS Terms & Conditions",
  description:
    "Terms and conditions for XL.net AI's text messaging program with Tron Netter.",
  alternates: { canonical: "/sms-terms" },
};

export default function SmsTermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-12">
      <section className="pt-8">
        <span className="sys-label">Home / SMS Terms</span>
        <h1 className="mt-8">SMS Terms &amp; Conditions</h1>
        <p className="mt-4 text-sm">Last updated: July 2026</p>
        <p className="mt-6">
          These SMS Terms &amp; Conditions (&ldquo;Terms&rdquo;) govern your
          participation in XL.net AI&apos;s text messaging (SMS/MMS) program
          (the &ldquo;Program&rdquo;). By providing your mobile phone number
          and opting in, you agree to these Terms. If you do not agree, do not
          opt in to the Program.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Program Description</h2>
        <p>
          XL.net uses SMS/MMS text messaging on this site to communicate with
          visitors and users through Tron Netter, our AI agent, at{" "}
          <a href="tel:+18723504325" className="mono">
            (872) 350-4325
          </a>
          . Depending on how you interact with us, messages may include:
          conversational replies from Tron Netter, one-time phone verification
          codes when you register your number, an opt-in confirmation message,
          and informational messages about XL.net&apos;s AI and managed IT
          services.
        </p>
        <p>
          We do not send promotional or marketing text messages. All SMS
          communication is initiated by or in direct response to your inquiry
          or registration.
        </p>
      </section>

      <section className="space-y-3">
        <h2>How You Opt In</h2>
        <p>
          You may consent to receive text messages from XL.net AI in several
          ways, including:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            Registering your mobile number on our{" "}
            <Link href="/texting">texting page</Link>, checking the consent
            box, and confirming the one-time verification code we text you
          </li>
          <li>
            Calling or texting our phone number and agreeing to be contacted
          </li>
          <li>Texting a keyword such as START to our messaging number</li>
        </ul>
        <p>
          Your consent to receive texts is not a condition of purchasing any
          goods or services.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Phone Number Verification</h2>
        <p>
          When you register a number through our website, we text a one-time
          6-digit code to that number. The number is added to your account
          only after you enter the matching code on the site. Codes expire
          after 10 minutes; verification messages are one-time and do not by
          themselves subscribe you to anything beyond completing your
          registration.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Message Frequency</h2>
        <p>
          Message frequency varies based on your interactions with us. For
          example, replies from Tron Netter are sent in response to your
          questions. You may receive recurring messages if you continue to
          engage with the service.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Message and Data Rates</h2>
        <p>
          Message and data rates may apply to any messages you send to us or
          receive from us, according to the terms of your wireless plan.
          Please contact your wireless provider for details about your plan.
          XL.net is not responsible for any charges imposed by your carrier.
        </p>
      </section>

      <section className="space-y-3">
        <h2>How to Opt Out</h2>
        <p>
          You can cancel the Program at any time by texting{" "}
          <strong>STOP</strong> to the number from which you received
          messages. After you send STOP, we will send a one-time confirmation
          message and then stop sending text messages. If you opt out, you may
          no longer receive text-based replies and may need to use another
          channel (email, web chat, phone) to contact us.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Help and Support</h2>
        <p>
          If you experience any issues with the Program or need assistance,
          text <strong>HELP</strong> to the number from which you received
          messages, email{" "}
          <EmailLink email="Tron.Netter@ai.xl.net" />, or see the{" "}
          <Link href="/contact">contact page</Link>.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Carriers</h2>
        <p>
          XL.net AI&apos;s messaging may be supported by major U.S. wireless
          carriers. Carriers are not liable for delayed or undelivered
          messages. Delivery is subject to effective transmission by your
          wireless provider and is not guaranteed.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Privacy</h2>
        <p>
          Your mobile information will not be sold, rented, or shared with
          third parties for their own marketing purposes. Information
          collected through the Program is handled in accordance with our{" "}
          <Link href="/privacy">Privacy Policy</Link>. Mobile opt-in data and
          consent are not shared with any third parties except for service
          providers that help us operate the messaging Program, and those
          providers are restricted from using your information for any other
          purpose.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Changes to These Terms</h2>
        <p>
          We may update these Terms from time to time. Changes are effective
          when posted to this page, and the &ldquo;Last updated&rdquo; date
          above reflects the most recent revision. Your continued
          participation in the Program after changes are posted constitutes
          acceptance of the updated Terms.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Contact Us</h2>
        <p>XL.net — Chicago, IL</p>
        <p>
          Phone / Text:{" "}
          <a href="tel:+18723504325" className="mono">
            (872) 350-4325
          </a>
        </p>
        <p>
          Email: <EmailLink email="Tron.Netter@ai.xl.net" />
        </p>
        <p>
          Web: <Link href="/contact">ai.xl.net/contact</Link>
        </p>
      </section>
    </div>
  );
}
