// AI Governance builder: blueprints, per-kind document scaffolds + interview
// question banks (ARCHITECTURE.md section 5.12).
//
// HOST-OWNED CONTENT. This file is the content backbone the drafting engine
// builds on: doc slugs are the op allowlist, section ids are the op targets,
// and the banks are the interview checklist.
//
// Two hard rules for every string in this file:
// 1. NO structural counts or application dates of the standards (write "the
//    prohibited practice categories of Article 5", never "the 8 categories";
//    "the Annex A controls", never a control count). The standards knowledge
//    in data/governance-standards/ refreshes quarterly; this code does not.
// 2. NO em dashes (U+2014), en dashes (U+2013), or curly quotes anywhere.
//    Use commas, colons, or "..." instead. ASCII only in string content.

import type { GovernanceDoc, GovernanceKind } from "./types";

export interface SectionOutline {
  id: string;
  title: string;
  placeholder: string;
}

export interface DocBlueprint {
  slug: string;
  title: string;
  stub?: boolean;
  sections: SectionOutline[];
}

export interface BankQuestion {
  id: string; // "UP-01" | "N-01" | "E-01" | "I-01" ...
  prompt: string; // the question the assistant asks, user-facing
  why: string; // one sentence: why this matters, user-facing
  feeds: string[]; // ["<doc-slug>#<section-id>", ...]
  suggestions?: string[]; // 0-4 short example-answer chips
  required: boolean; // false = conditional/branch question
  // Background-check questions ("did I get your company right?"): the
  // question card renders Tron's research snapshot as the object of review
  // and the ask-anchor choreography is suppressed. The flag is derived at
  // VIEW time from this declaration (never persisted on the stored
  // question), so it retrofits projects parked on an already-stored Q1.
  snapshot?: true;
}

export interface KindBlueprint {
  kind: GovernanceKind;
  title: string;
  docs: DocBlueprint[];
  bank: BankQuestion[]; // in ask order
}

// ---------------------------------------------------------------------------
// usage_policy: one document, eleven sections
// ---------------------------------------------------------------------------

const USAGE_POLICY: KindBlueprint = {
  kind: "usage_policy",
  title: "AI Acceptable Use Policy",
  docs: [
    {
      // Slug is stored in every existing project's documents_json and matched
      // by the op allowlist, feeds, and placeholderSectionMap: never rename.
      slug: "ai-usage-policy",
      title: "AI Acceptable Use Policy",
      sections: [
        {
          id: "purpose-scope",
          title: "Why this policy exists and who it covers",
          placeholder:
            "This section will explain why your company has an AI policy and who must follow it, based on your answers. It covers all AI tools used for work, including free and personal accounts.",
        },
        {
          id: "definitions",
          title: "Definitions",
          placeholder:
            "This section will define the handful of terms the rest of the policy leans on: AI tool, generative AI, approved account, and company data. Each definition will be one or two plain sentences keyed to how your business actually talks, so nobody can argue that a chatbot in a browser tab does not count.",
        },
        {
          id: "approved-tools",
          title: "Approved tools",
          placeholder:
            "This section will hold a three-tier table of AI tools: approved, conditionally approved, and not approved, with the account types allowed for each. It will also explain how to get a new tool approved, who owns that decision, and how fast they answer.",
        },
        {
          id: "data-rules",
          title: "What you may and may not share",
          placeholder:
            "This section will hold a traffic-light table for your data: GREEN is fine to share, YELLOW is approved tools only, and RED never goes into an AI tool without written approval. It will be keyed to the kinds of data your business actually handles, with concrete examples from your industry.",
        },
        {
          id: "checking-output",
          title: "Checking AI output",
          placeholder:
            "This section will set the rule that people own what they ship: verify facts, test code, and never send AI output to customers, regulators, or a court without human review. It will call out common failure modes such as fabricated citations.",
        },
        {
          id: "disclosure",
          title: "Disclosure: saying when AI helped",
          placeholder:
            "This section will explain when your people must say that AI helped produce something, and when no disclosure is needed. It will reflect any client contracts or regulations you tell us about.",
        },
        {
          id: "people-data",
          title: "Using AI with people data",
          placeholder:
            "This section will set the rules for using AI on data about employees, candidates, and customers. Uses that influence hiring, evaluation, or other decisions about people will need named approval, because that is where legal exposure concentrates.",
        },
        {
          id: "build-or-buy",
          title: "Building or buying AI",
          placeholder:
            "This section will route anyone who wants to add AI to a product, or buy an AI vendor tool, into your approval process. It states the shadow-AI rule kindly: do not roll your own AI setup on the side; ask first.",
        },
        {
          id: "incidents",
          title: "When something goes wrong",
          placeholder:
            "This section will explain what counts as an AI incident, where to report it, and the no-blame norm: report promptly and nothing bad happens to the reporter. It will name your reporting channel once you confirm it.",
        },
        {
          id: "training",
          title: "Training and questions",
          placeholder:
            "This section will describe the AI training people get and who to ask when they are unsure. The core habit it teaches: if in doubt, ask before pasting.",
        },
        {
          id: "violations-review",
          title: "Violations and review",
          placeholder:
            "This section will describe proportionate consequences for violations, name the policy owner, and set the review cadence. It ends with a version table so people can see what changed and when.",
        },
      ],
    },
  ],
  bank: [
    {
      id: "UP-01",
      prompt:
        "Before we draft anything: here is a quick check. Did I understand your company right, and what would you correct?",
      why: "The whole policy is keyed to who you are, so a wrong assumption here would ripple through every section.",
      feeds: ["ai-usage-policy#purpose-scope"],
      suggestions: [
        "Yes, that matches",
        "Close, but our industry is different",
        "We are bigger than you found",
      ],
      required: true,
      snapshot: true,
    },
    {
      id: "UP-02",
      prompt:
        "Who must follow this policy: employees only, or also contractors and vendors who touch your systems?",
      why: "Scope decides who you can hold to the rules and who needs to see them before they start work.",
      feeds: ["ai-usage-policy#purpose-scope"],
      suggestions: [
        "Employees only",
        "Employees and contractors",
        "Everyone with a company account",
      ],
      required: true,
    },
    {
      id: "UP-03",
      prompt:
        "Which AI tools are your people using today, officially or unofficially, and which do you want to approve, on company or personal accounts?",
      why: "The approved-tools table only protects you if it matches reality, including the unofficial tools.",
      feeds: ["ai-usage-policy#approved-tools"],
      suggestions: [
        "ChatGPT and Copilot, company accounts",
        "Claude for a few teams",
        "Not sure what people use unofficially",
      ],
      required: true,
    },
    {
      id: "UP-04",
      prompt:
        "Who should own requests to approve a new AI tool, and how quickly should they answer?",
      why: "A named owner and a deadline are what keep people from quietly using unapproved tools while they wait.",
      feeds: ["ai-usage-policy#approved-tools"],
      suggestions: [
        "IT lead, 10 business days",
        "Our security team",
        "No owner yet, suggest one",
      ],
      required: true,
    },
    {
      id: "UP-05",
      prompt:
        "What kinds of sensitive data does your business handle? Think customer PII, health or payment data, source code, financials, client-confidential material, trade secrets.",
      why: "The traffic-light table has to name your real data classes, or people will guess and guess wrong.",
      feeds: ["ai-usage-policy#data-rules"],
      suggestions: [
        "Customer PII and payment data",
        "Client-confidential files under NDA",
        "Source code and trade secrets",
      ],
      required: true,
    },
    {
      id: "UP-06",
      prompt:
        "Is there any data that must never touch an AI tool, no matter who approves?",
      why: "A short, absolute never list is the rule people remember under deadline pressure.",
      feeds: ["ai-usage-policy#data-rules"],
      suggestions: [
        "Credentials and keys",
        "Patient health records",
        "Nothing absolute, approvals suffice",
      ],
      required: true,
    },
    {
      id: "UP-07",
      prompt:
        "Do your people produce customer-facing content or code with AI help today?",
      why: "Whatever reaches a customer carries your name, so the review rules should match how AI is really used.",
      feeds: ["ai-usage-policy#checking-output", "ai-usage-policy#disclosure"],
      suggestions: ["Yes, marketing copy", "Yes, production code", "Not yet, but soon"],
      required: true,
    },
    {
      id: "UP-08",
      prompt:
        "Do any client contracts or regulators require you to disclose when AI was used?",
      why: "Disclosure duties usually hide in contracts, and it is cheaper to find them now than after a deliverable ships.",
      feeds: ["ai-usage-policy#disclosure"],
      suggestions: [
        "Yes, some client contracts do",
        "Not sure, need to check",
        "No such requirements",
      ],
      required: true,
    },
    {
      id: "UP-09",
      prompt:
        "Do you use, or plan to use, AI in hiring, performance reviews, or other decisions about people?",
      why: "Decisions about people are where AI rules are strictest, so this answer decides how strong the approval gate must be.",
      feeds: ["ai-usage-policy#people-data"],
      suggestions: ["Yes, resume screening", "Considering it", "No, and no plans"],
      required: true,
    },
    {
      id: "UP-10",
      prompt:
        "Where should someone report an AI mishap, and is that channel actually monitored?",
      why: "A reporting channel nobody watches is worse than none, because people assume they are covered.",
      feeds: ["ai-usage-policy#incidents"],
      suggestions: ["Email to IT", "A dedicated Slack channel", "We need to create one"],
      required: true,
    },
    {
      id: "UP-11",
      prompt:
        "Do you already run security or privacy training this policy can attach to?",
      why: "Attaching to an existing training cycle is the difference between a policy people read once and one they remember.",
      feeds: ["ai-usage-policy#training"],
      suggestions: [
        "Yes, annual security training",
        "Onboarding only",
        "No formal training yet",
      ],
      required: true,
    },
    {
      id: "UP-12",
      prompt:
        "Who owns this policy, and how often will you realistically review it?",
      why: "An owner and an honest cadence keep the policy alive after the launch email fades.",
      feeds: ["ai-usage-policy#violations-review"],
      suggestions: ["Our COO, annually", "IT lead, every six months", "Not decided yet"],
      required: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// ffiec_aup: seven documents, hub-and-spoke (Board hub + five amendments to
// the bank's EXISTING policies + living artifacts). Amendments cross-reference
// and never restate the target policy: duplicated policy text drifts, and
// drift between two Board documents is itself an exam finding. Per the
// file-header hard rules, NO numbered supervisory identifiers appear in these
// strings (no SR numbers, circular numbers, or booklet section numbers):
// this code does not refresh, the weekly-researched knowledge file in
// data/governance-standards/ffiec-ai.md does. Titles are drafting DEFAULTS
// (retitle_doc may adapt them, e.g. to starter-policy mode); slugs and
// section ids are frozen like every other kind's.
// ---------------------------------------------------------------------------

const FFIEC_AUP: KindBlueprint = {
  kind: "ffiec_aup",
  title: "Bank AI Acceptable Use Policy (FFIEC)",
  docs: [
    {
      slug: "bank-ai-use-policy",
      title: "AI Use Policy",
      sections: [
        {
          id: "purpose-scope",
          title: "Purpose, scope, and definitions",
          placeholder:
            "This section will state why the bank governs AI, who and what is covered (employees, contractors, vendor-embedded AI, and free or personal accounts), and define AI, generative AI, and model in terms an examiner will recognize. It will name your charter, primary federal regulator, and asset tier so the proportionality argument is on page one. Satisfies: the AI section of the FFIEC IT Handbook's operations booklet and safety and soundness expectations for a written, Board-approved policy.",
        },
        {
          id: "governance-accountability",
          title: "Governance and accountability",
          placeholder:
            "This section will name the Board's oversight role, the committee that owns AI (an existing risk or IT steering committee with an expanded charter is acceptable for community banks), the named first-line and second-line owners, and a short AI risk appetite statement your Board can adopt. Satisfies: the interagency model risk guidance on board and senior management responsibilities and the FFIEC Management booklet.",
        },
        {
          id: "ai-inventory-risk-tiers",
          title: "AI inventory and risk tiers",
          placeholder:
            "This section will require a complete inventory of AI in use, including AI embedded in vendor systems such as your core processor and fraud tools, with each entry assigned a risk tier that drives approval and validation depth. Satisfies: the interagency model risk guidance's inventory expectations and the FFIEC IT Handbook's system inventory expectations.",
        },
        {
          id: "approved-tools-genai",
          title: "Approved tools and employee AI rules",
          placeholder:
            "This section will hold the approved, conditionally approved, and not approved tool table with allowed account types, plus the request path and decision owner for new tools. Satisfies: the AI section of the FFIEC IT Handbook's operations booklet and the Information Security booklet's acceptable use expectations.",
        },
        {
          id: "data-rules",
          title: "Bank data in AI tools",
          placeholder:
            "This section will set traffic-light rules keyed to the bank's real data classes, with customer nonpublic personal information, credentials, suspicious activity information, and confidential supervisory information in the never-without-written-approval class. Satisfies: GLBA safeguards under the FFIEC Information Security booklet and Regulation P privacy obligations.",
        },
        {
          id: "output-verification-disclosure",
          title: "Verifying and disclosing AI output",
          placeholder:
            "This section will set the rule that staff own what they send: verify facts and figures, and never send AI output to a customer, a regulator, or into a credit decision without qualified human review. Satisfies: examiner expectations for human oversight in the FFIEC IT Handbook and the CFPB circulars on AI-assisted decisions.",
        },
        {
          id: "training-awareness",
          title: "Training and awareness",
          placeholder:
            "This section will attach AI rules to the bank's existing annual training cycle and add fraud awareness for AI-enabled schemes such as deepfake voice and synthetic identity. Satisfies: the Information Security booklet's training expectations and FinCEN alerting on deepfake fraud.",
        },
        {
          id: "monitoring-audit-reporting",
          title: "Monitoring, audit, and Board reporting",
          placeholder:
            "This section will set what management monitors, what internal audit covers, and what the Board sees on a defined cadence, so the policy leaves an exam-ready paper trail. Satisfies: the FFIEC Audit booklet's coverage expectations and the interagency model risk guidance on reporting.",
        },
        {
          id: "exceptions-enforcement-maintenance",
          title: "Exceptions, enforcement, and maintenance",
          placeholder:
            "This section will define the written exception path with expiry dates, proportionate consequences, the policy owner, and the review cadence with a version table. It will also list the living artifacts management maintains without Board action. Satisfies: examiner expectations for policy lifecycle management in the FFIEC Management booklet.",
        },
        {
          id: "regulatory-mapping",
          title: "Regulatory mapping",
          placeholder:
            "This section will hold a table mapping each document in this set, and each section of this policy, to the supervisory source it answers: the page examiners and auditors will read first. Satisfies: exam workpaper traceability expectations across the FFIEC handbook booklets.",
        },
      ],
    },
    {
      slug: "amend-model-risk",
      title: "Amendment: Model Risk Management",
      sections: [
        {
          id: "landing",
          title: "Where this amendment lands",
          placeholder:
            "This section will name the bank's existing model risk management policy, the sections this amendment modifies, and who approves it. If the bank reports no standalone model risk policy, this document redrafts as a compact starter policy sized to your tier, because pretending to amend a policy that does not exist would cost you credibility with your examiner. Satisfies: the interagency model risk guidance's expectation of documented, proportionate practice.",
        },
        {
          id: "ai-in-scope",
          title: "AI and machine learning as models",
          placeholder:
            "This section will bring AI and machine learning tools inside the bank's model definition and inventory, and note that the agencies have signaled further AI-specific guidance, which this policy will absorb on its review cadence. Satisfies: the interagency model risk guidance's model definition and inventory expectations.",
        },
        {
          id: "validation-proportionality",
          title: "Validation scaled to size and materiality",
          placeholder:
            "This section will set validation depth by risk tier and asset size: outsourced or pooled validation is acceptable for community banks, while larger banks need independent in-house effective challenge. Satisfies: the interagency model risk guidance's materiality and proportionality principles.",
        },
        {
          id: "vendor-models",
          title: "Vendor and third-party models",
          placeholder:
            "This section will state plainly that using a vendor's model never transfers responsibility: the bank must understand, monitor, and be able to explain vendor AI it relies on. Satisfies: the interagency model risk guidance's third-party provisions and the interagency third-party risk guidance.",
        },
      ],
    },
    {
      slug: "amend-third-party",
      title: "Amendment: Third-Party Risk Management",
      sections: [
        {
          id: "landing",
          title: "Where this amendment lands",
          placeholder:
            "This section will name the bank's vendor or third-party risk policy and the sections this amendment modifies, keyed to the policies you confirm you actually have, and who approves it. If no such policy exists, this document redrafts as a compact starter policy. Satisfies: the interagency third-party risk management guidance and its community bank companion guide.",
        },
        {
          id: "ai-due-diligence",
          title: "AI-specific due diligence",
          placeholder:
            "This section will add AI questions to onboarding diligence: training data use, whether bank data trains vendor models, model update practices, and subcontractor AI. Satisfies: the interagency third-party guidance's due diligence expectations applied to AI features.",
        },
        {
          id: "contract-provisions",
          title: "Contract provisions for AI",
          placeholder:
            "This section will list the contract terms to seek for AI vendors, including data use limits, notice of material model changes, audit and information rights, and exit assistance. Satisfies: the interagency third-party guidance's contract negotiation expectations.",
        },
        {
          id: "ongoing-monitoring",
          title: "Ongoing monitoring and concentration",
          placeholder:
            "This section will set how the bank watches vendor AI changes over time and tracks concentration in critical AI providers, including AI quietly added to systems the bank already uses. Satisfies: the interagency third-party guidance's ongoing monitoring expectations.",
        },
      ],
    },
    {
      slug: "amend-infosec",
      title: "Amendment: Information Security and Incident Response",
      sections: [
        {
          id: "landing",
          title: "Where this amendment lands",
          placeholder:
            "This section will name the bank's information security program and incident response plan and the sections this amendment modifies, and who approves it. If neither exists in writing, this document redrafts as a compact starter standard. Satisfies: GLBA safeguards implemented through the FFIEC Information Security booklet.",
        },
        {
          id: "ai-threat-surface",
          title: "AI threat surface and controls",
          placeholder:
            "This section will add AI-specific risks to the security program: data leakage into external tools, prompt injection, credential exposure, and unsanctioned shadow AI, with the controls that answer each. Satisfies: the Information Security booklet's risk identification and control expectations.",
        },
        {
          id: "ai-incidents",
          title: "AI incidents in the response plan",
          placeholder:
            "This section will define what counts as an AI incident, route it through the existing incident response plan, and connect fraud-flavored AI incidents to suspicious activity review. Satisfies: the Information Security booklet's incident response expectations and FinCEN alerting on AI-enabled fraud.",
        },
        {
          id: "access-logging",
          title: "Access, logging, and retention",
          placeholder:
            "This section will set access control, logging, and retention expectations for approved AI tools so use can be reviewed after the fact. Satisfies: the Information Security booklet's access management and audit trail expectations.",
        },
      ],
    },
    {
      slug: "amend-compliance",
      title: "Amendment: Compliance and Fair Lending",
      sections: [
        {
          id: "landing",
          title: "Where this amendment lands",
          placeholder:
            "This section will name the bank's compliance management system and fair lending policy and the sections this amendment modifies, and who approves it. If no written compliance policy exists, this document redrafts as a compact starter policy. Satisfies: interagency consumer compliance expectations for a written compliance management system.",
        },
        {
          id: "fair-lending-ai",
          title: "Fair lending and AI models",
          placeholder:
            "This section will require fair lending testing before and after any AI touches credit or pricing, including disparate impact analysis and documentation of searches for less discriminatory alternatives. Satisfies: ECOA and Regulation B, and the CFPB circulars on credit decision models.",
        },
        {
          id: "adverse-action",
          title: "Adverse action notices",
          placeholder:
            "This section will set the rule that adverse action reasons must be specific and accurate even when a complex model made the call: the model said so is never a permissible reason. Satisfies: the CFPB circulars on adverse action notification when AI or complex models are used.",
        },
        {
          id: "udaap-customer-ai",
          title: "UDAAP, chatbots, and marketing",
          placeholder:
            "This section will cover customer-facing AI such as chatbots and AI-assisted marketing: accuracy, escalation to a human, complaint capture, and avoiding deceptive AI claims. Satisfies: UDAAP prohibitions and supervisory attention to bank chatbots.",
        },
      ],
    },
    {
      slug: "amend-bsa-aml",
      title: "Amendment: BSA/AML Program",
      sections: [
        {
          id: "landing",
          title: "Where this amendment lands",
          placeholder:
            "This section will name the bank's BSA/AML program documents and the sections this amendment modifies, coordinated with the BSA officer, and who approves it. Satisfies: BSA/AML program requirements as examined under the FFIEC BSA/AML manual.",
        },
        {
          id: "monitoring-models",
          title: "AI in monitoring and screening",
          placeholder:
            "This section will bring AI features of transaction monitoring, sanctions screening, and customer risk rating under model validation, with tuning and threshold changes documented. Satisfies: FFIEC BSA/AML manual expectations for monitoring system validation and the interagency model risk guidance as applied to compliance models.",
        },
        {
          id: "fraud-typologies",
          title: "AI-enabled fraud typologies",
          placeholder:
            "This section will require detection and staff awareness for deepfake identity documents, synthetic voices, and AI-assisted phishing, and route confirmed cases into suspicious activity review. Satisfies: FinCEN alerting on deepfake media and AI-enabled fraud schemes.",
        },
        {
          id: "sar-governance",
          title: "Human decisions on suspicious activity",
          placeholder:
            "This section will fix the line that AI may surface and prioritize alerts but a documented human decision closes or files every case; no alert is auto-dismissed by a model. Satisfies: suspicious activity reporting obligations and examiner expectations for alert disposition documentation.",
        },
      ],
    },
    {
      slug: "ai-artifacts",
      title: "AI Program Artifacts",
      sections: [
        {
          id: "ai-inventory-template",
          title: "AI inventory template",
          placeholder:
            "This section will hold the starter inventory table (system, owner, vendor, use, data touched, risk tier, validation status, review date), prefilled with what research and your answers surfaced. These artifacts are management-owned working documents the policy references; they update without Board action. Satisfies: model inventory expectations in a form management can keep current.",
        },
        {
          id: "risk-tier-matrix",
          title: "Risk tier matrix",
          placeholder:
            "This section will define the bank's AI risk tiers with plain criteria (customer impact, credit relevance, data sensitivity, autonomy) and what each tier requires before use. Satisfies: proportionate risk management under the interagency model risk guidance and the FFIEC IT Handbook.",
        },
        {
          id: "approved-tools-register",
          title: "Approved tools register",
          placeholder:
            "This section will hold the running register behind the policy's tool table, including approval date, conditions, account type, and next review. Satisfies: the FFIEC IT Handbook's expectations for controlled, documented AI use.",
        },
        {
          id: "vendor-ai-questionnaire",
          title: "Vendor AI questionnaire",
          placeholder:
            "This section will hold the due diligence question set your third-party amendment requires, ready to send to any AI vendor or to a core provider adding AI features. Satisfies: the interagency third-party guidance's due diligence expectations.",
        },
        {
          id: "employee-quick-reference",
          title: "Employee quick reference",
          placeholder:
            "This section will hold a one-page plain-language card: approved tools, the never list, the ask-first rule, and where to report a mishap. Satisfies: training and awareness expectations in the Information Security booklet.",
        },
      ],
    },
  ],
  bank: [
    {
      id: "FF-01",
      prompt:
        "Before we draft anything: here is what I found about your institution, including what public sources show about your size where available. Did I get your institution right, and what would you correct?",
      why: "Every document is calibrated to your charter, regulator, and asset size, so a wrong assumption here would ripple through the whole set.",
      feeds: ["bank-ai-use-policy#purpose-scope"],
      suggestions: [
        "Yes, that matches",
        "Assets figure is off",
        "Wrong charter or regulator",
      ],
      required: true,
      snapshot: true,
    },
    {
      id: "FF-02",
      prompt:
        "What are your institution's total consolidated assets? If I found a figure in the Federal Reserve's quarterly bank list, it is the first suggestion below; confirm or correct it. Savings institutions and credit unions are not on that list, so I may need it from you.",
      why: "Supervisory expectations scale with size, and this answer sets the tier every document drafts to.",
      feeds: [
        "bank-ai-use-policy#governance-accountability",
        "amend-model-risk#validation-proportionality",
      ],
      suggestions: [
        "Under $1 billion",
        "$1 billion to $10 billion",
        "$10 billion to $30 billion",
        "Over $30 billion",
      ],
      required: true,
    },
    {
      id: "FF-03",
      prompt:
        "Who is your primary federal regulator and what is your charter: OCC, Federal Reserve, FDIC with a state charter, or NCUA as a credit union?",
      why: "The mapping table and several amendments name your regulator, and the wrong one is an instant credibility hit with examiners.",
      feeds: [
        "bank-ai-use-policy#purpose-scope",
        "bank-ai-use-policy#regulatory-mapping",
      ],
      suggestions: [
        "OCC national bank",
        "State member, Federal Reserve",
        "State nonmember, FDIC",
        "Credit union, NCUA",
      ],
      required: true,
    },
    {
      id: "FF-04",
      prompt:
        "Which of these written policies does your bank have today: model risk management, vendor or third-party risk, information security and incident response, compliance or fair lending, BSA/AML? Name them as they are titled internally.",
      why: "The amendments modify your real policies by name; anything you do not have becomes a short standalone starter policy instead.",
      feeds: [
        "amend-model-risk#landing",
        "amend-third-party#landing",
        "amend-infosec#landing",
        "amend-compliance#landing",
        "amend-bsa-aml#landing",
      ],
      suggestions: [
        "All five, standard titles",
        "No standalone model risk policy",
        "Not sure of exact titles",
      ],
      required: true,
    },
    {
      id: "FF-05",
      prompt:
        "Which AI tools are in use at the bank today, officially or not, including AI features inside vendor systems like your core processor, loan origination, or fraud tools?",
      why: "The inventory and tool table only protect you if they match reality, and embedded vendor AI is what banks most often miss.",
      feeds: [
        "bank-ai-use-policy#ai-inventory-risk-tiers",
        "bank-ai-use-policy#approved-tools-genai",
        "ai-artifacts#ai-inventory-template",
      ],
      suggestions: [
        "Staff use ChatGPT or Copilot",
        "AI features in our core or LOS",
        "Not sure what is embedded",
      ],
      required: true,
    },
    {
      id: "FF-06",
      prompt:
        "Does any AI touch customers directly today: a chatbot, AI-drafted customer messages, or AI-generated marketing?",
      why: "Customer-facing AI is where UDAAP and complaint risk concentrate, so these sections draft only as strongly as your reality requires.",
      feeds: [
        "amend-compliance#udaap-customer-ai",
        "bank-ai-use-policy#output-verification-disclosure",
      ],
      suggestions: [
        "Chatbot on our site",
        "AI-drafted emails or letters",
        "No customer-facing AI",
      ],
      required: true,
    },
    {
      id: "FF-07",
      prompt:
        "Does AI or a complex model play any role in credit decisions, pricing, or account approvals, whether built in-house or inside a vendor system?",
      why: "Credit is the highest-stakes use a bank has: it pulls in fair lending testing and strict adverse action rules.",
      feeds: [
        "amend-compliance#fair-lending-ai",
        "amend-compliance#adverse-action",
        "amend-model-risk#ai-in-scope",
      ],
      suggestions: [
        "Yes, in vendor underwriting",
        "Only as a second look",
        "No AI in credit today",
      ],
      required: true,
    },
    {
      id: "FF-08",
      prompt:
        "What runs your BSA/AML transaction monitoring and sanctions screening, and do you know whether it uses AI or machine learning features?",
      why: "Monitoring systems are validated like models, and vendors are adding AI features that change what examiners expect of you.",
      feeds: ["amend-bsa-aml#monitoring-models", "amend-bsa-aml#landing"],
      suggestions: [
        "Verafin",
        "Abrigo or similar",
        "Unsure about AI features",
      ],
      required: true,
    },
    {
      id: "FF-09",
      prompt:
        "Which existing committee should own AI oversight, or do you want a new one? For community banks an existing risk or IT steering committee with an expanded charter is normal.",
      why: "Examiners look for a named owner with Board reporting, not necessarily a new committee.",
      feeds: ["bank-ai-use-policy#governance-accountability"],
      suggestions: [
        "IT steering committee",
        "Enterprise risk committee",
        "Suggest one for our size",
      ],
      required: true,
    },
    {
      id: "FF-10",
      prompt:
        "How do you validate models today: in-house staff, an outsourced validation firm, or not formally at all?",
      why: "Validation depth is the most size-sensitive expectation in the whole set, and the amendment must match what you can actually staff.",
      feeds: ["amend-model-risk#validation-proportionality"],
      suggestions: [
        "Outsourced firm",
        "In-house validators",
        "No formal validation yet",
      ],
      required: true,
    },
    {
      id: "FF-11",
      prompt:
        "Which vendors matter most for AI exposure: your core processor, loan origination, fraud, document, or marketing vendors? Name the big ones.",
      why: "The vendor amendment and questionnaire should name your critical providers, not a generic list.",
      feeds: [
        "amend-third-party#ai-due-diligence",
        "ai-artifacts#vendor-ai-questionnaire",
      ],
      suggestions: [
        "FIS, Fiserv, or Jack Henry core",
        "A fintech partner",
        "Need to pull the vendor list",
      ],
      required: true,
    },
    {
      id: "FF-12",
      prompt:
        "Beyond customer nonpublic personal information, what data at your bank must never touch an external AI tool? Think exam materials, suspicious activity information, credentials, and merger work.",
      why: "The never list is what staff remember under pressure, and confidential supervisory information has special handling rules.",
      feeds: ["bank-ai-use-policy#data-rules"],
      suggestions: [
        "Exam materials and CSI",
        "SAR-related information",
        "Credentials and keys",
      ],
      required: true,
    },
    {
      id: "FF-13",
      prompt:
        "Where should staff report an AI mishap, and is that channel actually monitored? An existing incident or ethics line is fine.",
      why: "A monitored channel with a no-blame norm is what turns mistakes into fixable events instead of exam findings.",
      feeds: [
        "amend-infosec#ai-incidents",
        "bank-ai-use-policy#monitoring-audit-reporting",
      ],
      suggestions: [
        "Existing incident process",
        "Email to our ISO",
        "Need to create one",
      ],
      required: true,
    },
    {
      id: "FF-14",
      prompt:
        "Who owns this policy set, what training cycle can it attach to, and how often will the Board realistically review it?",
      why: "An owner, a training hook, and an honest Board cadence are what keep this alive between exams.",
      feeds: [
        "bank-ai-use-policy#training-awareness",
        "bank-ai-use-policy#exceptions-enforcement-maintenance",
      ],
      suggestions: [
        "CRO, annual Board review",
        "ISO owns it, annual training",
        "Not decided yet",
      ],
      required: true,
    },
    {
      id: "FF-15",
      prompt:
        "Have recent exams or audits raised anything about IT, models, vendors, or BSA that this policy set should visibly answer? Keep it general; do not paste examiner language here.",
      why: "A policy that quietly closes a known gap is worth far more at the next exam. Confidential supervisory information stays at the bank; a general theme is all the drafting needs.",
      feeds: ["bank-ai-use-policy#monitoring-audit-reporting"],
      suggestions: [
        "Yes, an IT or model finding",
        "Clean recent exams",
        "Prefer not to say",
      ],
      required: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// nist_ai_rmf: seven documents (GOVERN / MAP / MEASURE / MANAGE program)
// ---------------------------------------------------------------------------

const NIST_AI_RMF: KindBlueprint = {
  kind: "nist_ai_rmf",
  title: "NIST AI RMF Governance Set",
  docs: [
    {
      slug: "ai-risk-mgmt-policy",
      title: "AI Risk Management Policy",
      sections: [
        {
          id: "purpose-scope",
          title: "Purpose and scope",
          placeholder:
            "This section will state why this policy exists and which parts of your organization it covers, based on your confirmed profile.",
        },
        {
          id: "definitions",
          title: "Definitions",
          placeholder:
            "This section will define the terms the policy relies on, such as AI system and generative AI, in plain language aligned with the NIST AI RMF.",
        },
        {
          id: "risk-tolerance",
          title: "Risk tolerance and tiering",
          placeholder:
            "This section will record how much AI risk your leadership will accept, and a simple tiering scheme for rating systems from unacceptable to low. It will reflect your stated appetite and your worst realistic failure case.",
        },
        {
          id: "trustworthiness",
          title: "Trustworthiness commitments",
          placeholder:
            "This section will map each of the NIST AI RMF trustworthiness characteristics to one concrete commitment your organization makes.",
        },
        {
          id: "legal-map",
          title: "Legal and regulatory mapping",
          placeholder:
            "This section will hold a table of the laws and regulations you identified as applying to your AI use, with an owner for tracking each.",
        },
        {
          id: "review-cadence",
          title: "Review cadence, ownership, and culture",
          placeholder:
            "This section will set who owns this policy, how often it is reviewed, and the culture commitments that make AI risk everyone's job rather than a side desk.",
        },
      ],
    },
    {
      slug: "ai-roles-raci",
      title: "AI Governance Roles and Accountability (RACI)",
      sections: [
        {
          id: "charter",
          title: "Governance body charter",
          placeholder:
            "This section will describe your AI governance body: membership, quorum, and meeting cadence, reusing an existing risk or security committee if you have one.",
        },
        {
          id: "raci-matrix",
          title: "RACI matrix",
          placeholder:
            "This section will hold a RACI matrix crossing the AI lifecycle stages, from design through decommissioning, with your actual roles, so every stage has a clear owner.",
        },
        {
          id: "decision-rights",
          title: "Decision rights and escalation",
          placeholder:
            "This section will name who can approve an AI system for launch and who can order one shut off, with the escalation path between them.",
        },
        {
          id: "oversight-roles",
          title: "Human oversight roles",
          placeholder:
            "This section will assign the human oversight roles for systems where people supervise, correct, or override AI output.",
        },
      ],
    },
    {
      slug: "ai-system-inventory",
      title: "AI System Inventory and Context Map",
      sections: [
        {
          id: "inventory-table",
          title: "Inventory table",
          placeholder:
            "This section will hold your AI system inventory: name, purpose, owner, users, model type, data categories, deployment context, risk tier, and status. It includes AI features embedded in software you buy, not just systems you build.",
        },
        {
          id: "context-narratives",
          title: "Context narratives",
          placeholder:
            "For your higher-risk systems, this section will describe the intended use, foreseeable misuse, and uses that are explicitly out of scope.",
        },
        {
          id: "third-party-flags",
          title: "Third-party and value-chain entries",
          placeholder:
            "This section will flag inventory entries that depend on third-party models, APIs, or vendors, so value-chain risk stays visible.",
        },
      ],
    },
    {
      slug: "ai-risk-register",
      title: "AI Risk Register and Measurement Plan",
      sections: [
        {
          id: "register",
          title: "Risk register",
          placeholder:
            "This section will hold your risk register schema and starting entries: each risk tied to a system, the trustworthiness characteristic it threatens, the generative AI risk category from NIST's Generative AI Profile where relevant, likelihood, impact, owner, and treatment.",
        },
        {
          id: "metrics-plan",
          title: "Measurement plan",
          placeholder:
            "This section will describe what you measure before deployment and in operation, how often, and the thresholds that trigger action.",
        },
        {
          id: "tevv",
          title: "Testing, evaluation, verification, and validation",
          placeholder:
            "This section will assign responsibility for testing, evaluation, verification, and validation, with a note on keeping evaluators independent from builders.",
        },
      ],
    },
    {
      slug: "ai-incident-response",
      title: "AI Incident Response and Risk Treatment Plan",
      sections: [
        {
          id: "definitions",
          title: "What counts as an AI incident",
          placeholder:
            "This section will define an AI incident, distinguish it from a security incident, and describe the hand-off to your existing incident response plan if you have one.",
        },
        {
          id: "severity-playbook",
          title: "Severity levels and response playbook",
          placeholder:
            "This section will set severity levels with examples and the response steps: contain, assess, remediate, notify. Containment includes the ability to disable, roll back, or switch off a system.",
        },
        {
          id: "vendor-contingencies",
          title: "Third-party failure contingencies",
          placeholder:
            "This section will describe what you do when a third-party model or AI API fails, degrades, or changes underneath you.",
        },
        {
          id: "post-incident",
          title: "Post-incident review and disclosure",
          placeholder:
            "This section will describe the post-incident review, how findings feed back into the risk register, and the criteria for disclosing externally.",
        },
      ],
    },
    {
      slug: "ai-thirdparty-procedure",
      title: "Third-Party AI Risk Procedure",
      sections: [
        {
          id: "questionnaire",
          title: "Pre-procurement questionnaire",
          placeholder:
            "This section will hold the questions you ask an AI vendor before buying: training data provenance, evaluation results, uptime, data handling, and sub-processors.",
        },
        {
          id: "contract-clauses",
          title: "Contract clause checklist",
          placeholder:
            "This section will hold a checklist of contract clauses for AI vendors: data use restrictions, incident notice, audit rights, and notice of model changes.",
        },
        {
          id: "vendor-monitoring",
          title: "Ongoing vendor monitoring",
          placeholder:
            "This section will describe how you monitor vendor model updates and re-check critical vendors over time.",
        },
      ],
    },
    {
      slug: "genai-profile-addendum",
      title: "Generative AI Risk Addendum",
      stub: true,
      sections: [
        {
          id: "risk-applicability",
          title: "Risk applicability",
          placeholder:
            "This section will walk through the generative AI risk categories from NIST's Generative AI Profile and record which ones apply to your use, and why. It activates only if the interview shows you use generative AI.",
        },
        {
          id: "selected-actions",
          title: "Selected actions",
          placeholder:
            "For each applicable risk, this section will select concrete actions drawn from the Profile's suggested actions, tagged by RMF function.",
        },
        {
          id: "provenance-disclosure",
          title: "Content provenance and disclosure",
          placeholder:
            "This section will describe how you label or track AI-generated content, and the acceptable-input rules that cross-reference your AI usage policy.",
        },
      ],
    },
  ],
  bank: [
    {
      id: "N-01",
      prompt:
        "First, a quick check on my research: did I get your organization right, its size, industry, and where it operates, and what would you correct?",
      why: "Everything downstream is scoped to who you are, so we fix wrong assumptions before they spread.",
      feeds: ["ai-risk-mgmt-policy#purpose-scope"],
      suggestions: [
        "Yes, that matches",
        "Right industry, wrong size",
        "We operate in more regions",
      ],
      required: true,
      snapshot: true,
    },
    {
      id: "N-02",
      prompt:
        "List every AI system you build, buy, or embed, including LLM APIs and AI features inside software you already use.",
      why: "The inventory is the backbone of the program: risks attach to systems, and an unlisted system is an unmanaged one.",
      feeds: ["ai-system-inventory#inventory-table"],
      suggestions: [
        "A support chatbot and Copilot",
        "AI features in our CRM",
        "Not sure, help me make the list",
      ],
      required: true,
    },
    {
      id: "N-03",
      prompt:
        "For each of those systems, who uses it, and who is affected by what it produces?",
      why: "Risk lives with the people affected, and they are often not the people at the keyboard.",
      feeds: ["ai-system-inventory#context-narratives"],
      required: true,
    },
    {
      id: "N-04",
      prompt:
        "Is any of that generative AI, meaning tools that produce text, images, audio, video, or code?",
      why: "Generative AI carries its own risk profile, and a yes here adds a dedicated addendum to your document set.",
      feeds: [
        "genai-profile-addendum#risk-applicability",
        "ai-system-inventory#inventory-table",
      ],
      suggestions: ["Yes, we use LLMs daily", "One chatbot, that is all", "No generative AI"],
      required: true,
    },
    {
      id: "N-05",
      prompt:
        "Which laws and regulations already apply to you, such as privacy law or rules specific to your sector?",
      why: "AI risk management has to sit on top of the legal duties you already carry.",
      feeds: ["ai-risk-mgmt-policy#legal-map"],
      suggestions: ["GDPR and CCPA", "HIPAA", "Nothing sector-specific I know of"],
      required: true,
    },
    {
      id: "N-06",
      prompt:
        "What is the worst realistic outcome if your highest-stakes AI system fails or misbehaves?",
      why: "The worst realistic case anchors your risk tolerance in something concrete instead of adjectives.",
      feeds: ["ai-risk-mgmt-policy#risk-tolerance", "ai-risk-register#register"],
      required: true,
    },
    {
      id: "N-07",
      prompt:
        "How much risk is leadership willing to accept in exchange for AI benefits: conservative, balanced, or aggressive?",
      why: "A written appetite lets people say no, or yes, without escalating every single decision.",
      feeds: ["ai-risk-mgmt-policy#risk-tolerance"],
      suggestions: ["Conservative", "Balanced", "Aggressive, within the law"],
      required: true,
    },
    {
      id: "N-08",
      prompt:
        "Who decides today whether an AI system may launch, and who could order one shut off?",
      why: "Launch and shutdown authority are the two decision rights that matter most in a bad week.",
      feeds: ["ai-roles-raci#decision-rights"],
      required: true,
    },
    {
      id: "N-09",
      prompt:
        "Do you have an existing risk, security, or privacy committee this program can attach to?",
      why: "Attaching to a body that already meets is far more durable than inventing a new one.",
      feeds: ["ai-roles-raci#charter"],
      suggestions: ["Yes, a security committee", "A privacy working group", "No, nothing yet"],
      required: true,
    },
    {
      id: "N-10",
      prompt: "How do you test AI systems before launch today, if at all?",
      why: "Your current testing practice is the baseline the measurement plan builds from.",
      feeds: ["ai-risk-register#metrics-plan", "ai-risk-register#tevv"],
      required: true,
    },
    {
      id: "N-11",
      prompt:
        "Once an AI system is live, what would you watch to know it is degrading?",
      why: "Models drift quietly, so production monitoring is where most real-world AI risk is caught.",
      feeds: ["ai-risk-register#metrics-plan"],
      required: true,
    },
    {
      id: "N-12",
      prompt:
        "Which third-party AI vendors are critical to you, and what do your contracts say about data use and incidents?",
      why: "Most organizations' AI risk arrives through vendors, and the contract is your main lever.",
      feeds: [
        "ai-thirdparty-procedure#questionnaire",
        "ai-thirdparty-procedure#contract-clauses",
      ],
      required: true,
    },
    {
      id: "N-13",
      prompt:
        "Could your generative AI produce content that reaches the public without a human reviewing it first?",
      why: "Unreviewed public output is the fastest path from a model quirk to a company incident.",
      feeds: [
        "genai-profile-addendum#risk-applicability",
        "ai-incident-response#severity-playbook",
      ],
      suggestions: ["Yes, some chatbot replies", "No, humans review everything"],
      required: false,
    },
    {
      id: "N-14",
      prompt:
        "Where accuracy matters, how do you handle the risk of the AI confidently making things up?",
      why: "Fabricated answers are the signature generative AI failure, so your controls here set the tone.",
      feeds: ["genai-profile-addendum#selected-actions"],
      required: false,
    },
    {
      id: "N-15",
      prompt: "Do you label or watermark AI-generated content today?",
      why: "Provenance practices decide whether people can tell your human and AI content apart later.",
      feeds: ["genai-profile-addendum#provenance-disclosure"],
      suggestions: ["Yes, we label it", "Sometimes", "No, not yet"],
      required: false,
    },
    {
      id: "N-16",
      prompt:
        "Who should be woken up for an AI incident, and is there an existing security incident plan we can extend?",
      why: "An incident plan without a named human and a phone tree is a document, not a plan.",
      feeds: [
        "ai-incident-response#definitions",
        "ai-incident-response#severity-playbook",
      ],
      required: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// eu_ai_act: ten documents (role-aware: provider docs default to stubs)
// ---------------------------------------------------------------------------

// Shared wording for the two negative-determination docs. The adoption block
// is signed by the customer's own reviewer, never by the AI assistant.
const DETERMINATION_RULES =
  "listing the specific facts you provided that it relies on. The determination text itself will include a sentence that the conclusion must be confirmed with qualified counsel before you rely on it. It ends with a human adoption block, \"Reviewed and approved by: ______________ (name, title, date)\": that signature line is for your own reviewer, never for the AI assistant.";

const EU_AI_ACT: KindBlueprint = {
  kind: "eu_ai_act",
  title: "EU AI Act Governance Set",
  docs: [
    {
      slug: "aia-applicability-memo",
      title: "AI Act Applicability and Role Assessment",
      sections: [
        {
          id: "company-profile",
          title: "Company profile",
          placeholder:
            "This section will summarize your company and its AI systems as confirmed in the interview, so the analysis that follows is grounded in your facts.",
        },
        {
          id: "eu-nexus",
          title: "EU nexus analysis",
          placeholder:
            "This section will analyze whether the EU AI Act reaches you under Article 2: whether you are established in the EU, place systems on the EU market, or your AI outputs are used there.",
        },
        {
          id: "role-determination",
          title: "Role determination per system",
          placeholder:
            "For each AI system, this section will determine your role under Article 3: provider, deployer, importer, or distributor, with the reasoning. Your role decides which obligations apply.",
        },
        {
          id: "timeline",
          title: "Obligation timeline",
          placeholder:
            "This section will lay out which obligations apply to your systems and when, personalized from the standards knowledge current at generation time. Application dates are stamped when the document is generated, not hardcoded in this template.",
        },
        {
          id: "determination",
          title: "Determination and adoption",
          placeholder:
            "This section will hold the written applicability determination, " +
            DETERMINATION_RULES,
        },
      ],
    },
    {
      slug: "aia-prohibited-screening",
      title: "Prohibited Practices Screening (Article 5)",
      sections: [
        {
          id: "practice-categories",
          title: "Prohibited practices in plain language",
          placeholder:
            "This section will explain the prohibited practice categories of Article 5 in plain language, with examples relevant to your industry.",
        },
        {
          id: "screening-checklist",
          title: "Screening checklist",
          placeholder:
            "This section will hold a per-system screening checklist against each prohibited practice category, based on the systems you described.",
        },
        {
          id: "determination",
          title: "Determination and adoption",
          placeholder:
            "This section will hold the signed screening outcome, " +
            DETERMINATION_RULES,
        },
      ],
    },
    {
      slug: "aia-classification-register",
      title: "High-Risk Classification Register (Article 6)",
      sections: [
        {
          id: "register",
          title: "Classification register",
          placeholder:
            "This section will test each of your AI systems against the high-risk categories of Annex III, and the product-safety path of Annex I where relevant, and record the result.",
        },
        {
          id: "derogation-analysis",
          title: "Derogation analysis",
          placeholder:
            "For systems that land in an Annex III category, this section will analyze whether the Article 6(3) derogation applies, for example where the system only performs a narrow procedural task.",
        },
        {
          id: "conclusions",
          title: "Documented conclusions",
          placeholder:
            "This section will record the documented classification conclusion per system, the facts each conclusion relies on, and a review trigger for when a system materially changes.",
        },
      ],
    },
    {
      slug: "aia-risk-mgmt-system",
      title: "Risk Management System (Article 9)",
      stub: true,
      sections: [
        {
          id: "process",
          title: "Continuous risk management process",
          placeholder:
            "This section will describe the continuous, iterative risk management process Article 9 requires from providers of high-risk systems: identify, estimate, and evaluate risks to health, safety, and fundamental rights. It activates only if the interview shows you are a provider.",
        },
        {
          id: "mitigation-testing",
          title: "Mitigation and testing",
          placeholder:
            "This section will describe your mitigation hierarchy, eliminate by design first, then mitigate, then inform, and the testing that shows the measures work, with special consideration for people under 18.",
        },
      ],
    },
    {
      slug: "aia-data-tech-docs",
      title: "Data Governance and Technical Documentation (Articles 10-12)",
      stub: true,
      sections: [
        {
          id: "data-governance",
          title: "Data governance",
          placeholder:
            "This section will describe how training, validation, and test data are governed under Article 10: relevance, representativeness, error checking, and bias examination. It activates only if the interview shows you are a provider.",
        },
        {
          id: "technical-documentation",
          title: "Technical documentation skeleton",
          placeholder:
            "This section will hold the Annex IV technical documentation skeleton: general description, development process, monitoring and functioning, risk management, changes, and standards applied.",
        },
        {
          id: "logging",
          title: "Automatic logging",
          placeholder:
            "This section will specify what the system logs automatically under Article 12 and how that logging capability is designed in. Deployer-side log retention is covered in the deployer obligations procedure, not here.",
        },
      ],
    },
    {
      slug: "aia-transparency-oversight",
      title: "Transparency and Human Oversight (Articles 13, 14, 50)",
      sections: [
        {
          id: "instructions-for-use",
          title: "Instructions for use",
          placeholder:
            "This section will list what your instructions for use must contain under Article 13, so the people deploying the system can operate it properly.",
        },
        {
          id: "art50-disclosures",
          title: "Article 50 disclosure duties",
          placeholder:
            "This section will identify which Article 50 transparency duties you actually trigger, such as chatbot disclosure or labeling synthetic media, and draft the exact user-facing wording for each.",
        },
        {
          id: "human-oversight",
          title: "Human oversight design",
          placeholder:
            "This section will describe the human oversight design under Article 14: the oversight measures, the competence and authority of the people overseeing, and their ability to intervene or stop the system, including how deployers assign oversight under Article 26.",
        },
      ],
    },
    {
      slug: "aia-deployer-procedure",
      title: "Deployer Obligations Procedure (Articles 26-27)",
      sections: [
        {
          id: "operating-duties",
          title: "Operating duties",
          placeholder:
            "This section will describe your duties when operating a high-risk AI system built by someone else: use it per the provider's instructions, keep input data relevant, monitor operation, suspend use when something is off, and inform workers and their representatives before workplace deployment.",
        },
        {
          id: "log-retention",
          title: "Log retention",
          placeholder:
            "This section will set your log-retention practice under Article 26(6): keep the logs the system generates automatically for at least six months, unless other applicable law sets a different period, and name who owns that storage.",
        },
        {
          id: "fria",
          title: "Fundamental rights impact assessment",
          placeholder:
            "If you are a public body or provide public services, credit, or insurance, this section will hold your fundamental rights impact assessment template under Article 27: process description, affected categories, risks, oversight, and mitigation.",
        },
      ],
    },
    {
      slug: "aia-pmm-incidents",
      title: "Post-Market Monitoring and Serious Incidents (Articles 72-73)",
      sections: [
        {
          id: "pmm-plan",
          title: "Post-market monitoring plan",
          placeholder:
            "This section will hold your post-market monitoring plan under Article 72: how you collect and review experience from systems in use, and who acts on what you learn.",
        },
        {
          id: "serious-incidents",
          title: "Serious incident reporting",
          placeholder:
            "This section will define a serious incident under Article 73 and describe the reporting path to market surveillance authorities. Regulatory reporting deadlines are statutory; confirm current deadlines with counsel before relying on the timelines stated here.",
        },
      ],
    },
    {
      slug: "aia-literacy-plan",
      title: "AI Literacy and Training Plan (Article 4)",
      sections: [
        {
          id: "training-matrix",
          title: "Role-tiered training matrix",
          placeholder:
            "This section will hold a role-tiered training matrix: what all staff learn, and the deeper tiers for people who operate, build, or govern AI systems.",
        },
        {
          id: "curriculum-records",
          title: "Curriculum, cadence, and records",
          placeholder:
            "This section will outline the curriculum, set the training cadence, and provide a records template so you can show the training actually happened.",
        },
      ],
    },
    {
      slug: "aia-provider-conformity-roadmap",
      title: "Provider Conformity Roadmap",
      stub: true,
      sections: [
        {
          id: "roadmap",
          title: "Conformity roadmap",
          placeholder:
            "If you become a provider of a high-risk AI system, this one-page roadmap will note what Articles 15 (accuracy, robustness, cybersecurity), 17 (quality management system), 43 (conformity assessment), 47 (EU declaration of conformity), and 49 (registration) require. Full conformity is a project of its own; engage a notified-body-experienced advisor before committing to a timeline.",
        },
      ],
    },
  ],
  bank: [
    {
      id: "E-01",
      prompt:
        "Are you established in the EU, do you sell into it, or could your AI outputs be used there?",
      why: "If the EU AI Act does not reach you, the honest deliverable is a documented non-applicability memo, and we can keep this short.",
      feeds: [
        "aia-applicability-memo#company-profile",
        "aia-applicability-memo#eu-nexus",
        "aia-applicability-memo#determination",
      ],
      suggestions: [
        "We have an EU entity",
        "We sell to EU customers",
        "No EU connection I know of",
      ],
      required: true,
    },
    {
      id: "E-02",
      prompt:
        "For each AI system: did you develop it, substantially modify it, or put your name on it, or do you simply use someone else's?",
      why: "Provider and deployer obligations are very different, and this answer sorts every system into the right lane.",
      feeds: [
        "aia-applicability-memo#role-determination",
        "aia-provider-conformity-roadmap#roadmap",
      ],
      suggestions: [
        "We only use vendor tools",
        "We built one system ourselves",
        "We white-label a vendor product",
      ],
      required: true,
    },
    {
      id: "E-03",
      prompt:
        "Do any of your systems influence decisions about employment, education, credit, insurance, essential services, or law enforcement?",
      why: "These are the domains where the Act's high-risk rules concentrate, so a yes changes the depth of everything that follows.",
      feeds: [
        "aia-classification-register#register",
        "aia-provider-conformity-roadmap#roadmap",
      ],
      suggestions: ["Yes, hiring tools", "Possibly, credit scoring", "None of those"],
      required: true,
    },
    {
      id: "E-04",
      prompt:
        "Do you use biometrics, emotion recognition, or any kind of social scoring?",
      why: "These uses sit closest to the Act's prohibited practices, so we screen them explicitly rather than assume.",
      feeds: [
        "aia-prohibited-screening#screening-checklist",
        "aia-classification-register#register",
      ],
      suggestions: ["Face recognition for access", "No, none of that"],
      required: true,
    },
    {
      id: "E-05",
      prompt:
        "Do users interact with your AI directly, like a chatbot, or do you publish AI-generated images, audio, video, or text?",
      why: "These are the triggers for the Act's transparency duties, and the fix is usually a sentence of disclosure copy.",
      feeds: ["aia-transparency-oversight#art50-disclosures"],
      suggestions: [
        "A customer-facing chatbot",
        "AI-generated marketing images",
        "Neither",
      ],
      required: true,
    },
    {
      id: "E-06",
      prompt:
        "Are you a public body, or do you provide public services, credit, or life or health insurance?",
      why: "Those roles trigger a fundamental rights impact assessment before deploying high-risk AI.",
      feeds: ["aia-deployer-procedure#fria"],
      suggestions: ["No", "Yes, we are a lender", "We serve public-sector clients"],
      required: true,
    },
    {
      id: "E-07",
      prompt:
        "Roughly when did each system go to market in the EU, or when will it?",
      why: "Timing determines which obligations bite when, including any grandfathering for systems already on the market.",
      feeds: ["aia-applicability-memo#timeline"],
      required: true,
    },
    {
      id: "E-08",
      prompt:
        "Describe how you manage risk during development today. Is any of it written down?",
      why: "The Act expects providers to run a documented, continuous risk process, so we start from what you already do.",
      feeds: ["aia-risk-mgmt-system#process"],
      required: false,
    },
    {
      id: "E-09",
      prompt:
        "Where does your training data come from, and how do you check its quality and bias?",
      why: "Data governance is the provider obligation regulators can test most concretely, so vague answers show.",
      feeds: ["aia-data-tech-docs#data-governance"],
      required: false,
    },
    {
      id: "E-10",
      prompt:
        "What does the system log automatically, and how long do you keep those logs?",
      why: "Logs are the evidence trail for everything else, and the Act expects logging to be designed in.",
      feeds: ["aia-data-tech-docs#logging"],
      required: false,
    },
    {
      id: "E-11",
      prompt: "What documentation ships to your customers and users today?",
      why: "The Act turns your user documentation into a compliance artifact with a required content list.",
      feeds: [
        "aia-transparency-oversight#instructions-for-use",
        "aia-data-tech-docs#technical-documentation",
      ],
      required: false,
    },
    {
      id: "E-12",
      prompt:
        "If something went seriously wrong with your system in the field, how would you find out, and how would you report it?",
      why: "Serious-incident reporting runs on statutory clocks, so the finding-out part has to work before the deadline matters.",
      feeds: ["aia-pmm-incidents#pmm-plan", "aia-pmm-incidents#serious-incidents"],
      required: false,
    },
    {
      id: "E-13",
      prompt:
        "Have you read the provider's instructions for use for each system, and who monitors the system in operation?",
      why: "Following the provider's instructions and monitoring operation are the first duties of every deployer.",
      feeds: [
        "aia-deployer-procedure#operating-duties",
        "aia-deployer-procedure#log-retention",
      ],
      required: true,
    },
    {
      id: "E-14",
      prompt:
        "Who is the designated human overseer for each system, and what authority do they have to intervene?",
      why: "Oversight only counts if the overseer has real authority to pause or stop the system.",
      feeds: [
        "aia-transparency-oversight#human-oversight",
        "aia-deployer-procedure#operating-duties",
      ],
      required: true,
    },
    {
      id: "E-15",
      prompt:
        "Will any AI system monitor workers or make decisions about them?",
      why: "Workplace AI triggers a duty to inform workers and their representatives before deployment.",
      feeds: ["aia-deployer-procedure#operating-duties"],
      suggestions: ["Yes, productivity monitoring", "Only scheduling", "No"],
      required: true,
    },
    {
      id: "E-16",
      prompt:
        "Do you build or fine-tune general-purpose or foundation models yourselves?",
      why: "General-purpose model providers have their own chapter of obligations that this document set does not cover, so a yes gets a referral note.",
      feeds: ["aia-applicability-memo#role-determination"],
      suggestions: ["No", "We fine-tune open models", "Yes, we train our own"],
      required: true,
    },
    {
      id: "E-17",
      prompt:
        "What AI training have your staff had, and whose jobs touch AI systems?",
      why: "AI literacy is one of the Act's broadest duties: it applies to everyone who puts AI in front of staff.",
      feeds: ["aia-literacy-plan#training-matrix", "aia-literacy-plan#curriculum-records"],
      required: true,
    },
    {
      id: "E-18",
      prompt:
        "Who internally owns AI Act compliance and keeps an eye on the deadlines?",
      why: "The obligations phase in over time, and someone has to own the calendar or the dates arrive unannounced.",
      feeds: ["aia-applicability-memo#timeline", "aia-pmm-incidents#pmm-plan"],
      suggestions: ["Our legal counsel", "The CTO for now", "Nobody yet"],
      required: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// iso_42001: ten documents (paraphrase and cite clause/control numbers only;
// never reproduce ISO text: the standard is copyrighted)
// ---------------------------------------------------------------------------

const ISO_42001: KindBlueprint = {
  kind: "iso_42001",
  title: "ISO/IEC 42001 AIMS Document Set",
  docs: [
    {
      slug: "aims-scope-context",
      title: "AIMS Scope and Context (Clause 4)",
      sections: [
        {
          id: "context-issues",
          title: "Internal and external issues",
          placeholder:
            "This section will record the internal and external issues that shape your AI risk under clause 4.1: customer pressure, regulation, competition, and past incidents.",
        },
        {
          id: "interested-parties",
          title: "Interested parties and their requirements",
          placeholder:
            "This section will hold a table of who cares about your AI use and what they expect, per clause 4.2: customers, regulators, employees, investors.",
        },
        {
          id: "scope-statement",
          title: "Scope statement",
          placeholder:
            "This section will state what your AI management system covers and what it excludes, with justification, per clauses 4.3 and 4.4, including your role as developer, provider, or user of AI.",
        },
      ],
    },
    {
      slug: "ai-policy",
      title: "AI Policy (Clause 5.2)",
      sections: [
        {
          id: "leadership-commitment",
          title: "Leadership commitment",
          placeholder:
            "This section will record top management's commitment to the AI policy, to meeting applicable requirements, and to continual improvement, per clause 5.2.",
        },
        {
          id: "policy-principles",
          title: "Policy principles",
          placeholder:
            "This section will state the principles your AI policy commits to publicly, chosen and worded in the interview and aligned to your business objectives.",
        },
        {
          id: "communication-review",
          title: "Communication and review triggers",
          placeholder:
            "This section will describe how the policy is communicated and what forces a review: planned intervals and significant change, per Annex A control A.2.4.",
        },
      ],
    },
    {
      slug: "aims-roles",
      title: "Roles, Responsibilities and Concern Reporting (Clause 5.3)",
      sections: [
        {
          id: "role-assignments",
          title: "Role assignments",
          placeholder:
            "This section will hold the role assignment table for the AIMS per clause 5.3: who owns it day to day, who audits it, and how duties are separated.",
        },
        {
          id: "concern-reporting",
          title: "Concern reporting",
          placeholder:
            "This section will describe how anyone can raise an AI concern, per Annex A control A.3.3: a confidential channel, a non-retaliation commitment, and a handling turnaround.",
        },
      ],
    },
    {
      slug: "ai-risk-methodology",
      title: "AI Risk Assessment and Treatment Methodology (Clause 6.1)",
      sections: [
        {
          id: "criteria",
          title: "Risk criteria",
          placeholder:
            "This section will set your AI risk criteria: likelihood and impact scales and acceptance criteria, per clauses 6.1.1 and 6.1.2, reusing an existing scale if you have one.",
        },
        {
          id: "assessment-process",
          title: "Assessment process",
          placeholder:
            "This section will describe how AI risks are identified and assessed, per clauses 6.1.2 and 8.2, seeded from the risk sources the standard's guidance highlights, such as environment complexity, level of automation, and machine learning factors.",
        },
        {
          id: "treatment",
          title: "Risk treatment",
          placeholder:
            "This section will describe treatment options and risk owner assignment per clauses 6.1.3 and 8.3, and how residual risk gets accepted and by whom.",
        },
      ],
    },
    {
      slug: "ai-impact-assessment",
      title: "AI System Impact Assessment Procedure (Clause 6.1.4)",
      sections: [
        {
          id: "triggers",
          title: "When an assessment is required",
          placeholder:
            "This section will define when an AI system impact assessment is required under clauses 6.1.4 and 8.4, keyed to the systems you flagged as significantly affecting individuals, groups, or society.",
        },
        {
          id: "assessment-template",
          title: "Assessment template",
          placeholder:
            "This section will hold the assessment template: consequences for individuals, groups, and society across fairness, safety, privacy, and transparency, with a sign-off block. ISO/IEC 42005 offers extended guidance if you want to go deeper.",
        },
      ],
    },
    {
      slug: "aims-objectives-soa",
      title: "AI Objectives and Statement of Applicability",
      sections: [
        {
          id: "objectives",
          title: "AI objectives",
          placeholder:
            "This section will record your measurable AI objectives with owners and target dates, per clause 6.2.",
        },
        {
          id: "soa",
          title: "Statement of Applicability",
          placeholder:
            "This section will hold your Statement of Applicability, required by clause 6.1.3 + 6.2: each of the Annex A controls marked included or excluded, with justification, implementation status, and an evidence pointer.",
        },
      ],
    },
    {
      slug: "ai-lifecycle-procedure",
      title: "AI System Lifecycle Procedure (Annex A.6)",
      sections: [
        {
          id: "development-requirements",
          title: "Development objectives and requirements",
          placeholder:
            "This section will describe responsible development objectives, requirements capture, and design and development records for AI systems, per the Annex A.6 lifecycle controls.",
        },
        {
          id: "verification-deployment",
          title: "Verification, validation, and deployment",
          placeholder:
            "This section will set verification and validation criteria and the deployment plan and sign-off, so nothing ships untested or unowned.",
        },
        {
          id: "operation-monitoring",
          title: "Operation, monitoring, and retirement",
          placeholder:
            "This section will cover operation and monitoring, repair, update, and retirement, plus the technical documentation and event logs each system keeps.",
        },
        {
          id: "responsible-use",
          title: "Responsible use of AI systems",
          placeholder:
            "This section will set the rules for responsible use of your AI systems, per Annex A objective A.9, connecting lifecycle discipline to how the systems are actually used day to day.",
        },
      ],
    },
    {
      slug: "ai-data-management",
      title: "Data Management for AI (Annex A.7)",
      sections: [
        {
          id: "acquisition-quality",
          title: "Data acquisition and quality",
          placeholder:
            "This section will set data acquisition rules and quality criteria for AI data, per the Annex A.7 controls, with named responsibility for data quality.",
        },
        {
          id: "provenance-preparation",
          title: "Provenance, preparation, and rights",
          placeholder:
            "This section will describe provenance recording, preparation and labeling standards, and the privacy and rights checks that run before data is used.",
        },
      ],
    },
    {
      slug: "aims-support-comms",
      title: "Competence, Awareness and Communication (Clause 7)",
      sections: [
        {
          id: "competence-training",
          title: "Competence and training",
          placeholder:
            "This section will hold the competence matrix and training records approach per clauses 7.2 and 7.3, reusing an existing training program where possible.",
        },
        {
          id: "documented-information",
          title: "Documented information control",
          placeholder:
            "This section will describe documented-information control per clause 7.5: naming, versioning, approval, and retention, reusing your existing ISO document control if you already run one.",
        },
        {
          id: "external-communication",
          title: "Information for interested parties",
          placeholder:
            "This section will describe what you tell interested parties: system documentation for users and incident communication per the Annex A.8 controls, and supplier and customer requirement flow-downs per Annex A.10.",
        },
      ],
    },
    {
      slug: "aims-performance-improvement",
      title: "Internal Audit, Management Review and Improvement (Clauses 9-10)",
      sections: [
        {
          id: "monitoring-measurement",
          title: "Monitoring and measurement",
          placeholder:
            "This section will set what the AIMS itself measures and monitors under clause 9.1, and who reviews the results.",
        },
        {
          id: "internal-audit",
          title: "Internal audit program",
          placeholder:
            "This section will hold the internal audit program under clause 9.2, with a sample audit checklist and an auditor who is independent of the work being audited.",
        },
        {
          id: "management-review",
          title: "Management review",
          placeholder:
            "This section will hold the management review agenda under clause 9.3, with the required inputs and outputs and the date of the first review.",
        },
        {
          id: "improvement",
          title: "Nonconformity and improvement",
          placeholder:
            "This section will hold the nonconformity and corrective action log under clause 10, so problems get fixed at the root and the fix gets checked.",
        },
      ],
    },
  ],
  bank: [
    {
      id: "I-01",
      prompt:
        "What outcome do you want from this: certification-ready, ready for customer questionnaires, or internal discipline?",
      why: "Your goal calibrates how deep every document needs to go, and we say so in the scope rationale.",
      feeds: ["aims-scope-context#scope-statement"],
      suggestions: [
        "Certification-ready",
        "Customer questionnaires",
        "Internal discipline first",
      ],
      required: true,
    },
    {
      id: "I-02",
      prompt:
        "What internal and external pressures drive AI risk for you: customers, regulators, competitors, past incidents?",
      why: "The management system is judged against your context, so we write down what is actually pushing on you.",
      feeds: ["aims-scope-context#context-issues"],
      required: true,
    },
    {
      id: "I-03",
      prompt:
        "Who cares about how you use AI, and what do they expect? Think customers, regulators, employees, investors.",
      why: "Interested parties and their expectations are the anchor every auditor checks first.",
      feeds: ["aims-scope-context#interested-parties"],
      required: true,
    },
    {
      id: "I-04",
      prompt:
        "Are you a developer, a provider, or a user of AI systems, or some mix of those?",
      why: "Your role drives which controls apply by default in the Statement of Applicability.",
      feeds: ["aims-scope-context#scope-statement", "aims-objectives-soa#soa"],
      suggestions: ["We only use AI", "We build and sell AI", "A mix of both"],
      required: true,
    },
    {
      id: "I-05",
      prompt:
        "What should the management system cover: the whole organization, one product line, or one legal entity?",
      why: "A tight, honest scope is easier to run and to certify than an ambitious one you cannot evidence.",
      feeds: ["aims-scope-context#scope-statement"],
      required: true,
    },
    {
      id: "I-06",
      prompt:
        "Which three to five principles should your AI policy commit to publicly? Think fairness, transparency, safety, privacy, accountability, human oversight.",
      why: "These principles become the public spine of the policy, so they should be ones you will actually defend.",
      feeds: ["ai-policy#policy-principles"],
      suggestions: [
        "Fairness, privacy, oversight",
        "Safety and transparency",
        "Help me choose",
      ],
      required: true,
    },
    {
      id: "I-07",
      prompt:
        "Who counts as top management here, and who will own the management system day to day?",
      why: "The standard holds top management personally to the policy, and a day-to-day owner keeps it breathing.",
      feeds: ["ai-policy#leadership-commitment", "aims-roles#role-assignments"],
      required: true,
    },
    {
      id: "I-08",
      prompt:
        "How can staff raise AI concerns today, and can they do it confidentially?",
      why: "A confidential concern channel is a required control, and it is also how you hear about problems early.",
      feeds: ["aims-roles#concern-reporting"],
      suggestions: ["An ethics hotline", "Just tell your manager", "Nothing formal yet"],
      required: true,
    },
    {
      id: "I-09",
      prompt:
        "Do you already run ISO 27001, ISO 9001, or a similar management system?",
      why: "Reusing your existing audit program, document control, and management review saves months of duplicated machinery.",
      feeds: [
        "aims-support-comms#documented-information",
        "aims-performance-improvement#internal-audit",
      ],
      suggestions: ["Yes, ISO 27001", "SOC 2 audited", "No management system yet"],
      required: true,
    },
    {
      id: "I-10",
      prompt:
        "How do you rate risks today? Is there an existing likelihood and impact scale we can reuse?",
      why: "Reusing a scale people already understand makes AI risk comparable with every other risk you track.",
      feeds: ["ai-risk-methodology#criteria"],
      required: true,
    },
    {
      id: "I-11",
      prompt:
        "Which of your AI systems could significantly affect individuals or groups, such as decisions about people, safety, or content at scale?",
      why: "Those systems need documented impact assessments, and the answer shapes the applicability of several controls.",
      feeds: ["ai-impact-assessment#triggers", "aims-objectives-soa#soa"],
      required: true,
    },
    {
      id: "I-12",
      prompt:
        "Walk me through how an AI feature goes from idea to production at your company.",
      why: "The lifecycle procedure should document how you really work, tightened, not an imaginary process.",
      feeds: ["ai-lifecycle-procedure#development-requirements"],
      required: true,
    },
    {
      id: "I-13",
      prompt:
        "How are models and AI features tested and signed off before release?",
      why: "Verification, validation, and a named sign-off are the controls auditors probe hardest in the lifecycle.",
      feeds: ["ai-lifecycle-procedure#verification-deployment"],
      required: true,
    },
    {
      id: "I-14",
      prompt:
        "Where does your AI data come from, and who is responsible for its quality?",
      why: "Data provenance and quality ownership are the foundation of every downstream AI control.",
      feeds: [
        "ai-data-management#acquisition-quality",
        "ai-data-management#provenance-preparation",
      ],
      required: true,
    },
    {
      id: "I-15",
      prompt:
        "What do you tell users and customers about your AI systems today?",
      why: "What you communicate externally is itself controlled, and gaps here surface as customer complaints.",
      feeds: ["aims-support-comms#external-communication"],
      required: true,
    },
    {
      id: "I-16",
      prompt:
        "Which AI suppliers do you depend on, and do your contracts cover your AI requirements?",
      why: "Supplier flow-downs are how your requirements survive leaving the building.",
      feeds: [
        "aims-support-comms#external-communication",
        "aims-objectives-soa#soa",
      ],
      required: true,
    },
    {
      id: "I-17",
      prompt:
        "What would success look like in 12 months? Pick two or three measurable AI objectives.",
      why: "Measurable objectives with owners and dates are what turn the policy from words into a plan.",
      feeds: ["aims-objectives-soa#objectives"],
      suggestions: [
        "Zero AI data incidents",
        "All AI systems inventoried",
        "First internal audit done",
      ],
      required: true,
    },
    {
      id: "I-18",
      prompt:
        "Who could run internal audits, and when should the first management review happen?",
      why: "An audit date and a review date on the calendar are what make the system real rather than aspirational.",
      feeds: [
        "aims-performance-improvement#internal-audit",
        "aims-performance-improvement#management-review",
      ],
      required: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const BLUEPRINTS: Record<GovernanceKind, KindBlueprint> = {
  usage_policy: USAGE_POLICY,
  ffiec_aup: FFIEC_AUP,
  nist_ai_rmf: NIST_AI_RMF,
  eu_ai_act: EU_AI_ACT,
  iso_42001: ISO_42001,
};

/** Instantiate the kind's scaffold documents (deep copies, fresh per call). */
export function scaffoldDocuments(kind: GovernanceKind): GovernanceDoc[] {
  return BLUEPRINTS[kind].docs.map((doc) => ({
    slug: doc.slug,
    title: doc.title,
    stub: doc.stub ?? false,
    sections: doc.sections.map((s) => ({
      id: s.id,
      title: s.title,
      markdown: s.placeholder,
    })),
  }));
}

/** The doc-slug allowlist for a kind (op targets must be in this set). */
export function docSlugAllowlist(kind: GovernanceKind): Set<string> {
  return new Set(BLUEPRINTS[kind].docs.map((d) => d.slug));
}

/**
 * Sections still holding untouched blueprint scaffold text, as docSlug ->
 * [sectionId]. Host-computed by EXACT string equality against this file's
 * placeholders: scaffolds copy them verbatim and only model ops (which are
 * sanitized, so never byte-identical meta-language) rewrite them, so the
 * test is deterministic and no model output can spoof "drafted". Never use
 * a prefix heuristic here; that would be model-influencible. Editing a
 * placeholder string above makes existing rows fail OPEN for that section
 * (treated as drafted, never a lockout), bounded by the 30-day retention.
 * Stub docs are skipped: their sections stay scaffold by design until an
 * answer activates them, and their pending/determined state is carried by
 * the presence of a "determination" section instead.
 */
export function placeholderSectionMap(
  kind: GovernanceKind,
  documents: GovernanceDoc[]
): Record<string, string[]> {
  const byDoc = new Map(BLUEPRINTS[kind].docs.map((d) => [d.slug, d]));
  const out: Record<string, string[]> = {};
  for (const doc of documents) {
    if (doc.stub) continue;
    const bp = byDoc.get(doc.slug);
    if (!bp) continue;
    for (const sec of doc.sections) {
      const outline = bp.sections.find((s) => s.id === sec.id);
      if (outline && sec.markdown === outline.placeholder)
        (out[doc.slug] ??= []).push(sec.id);
    }
  }
  return out;
}

/** True when a stub doc has recorded its determination (set_stub writes a
 * "determination" section; no stub blueprint ships one). */
export function stubDetermined(doc: GovernanceDoc): boolean {
  return doc.stub && doc.sections.some((s) => s.id === "determination");
}

/** Bank ids counted toward interview progress (branch questions excluded). */
export function requiredBankIds(kind: GovernanceKind): string[] {
  return BLUEPRINTS[kind].bank.filter((q) => q.required).map((q) => q.id);
}

/** Bank lookup by id, in a fresh Map per call. */
export function bankById(kind: GovernanceKind): Map<string, BankQuestion> {
  return new Map(BLUEPRINTS[kind].bank.map((q) => [q.id, q]));
}
