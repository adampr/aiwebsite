import type { Metadata } from "next";
import Link from "next/link";
import { EmailLink } from "@/components/email-link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How XL.net AI collects, uses, and protects your data across the site, chat, SMS, email, and voice channels.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-12">
      <section className="pt-8">
        <span className="sys-label">Home / Privacy</span>
        <h1 className="mt-8">Privacy Policy</h1>
        <p className="mt-4 text-sm">Last updated: July 2026</p>
        <p className="mt-6">
          This policy covers <strong>ai.xl.net</strong>, operated by XL.net,
          and every channel on which you can reach Tron Netter, our AI agent —
          web chat, SMS, email, and voice.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Information Gathered from Visitors</h2>
        <p>
          In common with other websites, our infrastructure stores log files
          containing the visitor&apos;s IP address, browser type, referring
          page, pages visited, and time of visit. These logs are used solely
          for security monitoring and traffic analysis.
        </p>
        <p>
          We do not use any third-party analytics service, advertising network,
          or social-media tracker. All visit measurement described below is
          first-party and stays on our own server.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Tracking, Profiling &amp; Automated Identification</h2>
        <p>
          We believe transparency beats fine print, so here is everything this
          site does to understand its visitors — including the parts most sites
          leave out:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>First-party page tracking:</strong> our own server records
            each page view with the path, referring page, IP address, browser
            user agent, and any campaign (UTM) parameters. This powers our
            traffic dashboards and abuse prevention. It never leaves our
            server.
          </li>
          <li>
            <strong>Company (not person) identification:</strong> we look up
            visitor IP addresses against a locally stored MaxMind GeoLite2
            database to identify the <em>organization or network</em> a visit
            came from (for example, &ldquo;a visitor from Acme Corp&apos;s
            network&rdquo;). This lookup happens on our own server, identifies
            companies rather than individuals, and no data is sent to MaxMind
            or anyone else.
          </li>
          <li>
            <strong>Repeat-visit linking:</strong> we compute a short hash of
            IP address + browser user agent to connect a day&apos;s repeat
            visits into one anonymous session. This record contains no name or
            email unless you later identify yourself (for example by signing
            in), at which point your visits may be linked to your contact
            record.
          </li>
          <li>
            <strong>AI agent processing:</strong> conversations with Tron
            Netter — web chat, SMS, email, or phone — are processed by our AI
            systems and stored, including call transcripts, so the agent can
            answer you and we can review quality. Tron Netter has no internet
            access and no tools on public channels, and is instructed not to
            retain personal details as long-term memory.
          </li>
          <li>
            <strong>Human oversight of AI email:</strong> every email Tron
            Netter sends is copied to a human at XL.net so that an
            unsupervised AI is never our only record of what was said.
          </li>
        </ul>
        <p>
          To object to any of this processing or have your visit and contact
          records purged, email{" "}
          <EmailLink email="ai@xl.net" />. Retention windows are
          listed under Data Retention below.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Account Data</h2>
        <p>
          If you sign in, we store your email address and display name
          (provided via Google OAuth or Microsoft OAuth). This information is
          used only to authenticate you and personalize your experience. We
          never post on your behalf or access anything else in your Google or
          Microsoft account.
        </p>
        <p>
          If you register a mobile number for text messaging, we also store
          that number, the date you verified it, and your opt-in consent
          record (see SMS / Text Messaging Data below).
        </p>
      </section>

      <section className="space-y-3">
        <h2>How We Use Your Data</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>To answer you on whichever channel you contacted us</li>
          <li>To authenticate you and keep you signed in</li>
          <li>To detect and prevent abuse (rate limiting, fraud prevention)</li>
          <li>To understand which content is useful (aggregate, first-party analytics)</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2>What We Do NOT Do</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>We do not sell your data to anyone</li>
          <li>We do not use your data for advertising</li>
          <li>We do not use third-party analytics or tracking cookies</li>
          <li>We do not serve third-party advertisements</li>
          <li>
            We do not use your data to train AI foundation models. Tron Netter
            processes and stores your conversations to answer you (see
            Tracking above), but your data is never sold to, or used to train,
            third-party models.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2>Cookies</h2>
        <p>
          <strong>Essential cookies only.</strong> We set a single httpOnly
          session cookie (<code>aix_session</code>, 30 days) when you sign in,
          plus short-lived (10-minute) cookies during the OAuth sign-in
          handshake. Your theme preference is kept in your browser&apos;s
          localStorage and the chat widget&apos;s conversation state in
          sessionStorage; neither is sent to any third party.
        </p>
        <p>
          Because we set no analytics or advertising cookies, there is no
          cookie consent banner — there is nothing to consent to. Blocking all
          cookies in your browser will prevent you from signing in but does
          not affect the rest of the site.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Third Parties</h2>
        <p>We share data only with services necessary to operate the site:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>Google OAuth / Microsoft OAuth:</strong> authentication
            only
          </li>
          <li>
            <strong>Resend:</strong> email delivery and receiving for
            Tron.Netter@ai.xl.net
          </li>
          <li>
            <strong>Twilio:</strong> SMS and voice-call transport (phone
            numbers and message/call content, as required to deliver the
            service)
          </li>
          <li>
            <strong>Cloudflare:</strong> DNS and secure tunnel (no personal
            data stored)
          </li>
          <li>
            <strong>AI model providers (OpenAI, xAI, and others):</strong>{" "}
            when you interact with Tron Netter by web chat, SMS, email, or
            phone, your conversation content (including call transcripts) is
            sent to one or more of these providers via their APIs solely to
            generate the response. We use API terms under which providers do
            not use this content to train their models.
          </li>
        </ul>
        <p>
          None of these providers receive your data for their own marketing
          purposes.
        </p>
      </section>

      <section className="space-y-3">
        <h2>SMS / Text Messaging Data</h2>
        <p>
          If you communicate with us via SMS or text message, your mobile phone
          number and message contents are used solely to respond to your
          inquiry. Your mobile information will not be sold, rented, or shared
          with third parties or affiliates for their own marketing purposes.
          Mobile opt-in data and consent are not shared with any third parties
          except service providers that help us operate our messaging program,
          and those providers are restricted from using your information for
          any other purpose.
        </p>
        <p>
          If you register your number on our{" "}
          <Link href="/texting">texting page</Link>, we record your opt-in
          consent (the consent language you agreed to, your IP address, and
          browser) and verify the number with a one-time code before it is
          added to your account. Message frequency varies based on your
          interactions with us. Message and data rates may apply. Text STOP to
          opt out at any time.
        </p>
        <p>
          For full details on our text messaging program, see our{" "}
          <Link href="/sms-terms">SMS Terms &amp; Conditions</Link>.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Visitor Options</h2>
        <p>
          You may request deletion of your account and all associated data at
          any time by emailing <EmailLink email="ai@xl.net" />.
        </p>
        <p>
          You may block cookies via your browser settings, though this will
          prevent you from signing in. You may opt out of SMS messages at any
          time by texting STOP.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Data Retention &amp; Deletion</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>Account data: as long as your account exists</li>
          <li>Sign-in logs: up to 12 months</li>
          <li>Page-view and IP-to-organization records: up to 24 months</li>
          <li>
            Conversation history and call transcripts: up to 24 months, unless
            you ask us to delete them sooner
          </li>
          <li>Unverified phone-verification codes: 10 minutes</li>
          <li>
            SMS consent records: for the life of the messaging program plus
            four years, as required for compliance
          </li>
        </ul>
        <p>
          Upon a deletion request, all associated personal data is permanently
          removed within 30 days, except records we are legally required to
          keep (such as SMS consent logs).
        </p>
      </section>

      <section className="space-y-3">
        <h2>Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. Changes are
          effective when posted to this page, and the &ldquo;Last
          updated&rdquo; date above reflects the most recent revision. Your
          continued use of the site after changes are posted constitutes
          acceptance of the updated policy.
        </p>
      </section>

      <section className="space-y-3">
        <h2>Contact</h2>
        <p>
          For privacy questions or data requests: <EmailLink email="ai@xl.net" />
        </p>
      </section>
    </div>
  );
}
