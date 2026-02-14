export interface FoundryScene {
  id: string;
  name: string;
  active: boolean;
  width: number;
  height: number;
  gridSize: number;
  tokens: FoundryToken[];
}

export interface FoundryToken {
  id: string;
  name: string;
  actorId: string;
  x: number;
  y: number;
  hidden: boolean;
}

export interface FoundryCombat {
  id: string;
  round: number;
  turn: number;
  combatants: FoundryCombatant[];
}

export interface FoundryCombatant {
  id: string;
  actorId: string;
  name: string;
  initiative: number | null;
  defeated: boolean;
}
