export const CALLER_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_site_info",
      description:
        "Get information about the ai.xl.net website, XL.net's AI capabilities, company details, and contact information.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ai_capabilities",
      description:
        "Get details about XL.net's specific AI tools, services, and accomplishments.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

export async function executeCallerTool(
  name: string,
  _args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "get_site_info":
      return {
        company: "XL.net",
        website: "https://xl.net",
        aiWebsite: "https://ai.xl.net",
        description:
          "XL.net is a Chicago-based managed IT services provider specializing in strategic IT for small and mid-size businesses. SOC 2 Type II and ISO 27001:2022 certified.",
        aiAssistant: "Tron Netter",
        contact: {
          email: "ai@xl.net",
          phone: "(872) 350-4325",
          phoneNote:
            "This is Tron Netter's own AI voice line — callers and texters reach Tron Netter directly, 24/7.",
          salesPhone: "+1 (844) 915-5155",
          salesPhoneNote:
            "XL.net's main sales / general-inquiries line (human team).",
          mainSite: "https://xl.net",
        },
        services: [
          "Managed IT Services",
          "24/7/365 Service Desk",
          "Cybersecurity (SOC, SIEM, MDR)",
          "Technology Officers",
          "Central Services & Monitoring",
          "System Analysis & Audits",
          "Project Engineering",
        ],
        certifications: ["SOC 2 Type II", "ISO 27001:2022"],
        stats: {
          itIssueReduction: "79.8%",
          customerSatisfaction: "99.3%",
          support: "24/7/365 live support",
        },
      };

    case "get_ai_capabilities":
      return {
        capabilities: [
          {
            name: "AI Service Desk",
            description:
              "Intelligent ticket triage, automated resolution, and proactive issue detection powered by machine learning. Most issues resolved on first contact.",
          },
          {
            name: "AI-Driven Security",
            description:
              "Continuous threat monitoring, anomaly detection, and automated incident response safeguarding client infrastructure around the clock.",
          },
          {
            name: "Predictive Analytics",
            description:
              "Data-driven insights that anticipate system failures, optimize performance, and reduce downtime before it impacts business operations.",
          },
          {
            name: "Conversational AI (Tron Netter)",
            description:
              "AI assistant available on ai.xl.net that can answer questions about XL.net's services, AI capabilities, and help visitors find the right information.",
          },
          {
            name: "Automated Audits",
            description:
              "Monthly technology audits powered by AI that identify inefficiencies, risks, and system gaps before they cause downtime or security incidents.",
          },
        ],
        philosophy:
          "XL.net takes a proactive approach built around AI and automation to reduce IT issues by 79.8% while improving overall productivity for SMBs.",
      };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
