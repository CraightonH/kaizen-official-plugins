import type { FieldSchema, ConfigResolutionSource, CompletionItem } from "llm-contracts/public";

const SECRET_MASK = "***";
const UNSET_MARKER = "(unset)";
const ERROR_MARKER = "(error)";
const ELLIPSIS = "…";

export function formatValue(
  value: unknown,
  field: FieldSchema,
  opts: { max: number },
): string {
  if (value === null || value === undefined) return UNSET_MARKER;
  if (field.type === "string" && field.secret) return SECRET_MASK;

  let rendered: string;
  try {
    if (typeof value === "string") rendered = value;
    else if (typeof value === "number" || typeof value === "boolean") rendered = String(value);
    else rendered = JSON.stringify(value);
  } catch {
    return ERROR_MARKER;
  }

  if (rendered.length > opts.max) {
    return rendered.slice(0, opts.max - 1) + ELLIPSIS;
  }
  return rendered;
}

const TRUNCATE_MAX = 30;
const CHECK_GLYPH = "✓ ";

export type RenderInputs = {
  key: string;
  field: FieldSchema;
  currentValue: unknown;
  source: ConfigResolutionSource;
  isSet: boolean;
};

function typeTag(field: FieldSchema): string {
  if (field.type === "string" && field.secret) return "string · secret";
  return field.type;
}

function isFreeForm(field: FieldSchema): boolean {
  if (field.type === "number") return true;
  if (field.type === "string" && !field.enum && !field.secret) return true;
  return false;
}

function canPrefill(input: RenderInputs, rendered: string): boolean {
  if (input.source === "env") return false;
  if (input.field.type === "string" && input.field.secret) return false;
  if (!isFreeForm(input.field)) return false;
  if (/\s/.test(rendered)) return false;
  if (rendered.startsWith("--")) return false;
  return true;
}

export function renderFieldRow(input: RenderInputs): CompletionItem {
  const tag = typeTag(input.field);
  const isUnset = input.currentValue === null || input.currentValue === undefined;

  let detail: string;
  if (isUnset) {
    detail = `(unset)  ${tag}`;
  } else {
    const display = formatValue(input.currentValue, input.field, { max: TRUNCATE_MAX });
    detail = `${CHECK_GLYPH}${display} · ${input.source}  ${tag}`;
  }

  let insertText = `${input.key}=`;
  if (!isUnset) {
    const fullRendered =
      typeof input.currentValue === "string"
        ? input.currentValue
        : typeof input.currentValue === "number" || typeof input.currentValue === "boolean"
          ? String(input.currentValue)
          : "";
    if (canPrefill(input, fullRendered)) {
      insertText = `${input.key}=${fullRendered} `;
    }
  }

  return { label: input.key, insertText, detail };
}

const NO_CHECK_PAD = "  ";

function enumValues(field: FieldSchema): readonly string[] | null {
  if (field.type === "enum") return field.values;
  if (field.type === "string" && field.enum) return field.enum;
  return null;
}

function valueRow(
  key: string,
  value: string,
  isCurrent: boolean,
  typeTagStr: string,
): CompletionItem {
  const prefix = isCurrent ? CHECK_GLYPH : NO_CHECK_PAD;
  return {
    label: `${prefix}${value}`,
    insertText: `${key}=${value} `,
    detail: typeTagStr,
  };
}

export function renderValueRows(input: RenderInputs, valueQuery: string): CompletionItem[] {
  const tag = typeTag(input.field);
  const current = input.currentValue;

  if (input.field.type === "boolean") {
    const all = ["true", "false"];
    return all
      .filter((v) => v.startsWith(valueQuery))
      .map((v) => valueRow(input.key, v, current === (v === "true"), tag));
  }

  const enumVals = enumValues(input.field);
  if (enumVals) {
    return enumVals
      .filter((v) => v.startsWith(valueQuery))
      .map((v) => valueRow(input.key, v, current === v, tag));
  }

  return [];
}
