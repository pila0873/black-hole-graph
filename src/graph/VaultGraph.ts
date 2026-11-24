import type { App, EventRef } from 'obsidian';
import type { GraphData, GraphEdge, GraphNode, PluginSettings } from '../types';
import { emptyGraph } from '../types';

/** Coalesce bursts of vault/metadata events into a single notification. */
const NOTIFY_DEBOUNCE_MS = 500;

/** A markdown file reduced to exactly what the graph needs. */
interface FileDraft {
  path: string;
  title: string;
  clusterKey: string;
  mtime: number;
}

/** An undirected, deduplicated edge stored as indices into the draft array. */
interface EdgePair {
  a: number;
  b: number;
}

/**
 * Builds the visual graph from the vault: markdown files become nodes,
 * resolved wiki links become undirected edges, folders become clusters.
 *
 * OWNER: agent "graph". Contract used by BlackHoleView must stay:
 *   build(settings) -> GraphData
 *   onChange(cb) -> unsubscribe
 *   dispose()
 */
export class VaultGraph {
  private readonly listeners = new Set<() => void>();
  private readonly cacheRefs: EventRef[] = [];
  private readonly vaultRefs: EventRef[] = [];
  private timer: number | null = null;
  private disposed = false;

  constructor(private readonly app: App) {
    this.bindEvents();
  }

  /** Rebuild from the vault. Cheap enough to call on any metadata change. */
  build(settings: PluginSettings): GraphData {
    try {
      return this.buildUnsafe(settings);
    } catch (err) {
      // Never let a malformed cache or a mid-edit vault take down the view.
      console.error('[BlackHoleGraph] VaultGraph.build failed', err);
      return emptyGraph();
    }
  }

  /** Subscribe to "graph data is stale" notifications. Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  protected notify(): void {
    // Copy so listeners may safely unsubscribe from inside the callback.
    for (const cb of Array.from(this.listeners)) {
      try {
        cb();
      } catch (err) {
        console.error('[BlackHoleGraph] VaultGraph listener failed', err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    for (const ref of this.cacheRefs) {
      try {
        this.app.metadataCache.offref(ref);
      } catch (err) {
        console.error('[BlackHoleGraph] metadataCache.offref failed', err);
      }
    }
    this.cacheRefs.length = 0;

    for (const ref of this.vaultRefs) {
      try {
        this.app.vault.offref(ref);
      } catch (err) {
        console.error('[BlackHoleGraph] vault.offref failed', err);
      }
    }
    this.vaultRefs.length = 0;

    this.listeners.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  private buildUnsafe(settings: PluginSettings): GraphData {
    const files = this.app.vault.getMarkdownFiles();
    const totalFiles = files.length;
    if (totalFiles === 0) {
      return emptyGraph();
    }

    /* ---- 1. draft all markdown files (unfiltered) ---- */
    const drafts: FileDraft[] = new Array(files.length);
    const pathToIndex = new Map<string, number>();
    const lowerPaths: string[] = new Array(files.length);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = file.path;
      drafts[i] = {
        path,
        title: file.basename,
        clusterKey: firstFolderSegment(path),
        mtime: typeof file.stat?.mtime === 'number' ? file.stat.mtime : 0,
      };
      pathToIndex.set(path, i);
      lowerPaths[i] = path.toLowerCase();
    }

    /* ---- 2. collect undirected, deduplicated edges ---- */
    const pairKeys = new Set<string>();
    const pairs: EdgePair[] = [];
    // Undirected neighbour count over the unfiltered graph; equals the length
    // of the final adjacency list because parallel links are deduplicated.
    const degreeAll = new Int32Array(files.length);

    const resolved = this.app.metadataCache.resolvedLinks;
    if (resolved) {
      for (const sourcePath in resolved) {
        const source = pathToIndex.get(sourcePath);
        if (source === undefined) continue;

        const targets = resolved[sourcePath];
        if (!targets) continue;

        for (const targetPath in targets) {
          const target = pathToIndex.get(targetPath);
          if (target === undefined || target === source) continue;

          const a: number = source < target ? source : target;
          const b: number = source < target ? target : source;
          const lowPath: string = sourcePath < targetPath ? sourcePath : targetPath;
          const highPath: string = sourcePath < targetPath ? targetPath : sourcePath;
          const key: string = lowPath + '\u0000' + highPath;

          if (pairKeys.has(key)) continue;
          pairKeys.add(key);
          pairs.push({ a, b });
          degreeAll[a]++;
          degreeAll[b]++;
        }
      }
    }

    /* ---- 3. filter: excludedFolders -> onlyLinked -> maxNotes ---- */
    const prefixes = normalizePrefixes(settings.excludedFolders);
    const kept: number[] = [];

    for (let i = 0; i < files.length; i++) {
      if (matchesAnyPrefix(lowerPaths[i], prefixes)) continue;
      if (settings.onlyLinked && degreeAll[i] === 0) continue;
      kept.push(i);
    }

    const limit = typeof settings.maxNotes === 'number' ? Math.floor(settings.maxNotes) : -1;
    if (Number.isFinite(limit) && limit >= 0 && kept.length > limit) {
      kept.sort((ia, ib) => {
        const byDegree = degreeAll[ib] - degreeAll[ia];
        if (byDegree !== 0) return byDegree;

        const byMtime = drafts[ib].mtime - drafts[ia].mtime;
        if (byMtime !== 0) return byMtime;

        const pa = drafts[ia].path;
        const pb = drafts[ib].path;
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
      kept.length = limit;
    }

    /* ---- 4. rebuild adjacency/edges for the survivors ---- */
    const keptFlags = new Uint8Array(files.length);
    for (const index of kept) {
      keptFlags[index] = 1;
    }

    const adjacency = new Map<string, string[]>();
    for (const index of kept) {
      adjacency.set(drafts[index].path, []);
    }

    const edges: GraphEdge[] = [];
    for (const pair of pairs) {
      if (keptFlags[pair.a] === 0 || keptFlags[pair.b] === 0) continue;

      const source = drafts[pair.a].path;
      const target = drafts[pair.b].path;
      edges.push({ source, target });

      const sourceList = adjacency.get(source);
      const targetList = adjacency.get(target);
      if (sourceList !== undefined) sourceList.push(target);
      if (targetList !== undefined) targetList.push(source);
    }

    for (const neighbours of adjacency.values()) {
      neighbours.sort();
    }

    /* ---- 5. clusters: descending node count, then alphabetically ---- */
    const clusterCounts = new Map<string, number>();
    for (const index of kept) {
      const key = drafts[index].clusterKey;
      clusterCounts.set(key, (clusterCounts.get(key) ?? 0) + 1);
    }

    const clusters = Array.from(clusterCounts.keys()).sort((a, b) => {
      const byCount = (clusterCounts.get(b) ?? 0) - (clusterCounts.get(a) ?? 0);
      if (byCount !== 0) return byCount;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const clusterIndices = new Map<string, number>();
    for (let i = 0; i < clusters.length; i++) {
      clusterIndices.set(clusters[i], i);
    }

    /* ---- 6. materialize nodes ---- */
    const nodes: GraphNode[] = new Array(kept.length);
    for (let n = 0; n < kept.length; n++) {
      const draft = drafts[kept[n]];
      const neighbours = adjacency.get(draft.path);
      nodes[n] = {
        id: draft.path,
        path: draft.path,
        title: draft.title,
        degree: neighbours === undefined ? 0 : neighbours.length,
        clusterKey: draft.clusterKey,
        clusterIndex: clusterIndices.get(draft.clusterKey) ?? -1,
      };
    }

    return { nodes, edges, adjacency, clusters, totalFiles };
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  private bindEvents(): void {
    try {
      this.cacheRefs.push(
        this.app.metadataCache.on('resolved', () => {
          this.scheduleNotify();
        }),
      );

      const onVaultChange = (): void => {
        this.scheduleNotify();
      };
      this.vaultRefs.push(
        this.app.vault.on('create', onVaultChange),
        this.app.vault.on('delete', onVaultChange),
        this.app.vault.on('rename', onVaultChange),
      );
    } catch (err) {
      console.error('[BlackHoleGraph] VaultGraph event registration failed', err);
    }
  }

  private scheduleNotify(): void {
    if (this.disposed || this.listeners.size === 0) return;

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      this.notify();
    }, NOTIFY_DEBOUNCE_MS);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * `Projects/Sub/Note.md` -> `Projects`; a note at the vault root -> `''`.
 * The folder's first path segment is used as the visual cluster key.
 */
function firstFolderSegment(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return '';
  const folder = path.slice(0, slash);
  const next = folder.indexOf('/');
  return next === -1 ? folder : folder.slice(0, next);
}

/** Trim, strip surrounding slashes and lowercase user-supplied folder prefixes. */
function normalizePrefixes(raw: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const prefix = entry.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
    if (prefix.length > 0) out.push(prefix);
  }
  return out;
}

/** Case-insensitive folder-prefix test; `pathLower` is pre-lowercased. */
function matchesAnyPrefix(pathLower: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (!pathLower.startsWith(prefix)) continue;
    // Require a folder boundary: "Templates" must not swallow "Templates2/".
    if (pathLower.length === prefix.length || pathLower.charAt(prefix.length) === '/') {
      return true;
    }
  }
  return false;
}
