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
 * Extract the body of a named model from a Prisma schema.
 * Uses balanced-brace matching to handle @default("{}") correctly.
 * Returns the text between the opening { and closing }, or null if not found.
 */
export function extractModelBody(content: string, modelName: string): string | null {
  const regex = new RegExp(`model\\s+${modelName}\\s*\\{`);
  const match = regex.exec(content);
  if (!match) return null;

  const bodyStart = match.index + match[0].length;
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
  return content.slice(bodyStart, i - 1);
}

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

  // Extract model blocks using shared helper
  const modelHeaderRegex = /model\s+(\w+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = modelHeaderRegex.exec(content)) !== null) {
    const modelName = match[1];
    const body = extractModelBody(content, modelName);
    if (!body) continue;

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

/**
 * Extract Prisma /// [TypeName] annotations on Json fields.
 * Returns: { ModelName: { fieldName: "TypeName" } }
 * Prisma-specific: these annotations reference TypeScript/Zod types
 * that define the JSONB field's expected shape.
 */
export function extractJsonFieldAnnotations(
  content: string
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  const modelHeaderRegex = /model\s+(\w+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = modelHeaderRegex.exec(content)) !== null) {
    const modelName = match[1];
    const body = extractModelBody(content, modelName);
    if (!body) continue;

    const lines = body.split("\n");
    let pendingAnnotation: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for /// [TypeName] annotation
      const annotationMatch = trimmed.match(/^\/\/\/\s*\[(\w+)\]/);
      if (annotationMatch) {
        pendingAnnotation = annotationMatch[1];
        continue;
      }

      // Check if this line is a Json field
      if (pendingAnnotation) {
        const fieldMatch = trimmed.match(/^(\w+)\s+Json(\?|\[\])?(\s|$)/);
        if (fieldMatch) {
          if (!result[modelName]) result[modelName] = {};
          result[modelName][fieldMatch[1]] = pendingAnnotation;
        }
        pendingAnnotation = null;
      }
    }
  }

  return result;
}
