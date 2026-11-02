import type { JsonSchema } from "./types";

/**
 * Minimal validator for the JSON-Schema subset in JsonSchema.
 * The same schema object is sent to the model AND used to validate what comes
 * back, so there is one source of truth. Returns a list of human-readable errors.
 */
export function validate(schema: JsonSchema, value: unknown, path = "input"): string[] {
  const errors: string[] = [];
  switch (schema.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a finite number`];
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
      break;
    case "string":
      if (typeof value !== "string") return [`${path} must be a string`];
      break;
    case "boolean":
      if (typeof value !== "boolean") return [`${path} must be a boolean`];
      break;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} must be an object`];
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key} is required`);
      for (const [key, v] of Object.entries(obj)) {
        if (props[key]) errors.push(...validate(props[key], v, `${path}.${key}`));
        else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not an allowed field`);
      }
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  return errors;
}
