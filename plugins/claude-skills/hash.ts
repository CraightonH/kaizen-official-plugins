import { createHash } from "node:crypto";

export function contentHash(body: string): string {
  return createHash("sha1").update(body, "utf8").digest("hex");
}
