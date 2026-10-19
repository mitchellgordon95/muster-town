import type { VerbInputs, VerbName } from "@agent-town/schema";

/** Parsed (defaults applied) input of a verb. */
export type VerbIn<K extends VerbName> = (typeof VerbInputs)[K]["_output"];
/** Raw input accepted by `world.verbs.<name>` (defaults optional). */
export type VerbRawIn<K extends VerbName> = (typeof VerbInputs)[K]["_input"];
