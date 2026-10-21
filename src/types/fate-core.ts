/** Fate Core Official system data types. */

export interface FateAspect {
  name: string;
  /** e.g. 'High Concept', 'Trouble', 'Other' */
  type: string;
  value: string;
}

export interface FateSkill {
  name: string;
  rank: number;
}

export interface FateStunt {
  name: string;
  description: string;
}

export interface FateTrack {
  name: string;
  /** Total boxes in this track */
  size: number;
  /** Which boxes are checked (0-indexed) */
  value: boolean[];
}

/** The fields the AI Director reads from d20-system actors (dnd5e, pf2e). */
export interface D20Stats {
  hp: { value: number; max: number };
  ac: number;
  level: number;
  /** Class / ancestry summary, e.g. "Rogue 3". */
  summary: string;
  /** Skill key → total modifier. */
  skills: Record<string, number>;
}

export interface FateActor {
  id: string;
  name: string;
  type: string;
  img: string;
  aspects: FateAspect[];
  skills: FateSkill[];
  stunts: FateStunt[];
  tracks: FateTrack[];
  fatePoints: number;
  refresh: number;
  /** Foundry game system id (fate-core-official, dnd5e, pf2e, …). Absent from older modules. */
  system?: string;
  /** Present for d20 systems; the Fate fields above are then empty. */
  d20?: D20Stats;
  /** True when a player (not only the GM) owns this actor. */
  playerOwned?: boolean;
}

export interface FateRollResult {
  formula: string;
  diceValues: number[];
  modifier: number;
  total: number;
  skillName: string;
  ladder: string;
}
