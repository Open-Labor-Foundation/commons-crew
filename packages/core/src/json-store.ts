import { promises as fs } from "node:fs";
import path from "node:path";
import type { PersistentState } from "../../contracts/src/index";
import type { StateStore } from "./persistence";

const sharedWriteChains = new Map<string, Promise<void>>();

export class JsonStateStore implements StateStore {
  readonly kind = "json" as const;

  constructor(
    private readonly filePath: string,
    private readonly defaults: PersistentState
  ) {}

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify(this.defaults, null, 2));
    }
  }

  async read(): Promise<PersistentState> {
    await this.init();
    await this.getWriteChain();
    return this.mergeWithDefaults(await this.readFromDisk());
  }

  async write(mutator: (state: PersistentState) => PersistentState | Promise<PersistentState>) {
    const runWrite = async () => {
      await this.init();
      const state = this.mergeWithDefaults(await this.readFromDisk());
      const next = await mutator(state);
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(next, null, 2));
      await fs.rename(tempPath, this.filePath);
    };

    const nextChain = this.getWriteChain().then(runWrite, runWrite);
    sharedWriteChains.set(this.filePath, nextChain);
    await nextChain;
  }

  async flush() {
    await this.getWriteChain();
  }

  private async readFromDisk(): Promise<PersistentState> {
    try {
      const contents = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(contents) as PersistentState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.writeFile(this.filePath, JSON.stringify(this.defaults, null, 2));
      return structuredClone(this.defaults);
    }
  }

  private getWriteChain() {
    return sharedWriteChains.get(this.filePath) ?? Promise.resolve();
  }

  private mergeWithDefaults(state: PersistentState): PersistentState {
    return {
      ...this.defaults,
      ...state,
      users: state.users ?? this.defaults.users,
      workspaceMemberships: state.workspaceMemberships ?? this.defaults.workspaceMemberships,
      promptGovernance: {
        ...this.defaults.promptGovernance,
        ...(state.promptGovernance ?? {})
      },
      providerProfiles: state.providerProfiles ?? [],
      providerCapabilitySnapshots: state.providerCapabilitySnapshots ?? [],
      configProfiles: state.configProfiles ?? [],
      featureFlags: state.featureFlags ?? [],
      promptSpecs: state.promptSpecs ?? [],
      clarifications: state.clarifications ?? [],
      clarificationThreads: state.clarificationThreads ?? [],
      clarificationMessages: state.clarificationMessages ?? [],
      runnerJobs: state.runnerJobs ?? [],
      artifacts: state.artifacts ?? [],
      incidents: state.incidents ?? [],
      migrationRecords: state.migrationRecords ?? []
    };
  }
}
