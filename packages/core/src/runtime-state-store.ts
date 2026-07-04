import type { PersistentState } from "../../contracts/src/index";

export type RuntimeStateStore = {
  init(): Promise<void>;
  read(): Promise<PersistentState>;
  write(mutator: (state: PersistentState) => PersistentState | Promise<PersistentState>): Promise<void>;
  close(): Promise<void>;
};
