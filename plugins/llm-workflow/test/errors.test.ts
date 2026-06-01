import { describe, it, expect } from "bun:test";
import {
  MetaParseError,
  WorkerSpawnError,
  ScriptError,
  WorkflowTimeoutError,
  WorkflowAbortedError,
  WorkflowNestingError,
  AgentLifetimeCapError,
  BudgetExceededError,
  WorkflowRegistryLoadingError,
  WorkflowNotFoundError,
} from "../errors.ts";

const cases = [
  { Ctor: MetaParseError, name: "MetaParseError" },
  { Ctor: WorkerSpawnError, name: "WorkerSpawnError" },
  { Ctor: ScriptError, name: "ScriptError" },
  { Ctor: WorkflowTimeoutError, name: "WorkflowTimeoutError" },
  { Ctor: WorkflowAbortedError, name: "WorkflowAbortedError" },
  { Ctor: WorkflowNestingError, name: "WorkflowNestingError" },
  { Ctor: AgentLifetimeCapError, name: "AgentLifetimeCapError" },
  { Ctor: BudgetExceededError, name: "BudgetExceededError" },
  { Ctor: WorkflowRegistryLoadingError, name: "WorkflowRegistryLoadingError" },
  { Ctor: WorkflowNotFoundError, name: "WorkflowNotFoundError" },
];

describe("error classes", () => {
  for (const { Ctor, name } of cases) {
    it(`${name}`, () => {
      const err = new Ctor("boom");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.message).toBe("boom");
    });
  }
});
