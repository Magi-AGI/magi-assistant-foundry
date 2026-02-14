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
}

export interface FateRollResult {
  formula: string;
  diceValues: number[];
  modifier: number;
  total: number;
  skillName: string;
  ladder: string;
}
