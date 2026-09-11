import type { JsonSchema } from '@deliberate/protocol';

/**
 * Argument validation against the tool schemas in `contracts/gm-tools.json` (ALE-31).
 *
 * The GM service calls the model with strict schemas, so well-formed arguments are the normal
 * case — but "the model was asked nicely" is not a guarantee, and the engine is the authority.
 * Anything that reaches `Engine.apply` has been through here first, which means a malformed call
 * is a plain rejection with a readable reason rather than a type error deep in the rules.
 *
 * The supported subset is exactly what the contract uses: objects with fixed properties, the
 * primitives, nullable unions written as `["string", "null"]`, enums, numeric bounds and string
 * lengths. Anything the contract grows beyond that must be added here too, and
 * `gm.test.ts` fails if a schema uses a keyword this does not understand.
 */

/** Keywords this validator honours. A schema using anything else is a contract bug. */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
];

/** Returns a player-readable reason the value does not fit, or `null` when it does. */
export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  path = '',
): string | null {
  const where = path || 'argument';

  if (schema.enum) {
    if (!schema.enum.some((v) => v === value)) {
      return `${where} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.`;
    }
  }

  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    return `${where} must be ${types.join(' or ')}, not ${describe(value)}.`;
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${where} must be at least ${schema.minimum}.`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${where} must be at most ${schema.maximum}.`;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${where} must be at least ${schema.minLength} character(s).`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${where} must be at most ${schema.maxLength} characters.`;
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const reason = validateAgainstSchema(schema.items, value[i], `${where}[${i}]`);
      if (reason) return reason;
    }
  }

  if (isPlainObject(value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${where} is missing ${key}.`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) return `${where} has no ${key} argument.`;
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const reason = validateAgainstSchema(sub, value[key], path ? `${path}.${key}` : key);
      if (reason) return reason;
    }
  }

  return null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (Number.isInteger(value)) return 'an integer';
  return `a ${typeof value}`;
}
