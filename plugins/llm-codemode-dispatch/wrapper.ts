export interface WrapResult {
  wrapped: string;
  transpileError?: string;
}

const FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bimport\s+[^(]/, label: "static import disallowed" },
  { re: /\bimport\s*\(/, label: "dynamic import() disallowed" },
  { re: /\beval\s*\(/, label: "eval() disallowed" },
  { re: /\bnew\s+Function\s*\(/, label: "new Function() disallowed" },
  { re: /(^|[^.\w])Function\s*\(/, label: "Function() disallowed" },
  { re: /\brequire\s*\(/, label: "require() disallowed" },
];

function checkForbidden(code: string): string | undefined {
  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(code)) return label;
  }
  return undefined;
}

function trySyntaxCheck(code: string): string | undefined {
  try {
    // Bun.Transpiler is available in Bun runtime AND inside workers.
    const t = new (globalThis as any).Bun.Transpiler({ loader: "ts" });
    t.transformSync(code);
    return undefined;
  } catch (err) {
    return String((err as Error).message ?? err);
  }
}

/** Find the last expression statement inside a block (between the outermost braces). */
function rewriteLastExprInBlock(block: string): string | null {
  // block is the content of a { ... } including the braces
  const trimmed = block.trimEnd();
  if (!trimmed.endsWith("}")) return null;
  // Find the matching opening {
  let depth = 0;
  let openIdx = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) { openIdx = i; break; }
    }
  }
  if (openIdx === -1) return null;
  const before = trimmed.slice(0, openIdx);
  const inner = trimmed.slice(openIdx + 1, trimmed.length - 1);
  const rewrittenInner = rewriteTrailingExpression(inner);
  if (rewrittenInner === inner) return null; // no change
  return `${before}{${rewrittenInner}}`;
}

function rewriteTrailingExpression(code: string): string {
  // Heuristic: split on top-level statements by scanning balanced braces/parens
  // and locating the final `;` or newline-terminated unit. If the final unit
  // looks like a bare expression (no leading keyword like const/let/var/if/for/while/return/throw/try/{), wrap in return.
  let trimmed = code.replace(/\s+$/, "");
  if (trimmed.length === 0) return code;
  // Strip a single trailing semicolon so that `expr;` at end is treated as `expr`.
  if (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1).trimEnd();
  if (trimmed.length === 0) return code;
  // Find the start of the last top-level statement.
  let depth = 0, inStr: string | null = null, lastBoundary = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const prev = trimmed[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === ";" || ch === "\n")) lastBoundary = i + 1;
  }
  const head = trimmed.slice(0, lastBoundary);
  let tail = trimmed.slice(lastBoundary).trim();
  if (tail.endsWith(";")) tail = tail.slice(0, -1).trim();
  if (!tail) return code;
  // If the tail is a plain expression (no leading keyword), return-wrap it.
  if (!/^(const|let|var|if|for|while|do|switch|return|throw|try|function|class|\{|import|export)\b/.test(tail)) {
    return `${head}return (${tail});`;
  }
  // Special case: try/catch block ending with `} catch(...) { expr }` —
  // rewrite the last expression inside the catch body.
  if (/^try\b/.test(tail) && tail.endsWith("}")) {
    const rewritten = rewriteLastExprInBlock(tail);
    if (rewritten) return `${head}${rewritten}`;
  }
  return code;
}

export function wrapCode(userCode: string): WrapResult {
  const forbidden = checkForbidden(userCode);
  if (forbidden) return { wrapped: "", transpileError: forbidden };

  const syn = trySyntaxCheck(userCode);
  if (syn) return { wrapped: "", transpileError: syn };

  const rewritten = rewriteTrailingExpression(userCode);
  const wrapped = `(async () => {\n${rewritten}\n})()`;
  return { wrapped };
}
