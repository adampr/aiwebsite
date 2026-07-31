/**
 * @xlnet/content-model
 *
 * The typed intermediate representation, and the one package that depends on nothing.
 *
 * ARCHITECTURE.md: "packages/content-model depending on nothing is deliberate. Emitters and
 * validators both import it; nothing it imports can drag styling or database concerns into the
 * layer that is supposed to be neutral."
 */

export * from "./money";
export * from "./blocks";
export * from "./knowledge";
export * from "./pricing";
export * from "./proposal";
export * from "./ingest";
export * from "./audit";
export * from "./gate";
export * from "./page-budget";
export * from "./resolved";
export * from "./hash";
export * from "./schema";
