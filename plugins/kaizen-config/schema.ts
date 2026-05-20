// plugins/kaizen-config/schema.ts
import type { ConfigSchema, FieldSchema } from "llm-contracts/public";

export type { ConfigSchema, FieldSchema };

export interface ValidationError { path: string; message: string; }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

export function validate<T>(value: unknown, schema: ConfigSchema<T>): ValidationResult<T> {
  if (!isObject(value)) return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  const errors: ValidationError[] = [];
  for (const [key, fieldSchema] of Object.entries(schema)) {
    if (!fieldSchema) continue;
    if (!(key in value)) continue;
    const v = (value as Record<string, unknown>)[key];
    walk(v, fieldSchema as FieldSchema, key, errors);
  }
  return errors.length === 0
    ? { ok: true, value: value as T }
    : { ok: false, errors };
}

function walk(value: unknown, schema: FieldSchema, path: string, errors: ValidationError[]): void {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return push(errors, path, "must be a string");
      if (schema.min !== undefined && value.length < schema.min) push(errors, path, `length < ${schema.min}`);
      if (schema.max !== undefined && value.length > schema.max) push(errors, path, `length > ${schema.max}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(errors, path, `must match /${schema.pattern}/`);
      if (schema.enum && !schema.enum.includes(value)) push(errors, path, `must be one of ${schema.enum.join(", ")}`);
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return push(errors, path, "must be a finite number");
      if (schema.integer && !Number.isInteger(value)) push(errors, path, "must be an integer");
      if (schema.min !== undefined && value < schema.min) push(errors, path, `must be >= ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) push(errors, path, `must be <= ${schema.max}`);
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") push(errors, path, "must be a boolean");
      return;
    }
    case "enum": {
      if (typeof value !== "string" || !schema.values.includes(value)) {
        push(errors, path, `must be one of ${schema.values.join(", ")}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) return push(errors, path, "must be an array");
      if (schema.min !== undefined && value.length < schema.min) push(errors, path, `length < ${schema.min}`);
      if (schema.max !== undefined && value.length > schema.max) push(errors, path, `length > ${schema.max}`);
      value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors));
      return;
    }
    case "object": {
      if (!isObject(value)) return push(errors, path, "must be an object");
      for (const [k, v] of Object.entries(value)) {
        const child = schema.properties[k];
        if (child) {
          walk(v, child, `${path}.${k}`, errors);
        } else if (schema.additionalProperties === false) {
          push(errors, `${path}.${k}`, "unexpected property");
        } else if (typeof schema.additionalProperties === "object") {
          walk(v, schema.additionalProperties, `${path}.${k}`, errors);
        }
      }
      return;
    }
  }
}

function push(errors: ValidationError[], path: string, message: string): void {
  errors.push({ path, message });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
