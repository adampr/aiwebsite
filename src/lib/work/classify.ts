// Submission-kind inference for §5.16 team work submissions (owner directive
// 2026-08-28: "no longer ask if it's CoWork or Code program. Figure out which
// is based on what was uploaded").
//
// Before this module the kind was a RADIO BUTTON on the form and a `Kind:`
// line in an email, and the person submitting picked it. They picked it
// wrong often enough to matter: on 2026-08-28 three of the 85 rows on
// production were filed as CoWork Skills while the uploaded package was a
// Claude Code program (a Python service with src/ and tests/ and its own
// architecture.md; a node client/server app with two package.json files and a
// start.bat; a PowerShell utility with a Run.cmd launcher). Each carried a
// SKILL.md somewhere in the tree, which is exactly why a human reading their
// own upload called it a Skill.
//
// So the package decides now, and nobody is asked. This module is the whole
// decision, kept pure and separate from extract.ts for three reasons: the
// reclassification script (scripts/work-kind-reclassify.ts) must reach the
// SAME verdict from a stored file_manifest_json without any archive bytes to
// walk; scripts/work-tests.ts can exercise every rung without building a zip;
// and a verdict that has to be defended to a submitter needs its reasoning as
// data, not as a comment.
//
// DETERMINISTIC, never a model call. The brain is already on the critical
// path of a submission (the editorial panel), and adding a second inference
// with its own latency and its own failure mode to the UPLOAD path would mean
// a person watching a spinner while a language model decides which radio
// button they would have clicked. Every rung below is a path test.

import { BOILERPLATE_MD_BASENAMES, type WorkKind } from "./config";

/** Ordered rungs. The name is stable and is written into logs, the receipt
 * copy and the reclassification report, so a verdict can always be traced to
 * the rung that produced it. One name decides at TWO placements:
 * `program_scaffolding` straddles `skill_package` (an unambiguously named
 * architecture doc outranks the extension; a launcher, CLAUDE.md and the
 * looser doc names do not - see the ordering note on classifyWorkKind), and
 * both placements report the same name because the rule is the same rule. */
export type KindRule =
  | "bare_document"
  | "claude_code_project"
  | "skill_package"
  | "program_scaffolding"
  | "wrapped_skill_package"
  | "skill_document"
  | "skill_document_weak"
  | "program_dependencies"
  | "program_source"
  | "sole_document"
  | "wrapped_archive"
  | "default_program";

export interface KindVerdict {
  kind: WorkKind;
  /** Which rung decided. */
  rule: KindRule;
  /** Human-readable evidence, most specific first, capped at 4. Rendered to
   * the submitter when an inferred kind is what refused them, so these read
   * as file facts ("a .claude folder"), never as jargon. NOUN PHRASES only:
   * the sentence builder joins them after "because it has", so a clause here
   * produces broken copy. A rung whose evidence is not a thing the package
   * HAS (an absence, or a fact about the upload itself) sets `note` instead.
   */
  reasons: string[];
  /** Evidence that is not a noun phrase: a complete clause following
   * "because". Set by the rungs that decide on an absence or on a fact about
   * the upload rather than on a file it contains. Exactly one of `reasons`
   * and `note` is ever populated. */
  note?: string;
}

export interface KindSignals {
  /** The uploaded package's filename, or null when the submission is a bare
   * .md with no archive at all (the email lane's standalone-document path). */
  packageName: string | null;
  /** Every path in the archive at the OUTER level only. Inner-archive paths
   * ("wrapper.skill!/SKILL.md") must never appear here: the classifier runs
   * BEFORE any inner archive is opened, and a rung that could only fire on
   * inner content would make the decision depend on an inflate that the
   * decision itself is supposed to authorize. */
  paths: string[];
  /** Paths of .skill/.ski/.zip entries at depth <= 1, from the central
   * directory. Name, count and declared size only; contents are not read. */
  innerArchivePaths: string[];
  /** Outer-level text files already inflated by the walk, so a rung can test
   * a document's CONTENT (the Skill front-matter signature) and not only its
   * name. Empty is fine; every rung that reads it degrades to a name test. */
  texts: { path: string; text: string }[];
}

const depthOf = (p: string): number => p.split("/").length - 1;
const baseOf = (p: string): string => p.split("/").pop() || "";
const segmentsOf = (p: string): string[] => p.split("/");

/** Directories and files that only ever exist in a Claude Code project or the
 * repository around one. A CoWork Skill package is a SKILL.md with its
 * references and scripts; it has no agent configuration, no MCP server list
 * and no CI. Checked at ANY depth: a wrapper folder is common and `.claude`
 * one level down is the same fact as `.claude` at the root. */
const AGENT_CONFIG_DIRS = new Set([".claude", ".claude-plugin"]);
const MCP_MANIFEST = /^\.mcp\.json$/i;
const CI_PATH = /(^|\/)\.github\/workflows\//i;

/** A packaged Claude Skill: the extension the CoWork export writes. ".ski" is
 * the 8.3-truncated form Windows produces when a .skill is mailed through
 * some clients (a real 2026-07 submission arrived as "OUTAGE_1.SKI"). */
const SKILL_PACKAGE_EXT = /\.(skill|ski)$/i;
const INNER_SKILL_EXT = /\.(skill|ski)$/i;

/** The architecture document the Code program lane requires. Kept in lockstep
 * with ARCH_BASENAMES in extract.ts: this rung must not call a package a
 * program on the strength of a document that extract.ts would then refuse to
 * accept as the required doc, or the submitter is told to add a file they
 * already added.
 *
 * DELIBERATELY NARROWER than extract.ts's matchesArchDoc, which also accepts a
 * README.md carrying an "Architecture" / "How it works" / "Design" heading.
 * That widening belongs to the doc RESOLVER, which runs after the kind is
 * settled and is looking for the best available document; it does not belong
 * to the CLASSIFIER, where it would sweep in Skill packages whose README
 * happens to explain how the Skill works. The asymmetry only ever costs a
 * package that some other rung already called a program: the resolver still
 * finds its README and accepts it. */
const ARCH_BASENAMES =
  /^(architecture|arch|design|readme-architecture)\.(md|mdx|markdown|txt)$/i;

/** The subset of ARCH_BASENAMES certain enough to outrank the .skill
 * extension at rung 3. "architecture.md" at a package's root is a statement
 * of what the thing is, in a name a Skill has no reason to use; "design.md"
 * and "arch.md" are looser, and a genuine CoWork Skill can plausibly ship a
 * design note under either name beside its SKILL.md. Those looser names
 * still convict at the rung-5 placement, so a .zip package classifies
 * exactly as it always did; the split only decides which evidence is strong
 * enough to override an explicit Skill export extension. */
const ARCH_BASENAMES_HOISTED =
  /^(architecture|readme-architecture)\.(md|mdx|markdown|txt)$/i;

/** Dependency and build manifests: a package that declares dependencies or a
 * build is a program. Depth <= 2 covers a wrapper folder plus one component
 * directory ("app/server/package.json"). */
const DEP_MANIFEST =
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pyproject\.toml|setup\.py|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|Makefile|CMakeLists\.txt|.+\.csproj|.+\.sln)$/i;

/** Double-clickable launchers. A Skill is invoked by Claude, never by a
 * shortcut, so a .bat/.cmd/.exe next to the documents is a program's entry
 * point. Depth <= 1 only: a launcher buried three folders down is a build
 * artifact, not the thing being submitted. */
const LAUNCHER = /\.(bat|cmd|exe|msi|app|command)$/i;

/** CLAUDE.md is project instructions for Claude Code. SKILL.md is the Skill
 * itself. The two are easy to confuse by eye and are opposite signals. */
const CLAUDE_MD = /^CLAUDE\.md$/i;

const MD_EXT = /\.(md|mdx|markdown)$/i;
const SKILL_DOC = /^skill\.md$/i;

/** Names that are never the document a package is ABOUT. IMPORTED, not
 * duplicated: extract.ts's Skill ladder demotes exactly this list when it
 * resolves a reviewed document, and rung 11 below is a prediction of what
 * that ladder will do, so the two must not drift. (config.ts is pure
 * constants with no jszip, so this module stays loadable on its own for the
 * reclassification script and the tests.) */
const BOILERPLATE_MD = BOILERPLATE_MD_BASENAMES;

/** Source files. Used only by the late `program_source` rung, and only
 * OUTSIDE a scripts/ directory: a CoWork Skill legitimately ships helper
 * scripts (the SOQL translator on production carries scripts/*.py, *.sh and
 * *.ps1 beside its SKILL.md and is a genuine Skill), so counting those as
 * program evidence would reclassify real Skills. */
const SOURCE_EXT =
  /\.(py|js|mjs|cjs|jsx|ts|tsx|ps1|psm1|sh|bash|zsh|rb|go|rs|java|cs|c|cc|cpp|h|hpp|php|swift|kt|gs|vb|pl|lua|r|sql)$/i;
const HELPER_DIR = /(^|\/)(scripts|bin|tools)\//i;

/** A leading YAML front-matter block declaring `name:` and `description:` at
 * column 0 is the Claude Skill document signature. Duplicated from
 * extract.ts's hasSkillFrontmatter rather than imported so this module stays
 * free of the jszip-importing side of the codebase and can be loaded by the
 * reclassification script and the tests on their own. scripts/work-tests.ts
 * asserts the two agree on the same inputs. */
export function hasSkillFrontmatter(text: string): boolean {
  if (!/^---\r?\n/.test(text)) return false;
  const rest = text.slice(text.indexOf("\n") + 1);
  const end = rest.search(/^---\s*$/m);
  const front = end === -1 ? rest.slice(0, 4000) : rest.slice(0, end);
  return /^name:[ \t]*\S/m.test(front) && /^description:[ \t]*\S/m.test(front);
}

function verdict(
  kind: WorkKind,
  rule: KindRule,
  reasons: string[]
): KindVerdict {
  return { kind, rule, reasons: reasons.slice(0, 4) };
}

/** A verdict whose evidence is a clause rather than a list of files. */
function noted(kind: WorkKind, rule: KindRule, note: string): KindVerdict {
  return { kind, rule, reasons: [], note };
}

/** The ONE wrapper folder a package may sit inside, or null when it does not.
 *
 * "Depth <= 1" is the rule everywhere in this pipeline, and read literally it
 * means "the root, or one folder down". That reading is wrong for a package
 * with no wrapper at all, where depth 1 is every SUBDIRECTORY: a Skill's own
 * `references/design.md` would then count as the package's architecture
 * document, call the whole thing a program, AND get resolved as the reviewed
 * doc, so the card would be written from a reference note. The intent was
 * always "one wrapper folder" (extract.ts says so in as many words), and a
 * wrapper is only a wrapper when EVERYTHING is inside it. */
function wrapperFolder(paths: string[]): string | null {
  const first = segmentsOf(paths[0] ?? "")[0];
  if (!first || paths.length === 0) return null;
  // Every path must start with that same segment, and at least one path must
  // actually be inside it rather than being the segment itself.
  if (!paths.every((p) => segmentsOf(p)[0] === first)) return null;
  return paths.some((p) => depthOf(p) >= 1) ? first : null;
}

/** A file that belongs to the package ITSELF: at the root, or directly inside
 * the single wrapper folder. Not merely "depth <= 1". */
function atPackageRoot(path: string, wrapper: string | null): boolean {
  const d = depthOf(path);
  if (d === 0) return true;
  return d === 1 && wrapper !== null && segmentsOf(path)[0] === wrapper;
}

/**
 * Decide whether an upload is a CoWork Skill or a Claude Code program.
 *
 * A LADDER, not a score. Every rung is a specific, nameable fact about the
 * files, and the first one that fires decides; nothing is weighed against
 * anything else. That is deliberate. A scoring model gives an answer nobody
 * can argue with or predict, and this answer has to survive being read back
 * to a submitter who disagrees with it ("your package has a .claude folder
 * and a package.json, so it was filed as a Code program"). A ladder also
 * makes the reclassification of historical rows reviewable one rung at a
 * time, which is how the 2026-08-28 pass was checked.
 *
 * The ORDER is the whole design, and the inversions in it are the
 * interesting part:
 *
 *  - `claude_code_project` (rung 2) outranks `skill_package` (rung 4), so a
 *    .skill file holding an agent-configured repository is a program. The
 *    extension records how a file was exported; a .claude directory records
 *    what the thing is.
 *
 *  - `program_scaffolding` decides at TWO placements, straddling the
 *    extension rung, and the split is the point. An architecture doc under
 *    one of the UNAMBIGUOUS names (ARCH_BASENAMES_HOISTED) outranks the
 *    extension (rung 3): a CoWork Skill never carries an architecture doc at
 *    its root, so the doc records what the thing is the same way `.claude`
 *    does, and the flip hands the program lane a file whose NAME that lane
 *    accepts as the required doc, so it can never end in the lane's
 *    missing-doc refusal on that count (the lane's prose floor and inflate
 *    cap still apply to the doc's content; a root architecture.md that is a
 *    stub is refused doc_too_short, an accepted residual on a shape with no
 *    corpus occurrence, and the standalone document field remains the
 *    rescue). Everything else - a launcher, CLAUDE.md, and the looser
 *    "design"/"arch" doc names a Skill can plausibly use for a design note -
 *    does NOT outrank the extension (rung 5): on a .skill export those
 *    signals either come with no document the program lane accepts (a
 *    doc-less package would be walked into a hard 422, where the Skill
 *    lane's worst case is a soft doc-missing the standalone upload can
 *    still rescue) or are too weak to override an explicit Skill export.
 *    Where the evidence leaves room for doubt, the ladder leans toward the
 *    lane a wrong answer can walk back from.
 *
 *  - `program_scaffolding` also outranks `wrapped_skill_package` (rung 6)
 *    and `skill_document` (rung 7), and that inversion is load-bearing. A
 *    Claude Code program very often CONTAINS a skill (production has a
 *    program whose zip holds both an ARCHITECTURE.md and a nested .skill, and
 *    another that ships a SKILL.md under .claude/skills/); a CoWork Skill never
 *    contains an architecture doc at its root, a dependency manifest or a
 *    double-clickable launcher. Containment points one way only, so the
 *    program evidence has to be tested first. Putting the SKILL.md rung above
 *    it is exactly the mistake the humans made.
 */
export function classifyWorkKind(signals: KindSignals): KindVerdict {
  const { packageName, paths, innerArchivePaths, texts } = signals;
  const wrapper = wrapperFolder(paths);
  const textOf = (p: string) => texts.find((t) => t.path === p)?.text ?? null;

  // 1. No archive at all: a bare .md is a Skill document by definition (the
  //    email lane's standalone path; a Code program is always a package).
  if (packageName === null)
    return noted(
      "skill",
      "bare_document",
      "the submission is a single document with no package"
    );

  // 2. Agent configuration or repository CI. Above the .skill rung on
  //    purpose: see the ordering note above.
  const agentCfg = paths.filter((p) =>
    segmentsOf(p).some((s) => AGENT_CONFIG_DIRS.has(s.toLowerCase()))
  );
  const mcp = paths.filter((p) => MCP_MANIFEST.test(baseOf(p)));
  const ci = paths.filter((p) => CI_PATH.test(p));
  if (agentCfg.length || mcp.length || ci.length)
    return verdict("program", "claude_code_project", [
      ...(agentCfg.length
        ? [
            `a ${segmentsOf(agentCfg[0]).find((s) => AGENT_CONFIG_DIRS.has(s.toLowerCase()))} folder (${agentCfg[0]})`,
          ]
        : []),
      ...(mcp.length ? [`an MCP server list (${mcp[0]})`] : []),
      ...(ci.length ? [`a CI workflow (${ci[0]})`] : []),
    ]);

  // Program scaffolding the package carries AT ITS OWN ROOT. Each of these
  // is a thing a program has and a Skill package does not. Gathered once,
  // tested at two rungs (3 and 5) that straddle the extension rung: see the
  // ordering note above. The dependency manifest is in NEITHER placement: it
  // sits below the Skill-document rungs, because a Skill that ships helper
  // scripts ships their requirements.txt with them, and convicting it on
  // that file while deliberately exempting the scripts themselves (see
  // HELPER_DIR) was self-contradictory.
  const archDoc = paths.filter(
    (p) => ARCH_BASENAMES.test(baseOf(p)) && atPackageRoot(p, wrapper)
  );
  const claudeMd = paths.filter(
    (p) => CLAUDE_MD.test(baseOf(p)) && atPackageRoot(p, wrapper)
  );
  const launcher = paths.filter(
    (p) => LAUNCHER.test(baseOf(p)) && atPackageRoot(p, wrapper)
  );
  const scaffolding = () =>
    verdict("program", "program_scaffolding", [
      ...(archDoc.length ? [`an architecture document (${archDoc[0]})`] : []),
      ...(launcher.length ? [`a launcher (${launcher[0]})`] : []),
      ...(claudeMd.length ? [`project instructions (${claudeMd[0]})`] : []),
    ]);

  // 3. An unambiguously named architecture document, above the extension
  //    rung. Only that decides this early: it is the one piece of
  //    scaffolding evidence whose flip hands the program lane a file that
  //    lane accepts by name, and whose name a Skill has no reason to use.
  if (archDoc.some((p) => ARCH_BASENAMES_HOISTED.test(baseOf(p))))
    return scaffolding();

  // 4. The package IS a Skill export. Decisive only when no unambiguous
  //    architecture doc sits at the package's own root; rung 3 has already
  //    spoken for the packages that carry one.
  if (SKILL_PACKAGE_EXT.test(packageName))
    return noted(
      "skill",
      "skill_package",
      `the package is a .${baseOf(packageName).split(".").pop()?.toLowerCase()} file`
    );

  // 5. The rest of the program scaffolding: a launcher, project
  //    instructions, or an arch doc under one of the looser names, at the
  //    package's own root. BELOW the extension rung on purpose - see the
  //    ordering note above. For every non-.skill package this placement
  //    fires exactly where the single rung used to, so nothing outside the
  //    Skill-export extension classifies differently.
  if (archDoc.length || claudeMd.length || launcher.length)
    return scaffolding();

  // 6. A wrapper zip whose payload is one packaged Skill, by NAME. Exactly
  //    one: two packaged Skills is a bundle, and a bundle is not a Skill.
  const innerSkills = innerArchivePaths.filter((p) =>
    INNER_SKILL_EXT.test(baseOf(p))
  );
  if (innerSkills.length === 1)
    return verdict("skill", "wrapped_skill_package", [
      `one packaged Skill inside the zip (${innerSkills[0]})`,
    ]);

  // 7. A document carrying the Claude Skill front-matter signature. Tested on
  //    ANY .md at the package root, not only one named SKILL.md: extract.ts's
  //    own ladder resolves a Skill's document by uniqueness and by this same
  //    signature, so a package whose doc is "patching-visualizer.md" is a
  //    Skill it accepts, and a name-only test here would send it down the
  //    program lane to a hard refusal instead.
  const rootMds = paths.filter(
    (p) => MD_EXT.test(baseOf(p)) && atPackageRoot(p, wrapper)
  );
  const signed = rootMds.filter((p) => {
    const t = textOf(p);
    return t ? hasSkillFrontmatter(t) : false;
  });
  if (signed.length)
    return verdict("skill", "skill_document", [
      `a document with Skill front matter (${signed[0]})`,
    ]);

  // 8. A file literally named SKILL.md whose front matter is missing,
  //    malformed, or simply not in the stored corpus. Still a Skill: every
  //    program rung above has missed, and that filename is the submitter's
  //    own statement of what this is.
  const namedSkillMd = rootMds.filter((p) => SKILL_DOC.test(baseOf(p)));
  if (namedSkillMd.length)
    return verdict("skill", "skill_document_weak", [
      `a file named SKILL.md (${namedSkillMd[0]})`,
    ]);

  // 9. Declared dependencies or a build. Below the Skill-document rungs by
  //    the argument at the scaffolding gather above, above the source rung
  //    because it is the stronger signal of the two.
  const manifest = paths.filter(
    (p) => DEP_MANIFEST.test(baseOf(p)) && depthOf(p) <= 2
  );
  if (manifest.length)
    return verdict("program", "program_dependencies", [
      `a dependency manifest (${manifest[0]})`,
    ]);

  // 10. Source code that is not a Skill's helper scripts.
  const source = paths.filter(
    (p) => SOURCE_EXT.test(baseOf(p)) && !HELPER_DIR.test(p)
  );
  if (source.length)
    return verdict("program", "program_source", [
      `program source outside a scripts folder (${source[0]}${source.length > 1 ? ` and ${source.length - 1} more` : ""})`,
    ]);

  // 11. One document and no code. extract.ts's Skill ladder resolves exactly
  //     this shape (a single non-boilerplate .md at the package root clearing
  //     the prose floor) and accepts it, so calling it a program here would
  //     manufacture a refusal for a package the next stage was happy with.
  const substantive = rootMds.filter((p) => !BOILERPLATE_MD.test(baseOf(p)));
  if (substantive.length === 1)
    return verdict("skill", "sole_document", [
      `one document and no program files (${substantive[0]})`,
    ]);

  // 12. A wrapper holding exactly one archive of any kind, when nothing else
  //     decided. extract.ts opens exactly this shape one level down to look
  //     for a Skill document inside it (the 2026-07-30 owner amendment: "a
  //     wrapper .zip holding the .skill and its .md must work"), and it
  //     collects `.skill` AND `.zip` for that purpose while rung 6 above can
  //     only recognise the named ones. Sending the rest down the Skill lane
  //     is what keeps that amendment working now that nobody declares a kind:
  //     the Skill ladder opens the inner archive and, if it finds nothing,
  //     returns a SOFT doc-missing the standalone upload can still rescue,
  //     where the program lane would have refused outright.
  if (innerArchivePaths.length === 1)
    return verdict("skill", "wrapped_archive", [
      `one packaged archive inside the zip (${innerArchivePaths[0]})`,
    ]);

  // 13. Nothing matched. Program, and the reason is the refusal it produces
  //     rather than the label: a package with no document and no program
  //     scaffolding is going to be refused either way, and the program lane's
  //     refusal names the architecture doc, which is the actionable one.
  return noted(
    "program",
    "default_program",
    "it carries neither a Skill document nor a program's architecture document"
  );
}


/** One sentence naming the inference, for a receipt or a refusal. Reads as
 * evidence rather than as a ruling: the submitter is told what was seen, so a
 * wrong verdict is arguable against the files rather than against the site. */
export function kindVerdictSentence(v: KindVerdict): string {
  const label = v.kind === "skill" ? "CoWork Skill" : "Code program";
  // Two shapes, because the evidence has two shapes. `reasons` are noun
  // phrases naming files the package HAS and read correctly after "it has";
  // `note` is a clause, used by the rungs that decide on an absence or on a
  // fact about the upload itself. Gluing "because it has" onto a clause
  // produced the sentence "I read your upload as a Code program, because it
  // has no Skill document and no program scaffolding was found" - broken
  // English offering the evidence AGAINST its own verdict, on the one rung
  // whose reading most needs to be arguable.
  if (v.note) return `I read your upload as a ${label}, because ${v.note}.`;
  if (!v.reasons.length) return `I read your upload as a ${label}.`;
  const list =
    v.reasons.length === 1
      ? v.reasons[0]
      : `${v.reasons.slice(0, -1).join(", ")} and ${v.reasons[v.reasons.length - 1]}`;
  return `I read your upload as a ${label}, because it has ${list}.`;
}
