import { resolve, isAbsolute } from "node:path";

export function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

export function resolveDir(p: string, home: string, cwd: string): string {
  const expanded = expandTilde(p, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
