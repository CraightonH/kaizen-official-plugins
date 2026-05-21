import { describe, it, expect } from "bun:test";
import { createKeychainResolver, type SpawnFn, KEYCHAIN_SERVICE } from "../resolver.ts";
import { KeychainNotFoundError, KeychainLockedError } from "../errors.ts";

interface SpawnCall { cmd: string; args: string[] }

function fakeSpawn(out: { stdout?: string; exitCode: number }): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: out.stdout ?? "", stderr: "", exitCode: out.exitCode };
  };
  return { spawn, calls };
}

describe("keychain resolver", () => {
  it("declares scheme=keychain and is not read-only", () => {
    const { spawn } = fakeSpawn({ exitCode: 0 });
    const r = createKeychainResolver(spawn);
    expect(r.scheme).toBe("keychain");
    expect(r.readOnly).toBe(false);
  });

  it("get() shells out to security find-generic-password -w and trims stdout", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "tvly-abc\n", exitCode: 0 });
    const r = createKeychainResolver(spawn);
    const v = await r.get("plug/api");
    expect(v).toBe("tvly-abc");
    expect(calls[0]).toEqual({
      cmd: "security",
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "plug/api", "-w"],
    });
  });

  it("get() throws KeychainNotFoundError on exit code 44", async () => {
    const { spawn } = fakeSpawn({ exitCode: 44 });
    const r = createKeychainResolver(spawn);
    await expect(r.get("plug/missing")).rejects.toBeInstanceOf(KeychainNotFoundError);
  });

  it("get() throws KeychainLockedError on exit code 51", async () => {
    const { spawn } = fakeSpawn({ exitCode: 51 });
    const r = createKeychainResolver(spawn);
    await expect(r.get("plug/api")).rejects.toBeInstanceOf(KeychainLockedError);
  });

  it("set() shells out to security add-generic-password -U with the value", async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const r = createKeychainResolver(spawn);
    await r.set!("plug/api", "tvly-xyz");
    expect(calls[0]).toEqual({
      cmd: "security",
      args: ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "plug/api", "-w", "tvly-xyz"],
    });
  });

  it("delete() shells out to security delete-generic-password", async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const r = createKeychainResolver(spawn);
    await r.delete!("plug/api");
    expect(calls[0]).toEqual({
      cmd: "security",
      args: ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "plug/api"],
    });
  });

  it("delete() does not throw when entry is already missing (exit code 44)", async () => {
    const { spawn } = fakeSpawn({ exitCode: 44 });
    const r = createKeychainResolver(spawn);
    await r.delete!("plug/missing");
  });
});
