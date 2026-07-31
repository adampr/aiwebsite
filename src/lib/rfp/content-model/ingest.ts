/**
 * RFP ingest types.
 *
 * requiredStructure is captured verbatim and never normalized. Rule C4 exists because an evaluator
 * scores against their own numbering; renaming "Section 1.1" to "Overview" makes the document
 * harder to score and reads as not having read the RFP.
 */

export type Client = {
  id: string;
  name: string;
  /** As it should appear on the cover, which is not always the legal name. */
  displayName: string;
  segment: string | null;
  website: string | null;
};

export type RfpSourceKind = "pdf" | "docx" | "email-text" | "web-form";

export type StructureNode = {
  /** "Section 1.1" — the CLIENT'S label, verbatim. */
  label: string;
  /** The client's heading text, verbatim. */
  title: string;
  children: StructureNode[];
};

export type Rfp = {
  id: string;
  clientId: string;
  receivedAt: Date;
  sourceKind: RfpSourceKind;
  /** null for pasted text — pasted email is a first-class input, not a fallback. */
  sourceBlobKey: string | null;
  rawText: string;
  dueDate: Date | null;
  /** ["pdf"] — some RFPs demand specific formats. */
  submissionFormat: string[];
  requiredStructure: StructureNode[];
  /**
   * True when the RFP states a staff count rather than a supported-user count. Rule B4 requires
   * two pricing illustrations in that case, because multiplying headcount by $247 invents a number
   * the client anchors on, and it is always the largest one available.
   */
  statesHeadcountOnly: boolean;
  /** Confirmed by a human before anything is built on the extracted structure. */
  structureConfirmedAt: Date | null;
  structureConfirmedBy: string | null;
};

export type RequirementKind =
  | "narrative"
  | "factual"
  | "pricing"
  | "attachment"
  | "certification";

/**
 * Requirements are extracted atomically. One numbered ask containing three questions becomes three
 * requirements, because coverage is checked per requirement. An RFP with forty of these is normal.
 */
export type Requirement = {
  id: string;
  rfpId: string;
  /** The structure node it came from. */
  structureLabel: string;
  /** Verbatim. */
  text: string;
  ordinal: number;
  kind: RequirementKind;
  mandatory: boolean;
};

export function flattenStructure(
  nodes: StructureNode[],
  depth = 0,
): { node: StructureNode; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...flattenStructure(node.children, depth + 1),
  ]);
}

export function structureLabels(nodes: StructureNode[]): string[] {
  return flattenStructure(nodes).map(({ node }) => node.label);
}
