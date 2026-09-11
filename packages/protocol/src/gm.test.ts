import { describe, expect, it } from 'vitest';

import {
  GM_CONTRACT_VERSION,
  GM_MUTATION_TOOLS,
  GM_MUTATION_TOOL_NAMES,
  GM_QUERY_TOOLS,
  GM_QUERY_TOOL_NAMES,
  GM_TOOLS,
  gmTool,
  isGmMutationTool,
  isGmQueryTool,
  type GmToolDefinition,
  type JsonSchema,
} from './index.js';

/**
 * The contract test for `contracts/gm-tools.json`. TypeScript and Python read the same file, so
 * the shape assertions here are the ones the Python side depends on too: entries with exactly
 * `{name, description, input_schema}`, strict object schemas, and no keyword the engine's
 * validator cannot enforce.
 */

const SUPPORTED_KEYWORDS = new Set([
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
]);

/** Walk every object schema in the contract, including nested argument objects. */
function objectSchemas(schema: JsonSchema, path: string): [string, JsonSchema][] {
  const out: [string, JsonSchema][] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) out.push([path, schema]);
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    out.push(...objectSchemas(sub, `${path}.${key}`));
  }
  if (schema.items) out.push(...objectSchemas(schema.items, `${path}[]`));
  return out;
}

describe('gm tool contract', () => {
  it('is version 1 with the fifteen blueprint tools, queries first', () => {
    expect(GM_CONTRACT_VERSION).toBe(1);
    // File order is the order the model sees and must stay stable: it is the cached prefix.
    expect(GM_TOOLS.map((t) => t.name)).toEqual([
      ...GM_QUERY_TOOL_NAMES,
      ...GM_MUTATION_TOOL_NAMES,
    ]);
    expect(GM_TOOLS).toHaveLength(15);
  });

  it('declares kind on every entry, so neither language keeps its own list', () => {
    // The point of `kind`: the free-vs-validated split lives in the file. These assertions are
    // what stops a tool being added to the JSON without an engine handler, or vice versa.
    for (const tool of GM_TOOLS) {
      expect(['query', 'mutation'], tool.name).toContain(tool.kind);
    }
    expect(GM_QUERY_TOOLS.map((t) => t.name)).toEqual([...GM_QUERY_TOOL_NAMES]);
    expect(GM_MUTATION_TOOLS.map((t) => t.name)).toEqual([...GM_MUTATION_TOOL_NAMES]);
  });

  it('carries only the keys a loader needs: the three Anthropic ones plus kind', () => {
    for (const tool of GM_TOOLS) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'input_schema', 'kind', 'name']);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('makes every object schema strict: additionalProperties false, everything required', () => {
    for (const tool of GM_TOOLS) {
      for (const [path, schema] of objectSchemas(tool.input_schema, tool.name)) {
        expect(schema.additionalProperties, `${path} additionalProperties`).toBe(false);
        const properties = Object.keys(schema.properties ?? {}).sort();
        expect([...(schema.required ?? [])].sort(), `${path} required`).toEqual(properties);
      }
    }
  });

  it('describes every argument, so the model is never guessing at one', () => {
    for (const tool of GM_TOOLS) {
      for (const [, schema] of objectSchemas(tool.input_schema, tool.name)) {
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
          expect(sub.description ?? '', `${tool.name}.${key}`).not.toBe('');
        }
      }
    }
  });

  it('uses only keywords the engine validator enforces', () => {
    const walk = (schema: JsonSchema, path: string): void => {
      for (const key of Object.keys(schema)) {
        expect(SUPPORTED_KEYWORDS.has(key), `${path} uses unsupported keyword ${key}`).toBe(true);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) walk(sub, `${path}.${key}`);
      if (schema.items) walk(schema.items, `${path}[]`);
    };
    for (const tool of GM_TOOLS) walk(tool.input_schema, tool.name);
  });

  it('sorts every tool into exactly one of query or mutation', () => {
    for (const tool of GM_TOOLS) {
      expect(isGmQueryTool(tool.name) !== isGmMutationTool(tool.name)).toBe(true);
      expect(gmTool(tool.name)).toBe<GmToolDefinition>(tool);
    }
    expect(gmTool('rewrite_reality')).toBeUndefined();
    expect(isGmMutationTool('rewrite_reality')).toBe(false);
  });
});
