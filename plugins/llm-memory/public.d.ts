export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  created?: string;
  updated?: string;
}

export interface MemoryStoreService {
  get(name: string, opts?: { scope?: MemoryScope }): Promise<MemoryEntry | null>;
  list(filter?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]>;
  search(query: string, opts?: { scope?: MemoryScope; limit?: number }): Promise<MemoryEntry[]>;
  put(entry: MemoryEntry): Promise<void>;
  remove(name: string, scope: MemoryScope): Promise<void>;
  readIndex(scope: MemoryScope): Promise<string>;
}
