/**
 * core-ts/src/memory/graph.ts — 实体-关系图谱（LangGraph memory graph / relationship layer 对标）。
 *
 * 纯函数 CRUD：实体（user/task/file/tool/concept）与关系边（from → to, relation, weight）。
 * 支撑"记忆通过实体关联"：写入记忆时挂 entityKeys，检索时经 entity 邻居旁路召回。
 * 值语义：所有操作返回新对象，不修改入参（可单测、可序列化）。
 */
export type EntityType = "user" | "task" | "file" | "tool" | "concept";

export interface Entity {
  id: string;
  type: EntityType;
  label: string;
  props?: Record<string, unknown>;
}

export interface Edge {
  from: string;
  to: string;
  relation: string;
  weight: number;
}

export interface EntityGraph {
  entities: Entity[];
  edges: Edge[];
}

export function createGraph(): EntityGraph {
  return { entities: [], edges: [] };
}

export function upsertEntity(graph: EntityGraph, e: Entity): EntityGraph {
  const idx = graph.entities.findIndex((x) => x.id === e.id);
  const entities = idx >= 0
    ? graph.entities.map((x, i) => (i === idx ? { ...x, ...e } : x))
    : [...graph.entities, e];
  return { ...graph, entities };
}

export function removeEntity(graph: EntityGraph, id: string): EntityGraph {
  return {
    entities: graph.entities.filter((e) => e.id !== id),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/** 有向边（同向重复则叠加权重）。 */
export function addEdge(graph: EntityGraph, edge: Edge): EntityGraph {
  const idx = graph.edges.findIndex((e) => e.from === edge.from && e.to === edge.to && e.relation === edge.relation);
  const edges = idx >= 0
    ? graph.edges.map((e, i) => (i === idx ? { ...e, weight: e.weight + edge.weight } : e))
    : [...graph.edges, edge];
  return { ...graph, edges };
}

/** 便捷：为实体绑定另一实体（双向边，权重由两向共摊）。 */
export function linkEntities(
  graph: EntityGraph,
  a: Entity,
  b: Entity,
  relations: { aToB: string; bToA: string; weight?: number },
): EntityGraph {
  const w = relations.weight ?? 1;
  const g1 = upsertEntity(upsertEntity(graph, a), b);
  return addEdge(addEdge(g1, { from: a.id, to: b.id, relation: relations.aToB, weight: w }),
    { from: b.id, to: a.id, relation: relations.bToA, weight: w });
}

export function byType(graph: EntityGraph, type: EntityType): Entity[] {
  return graph.entities.filter((e) => e.type === type);
}

export function findEntity(graph: EntityGraph, id: string): Entity | undefined {
  return graph.entities.find((e) => e.id === id);
}

/** 直接邻居（无向视角：与节点相连的所有对端 + 关系）。 */
export function neighbors(graph: EntityGraph, id: string): Array<{ entity: Entity; relation: string; weight: number }> {
  const out: Array<{ entity: Entity; relation: string; weight: number }> = [];
  for (const edge of graph.edges) {
    if (edge.from === id) {
      const e = findEntity(graph, edge.to);
      if (e) { out.push({ entity: e, relation: edge.relation, weight: edge.weight }); }
    } else if (edge.to === id) {
      const e = findEntity(graph, edge.from);
      if (e) { out.push({ entity: e, relation: edge.relation, weight: edge.weight }); }
    }
  }
  return out;
}

/** 图谱长度指标（汇总用）。 */
export function graphStats(graph: EntityGraph): { entities: number; edges: number } {
  return { entities: graph.entities.length, edges: graph.edges.length };
}

export function graphToJSON(graph: EntityGraph): string {
  return JSON.stringify(graph, null, 2);
}

/** 从 JSON 字符串/对象还原图谱；无效返回 null（不抛）。 */
export function parseGraph(raw: string | Record<string, unknown>): EntityGraph | null {
  try {
    const obj = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    if (!obj || !Array.isArray(obj.entities) || !Array.isArray(obj.edges)) { return null; }
    return { entities: obj.entities as Entity[], edges: obj.edges as Edge[] };
  } catch { return null; }
}

/** 由实体 key（如 "task:123" / "user:alice"）反查图谱中的实体 id 列表（id 或 label 命中）。
 *  供检索侧把记忆条目的 entity_keys 解析成图谱节点。 */
export function resolveEntityIds(graph: EntityGraph, keys: string[]): string[] {
  const wanted = new Set(keys.filter(Boolean));
  if (wanted.size === 0) { return []; }
  const out = new Set<string>();
  for (const e of graph.entities) {
    if (wanted.has(e.id) || (e.label && wanted.has(e.label))) { out.add(e.id); }
  }
  return [...out];
}