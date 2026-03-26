// pipeline/src/lib/entity-graph.ts — FK graph walker for entity creation
import { psqlQuery } from "./psql.js";
import type { AppIndex } from "./types.js";

type EntityGraphs = NonNullable<AppIndex["entity_graphs"]>;

interface FkEdge {
  child_table: string;
  column: string;
  parent_table: string;
  parent_column: string;
  required: boolean;
}

interface ColumnMeta {
  table_name: string;
  name: string;
  pg_type: string;
  nullable: boolean;
  has_default: boolean;
}

/**
 * Batch-query all FK edges for tables in the data model.
 * One query total instead of per-table (review decision 8A).
 */
function batchFkEdges(psqlCmd: string, tableNames: string[]): FkEdge[] {
  if (tableNames.length === 0) return [];
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const t of tableNames) {
    if (!validName.test(t)) {
      console.warn(`  Skipping invalid table name: ${t}`);
      return [];
    }
  }
  const inList = tableNames.map(t => `'${t.replace(/'/g, "''")}'`).join(",");
  const sql = `
    SELECT tc.table_name, kcu.column_name, ccu.table_name, ccu.column_name,
      CASE WHEN c.is_nullable = 'NO' AND c.column_default IS NULL THEN 'required' ELSE 'optional' END
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    JOIN information_schema.columns c
      ON c.table_name = tc.table_name AND c.column_name = kcu.column_name AND c.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name IN (${inList})
  `;
  const raw = psqlQuery(psqlCmd, sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const [childTable, col, parentTable, parentCol, req] = line.split("\t");
    return { child_table: childTable, column: col, parent_table: parentTable, parent_column: parentCol, required: req === "required" };
  });
}

/**
 * Batch-query all columns for tables in the data model.
 * One query total instead of per-table (review decision 8A).
 */
function batchColumns(psqlCmd: string, tableNames: string[]): ColumnMeta[] {
  if (tableNames.length === 0) return [];
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const t of tableNames) {
    if (!validName.test(t)) {
      console.warn(`  Skipping invalid table name: ${t}`);
      return [];
    }
  }
  const inList = tableNames.map(t => `'${t.replace(/'/g, "''")}'`).join(",");
  const sql = `
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name IN (${inList}) ORDER BY table_name, ordinal_position
  `;
  const raw = psqlQuery(psqlCmd, sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const [tableName, name, pgType, nullable, colDefault] = line.split("\t");
    return { table_name: tableName, name, pg_type: pgType, nullable: nullable === "YES", has_default: !!colDefault && colDefault !== "" };
  });
}

/**
 * Topological sort: given a map of table → required parent tables,
 * return tables in insert order (parents first).
 */
export function topoSort(deps: Map<string, string[]>): string[] {
  const inDegree = new Map<string, number>();
  for (const [t] of deps) inDegree.set(t, 0);
  for (const [child, parents] of deps) {
    for (const p of parents) {
      // Skip self-references and parents not in our set
      if (deps.has(p) && p !== child) {
        inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const [t, deg] of inDegree) if (deg === 0) queue.push(t);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    sorted.push(t);
    for (const [name, parents] of deps) {
      if (parents.includes(t) && t !== name) {
        inDegree.set(name, (inDegree.get(name) ?? 0) - 1);
        if (inDegree.get(name) === 0) queue.push(name);
      }
    }
  }
  // Append any remaining (cycles) — SQL will likely fail on FK constraint, triggering retry
  for (const [t] of deps) {
    if (!sorted.includes(t)) {
      console.warn(`  Warning: FK cycle detected, appending: ${t}`);
      sorted.push(t);
    }
  }
  return sorted;
}

/**
 * Build entity graphs for all tables in the data model.
 * Uses batched queries (2 total) instead of per-table (review decision 8A).
 * Does NOT query pg_enum — enums come from AppIndex.data_model at runtime (review decision 3A).
 */
export function buildEntityGraphs(
  psqlCmd: string,
  dataModel: AppIndex["data_model"],
): EntityGraphs {
  if (!psqlCmd) return {};

  // Collect all table names
  const allTableNames = [...new Set(Object.values(dataModel).map(m => m.table_name))];

  // Batch queries — 2 total instead of N per table
  const allFks = batchFkEdges(psqlCmd, allTableNames);
  const allCols = batchColumns(psqlCmd, allTableNames);

  // Index by table
  const fksByTable = new Map<string, FkEdge[]>();
  for (const fk of allFks) {
    if (!fksByTable.has(fk.child_table)) fksByTable.set(fk.child_table, []);
    fksByTable.get(fk.child_table)!.push(fk);
  }
  const colsByTable = new Map<string, ColumnMeta[]>();
  for (const col of allCols) {
    if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
    colsByTable.get(col.table_name)!.push(col);
  }

  const graphs: EntityGraphs = {};

  // Discover additional parent tables not in the data model
  // (tables referenced by FKs but not in Prisma schema)
  const additionalTables = new Set<string>();
  for (const fk of allFks) {
    if (!allTableNames.includes(fk.parent_table)) {
      additionalTables.add(fk.parent_table);
    }
  }
  if (additionalTables.size > 0) {
    const extraFks = batchFkEdges(psqlCmd, [...additionalTables]);
    const extraCols = batchColumns(psqlCmd, [...additionalTables]);
    for (const fk of extraFks) {
      if (!fksByTable.has(fk.child_table)) fksByTable.set(fk.child_table, []);
      fksByTable.get(fk.child_table)!.push(fk);
    }
    for (const col of extraCols) {
      if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
      colsByTable.get(col.table_name)!.push(col);
    }
  }

  // Build child index from already-fetched FK edges (no additional queries needed)
  const childrenByParent = new Map<string, Set<string>>();
  for (const fk of allFks) {
    if (!childrenByParent.has(fk.parent_table)) childrenByParent.set(fk.parent_table, new Set());
    childrenByParent.get(fk.parent_table)!.add(fk.child_table);
  }

  // Build a graph for each table in the data model
  for (const [_modelName, modelInfo] of Object.entries(dataModel)) {
    const rootTable = modelInfo.table_name;
    if (graphs[rootTable]) continue;

    // Walk required FK parents recursively
    const visited = new Set<string>();
    const walkQueue = [rootTable];
    const tableMeta: EntityGraphs[string]["tables"] = {};
    const parentDeps = new Map<string, string[]>();

    while (walkQueue.length > 0) {
      const table = walkQueue.shift()!;
      if (visited.has(table)) continue;
      visited.add(table);

      const fks = fksByTable.get(table) ?? [];
      const cols = colsByTable.get(table) ?? [];
      const requiredParents = fks.filter(fk => fk.required);

      parentDeps.set(table, requiredParents.map(fk => fk.parent_table).filter(p => p !== table));

      const requiredCols = cols.filter(c => !c.nullable && !c.has_default);

      tableMeta[table] = {
        columns: requiredCols.map(c => ({
          name: c.name, pg_type: c.pg_type, nullable: c.nullable, has_default: c.has_default,
        })),
        fk_parents: fks.map(fk => ({
          column: fk.column, parent_table: fk.parent_table,
          parent_column: fk.parent_column, required: fk.required,
        })),
      };

      for (const fk of requiredParents) {
        if (fk.parent_table !== table && !visited.has(fk.parent_table)) {
          walkQueue.push(fk.parent_table);
        }
      }
    }

    // Walk children (tables that reference this root) — derived from FK edges, no extra queries
    const childTables = childrenByParent.get(rootTable) ?? new Set<string>();
    for (const childTable of childTables) {
      if (visited.has(childTable)) continue;
      visited.add(childTable);
      const fks = fksByTable.get(childTable) ?? [];
      const cols = colsByTable.get(childTable) ?? [];
      const requiredCols = cols.filter(c => !c.nullable && !c.has_default);
      parentDeps.set(childTable, fks.filter(fk => fk.required).map(fk => fk.parent_table).filter(p => p !== childTable));
      tableMeta[childTable] = {
        columns: requiredCols.map(c => ({
          name: c.name, pg_type: c.pg_type, nullable: c.nullable, has_default: c.has_default,
        })),
        fk_parents: fks.map(fk => ({
          column: fk.column, parent_table: fk.parent_table,
          parent_column: fk.parent_column, required: fk.required,
        })),
      };
    }

    const insertOrder = topoSort(parentDeps);
    graphs[rootTable] = { insert_order: insertOrder, tables: tableMeta };
  }

  return graphs;
}
