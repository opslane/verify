// pipeline/src/lib/prisma-parser.ts — Deterministic Prisma @map parser

interface PrismaModel {
  table_name: string;
  columns: Record<string, string>; // prismaFieldName → postgresColumnName
}

// Scalar types that represent actual DB columns (not relations)
const SCALAR_TYPES = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Decimal", "Bytes",
]);

/**
 * Parse a Prisma schema file and extract model→table and field→column mappings.
 *
 * - @map("column_name") on a field → that field's Postgres column name
 * - @@map("table_name") on a model → that model's Postgres table name
 * - No @map → Postgres name = Prisma name
 * - Relation fields (type is another model or Model[]) are skipped
 */
export function parsePrismaSchema(content: string): Record<string, PrismaModel> {
  const models: Record<string, PrismaModel> = {};

  // First pass: collect all enum names so we can treat enum fields as columns
  const enumNames = new Set<string>();
  const enumRegex = /enum\s+(\w+)\s*\{/g;
  let enumMatch: RegExpExecArray | null;
  while ((enumMatch = enumRegex.exec(content)) !== null) {
    enumNames.add(enumMatch[1]);
  }

  // Extract model blocks with balanced braces (handles } inside @default("{}"))
  const modelHeaderRegex = /model\s+(\w+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = modelHeaderRegex.exec(content)) !== null) {
    const modelName = match[1];
    const bodyStart = match.index + match[0].length;
    // Find matching closing brace (skip quoted strings)
    let depth = 1;
    let i = bodyStart;
    let inQuote = false;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '"' && content[i - 1] !== '\\') inQuote = !inQuote;
      if (!inQuote) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      i++;
    }
    const body = content.slice(bodyStart, i - 1);

    // Check for @@map("table_name") or @@map(name: "table_name")
    const tableMapMatch = body.match(/@@map\(\s*(?:name:\s*)?"([^"]+)"\s*\)/);
    const tableName = tableMapMatch ? tableMapMatch[1] : modelName;

    const columns: Record<string, string> = {};

    // Parse each line in the model body
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

      // Match: fieldName  Type  ...modifiers...
      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)/);
      if (!fieldMatch) continue;

      const [, fieldName, fieldType, modifier] = fieldMatch;

      // Skip relation fields: type[] or type that's not a scalar/enum
      if (modifier === "[]") continue;
      if (!SCALAR_TYPES.has(fieldType) && !enumNames.has(fieldType)) continue;

      // Check for @map("column_name") or @map(name: "column_name")
      const mapMatch = trimmed.match(/@map\(\s*(?:name:\s*)?"([^"]+)"\s*\)/);
      columns[fieldName] = mapMatch ? mapMatch[1] : fieldName;
    }

    models[modelName] = { table_name: tableName, columns };
  }

  return models;
}
