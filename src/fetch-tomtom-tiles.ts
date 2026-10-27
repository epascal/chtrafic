#!/usr/bin/env node
/**
 * Récupère le trafic TomTom par tuiles (Vector Flow Tiles) pour une zone.
 * Une requête = une tuile = tous les segments dans ce carré (pas de grille de points).
 *
 * Usage:
 *   TOMTOM_API_KEY=xxx npx tsx src/fetch-tomtom-tiles.ts
 *   npx tsx src/fetch-tomtom-tiles.ts --bbox 6.05,46.1,6.2,46.25 --zoom 14
 *
 * Options:
 *   --bbox lonMin,latMin,lonMax,latMax   Zone (défaut: Genève)
 *   --zoom N                             Zoom 0-22 (défaut: 14). Plus élevé = plus de tuiles et plus de segments.
 *   --tiles-file PATH                    Whitelist JSON { zoom, tiles: [[x,y],...] } : ne fetcher que ces tuiles
 *                                        (intersectées avec la bbox). Absent/invalide/zoom différent → sweep complet.
 *   --save-nonempty PATH                 Écrire dans PATH les tuiles ayant retourné ≥1 segment (format whitelist).
 *   --out-dir PATH                       Dossier de sortie (défaut: ./tomtom)
 *   --no-write                           Ne pas écrire de fichier
 *   --concurrency N                      Requêtes en parallèle (défaut: 16)
 */

import { config } from './config.js';
import { bboxToTiles, type Bbox, type TileId } from './tile-utils.js';
import { decodeFlowTile, toFeatureCollection, type DecodedFlowFeature } from './decode-flow-tile.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GENEVA_BBOX: Bbox = { lonMin: 6.05, latMin: 46.1, lonMax: 6.2, latMax: 46.25 };
const ORBIS_BASE = 'https://api.tomtom.com/maps/orbis/traffic/tile/flow';

/** Nombre de requêtes tuiles en parallèle. */
const CONCURRENCY = 16;

/**
 * Erreurs HTTP fatales (auth/quota) : si ce compteur d'échecs consécutifs est atteint,
 * le run est abandonné au lieu de brûler les requêtes restantes (ex. clé à sec
 * → 13k requêtes 403 inutiles observées le 2026-09-30).
 */
const MAX_CONSECUTIVE_FATAL_ERRORS = 16;

/** Codes HTTP qui indiquent un problème de clé/quota plutôt qu'une tuile défectueuse. */
const FATAL_STATUS_CODES = new Set([401, 402, 403]);

export function parseBbox(s: string): Bbox {
  const parts = s.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error('--bbox doit être lonMin,latMin,lonMax,latMax');
  }
  const [lonMin, latMin, lonMax, latMax] = parts;
  if (lonMin >= lonMax || latMin >= latMax) throw new Error('bbox invalide');
  return { lonMin, latMin, lonMax, latMax };
}

class TomTomHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'TomTomHttpError';
  }
}

async function fetchTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
  const url = `${ORBIS_BASE}/${z}/${x}/${y}.pbf?apiVersion=1&key=${encodeURIComponent(config.tomtom.apiKey)}&tags=road_category,relative_speed,absolute_speed,road_closure`;
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!res.ok) {
    const text = await res.text();
    throw new TomTomHttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.arrayBuffer();
}

/** Fichier whitelist produit par --save-nonempty / attendu par --tiles-file. */
type TileListFile = { zoom: number; tiles: Array<[number, number]> };

/**
 * Charge une whitelist de tuiles. Retourne null si le fichier est absent, invalide
 * ou d'un autre zoom : dans ce cas le caller fait un sweep complet de la bbox.
 */
async function loadTileList(path: string, zoom: number): Promise<Set<string> | null> {
  let parsed: TileListFile;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8')) as TileListFile;
  } catch {
    return null;
  }
  if (parsed.zoom !== zoom || !Array.isArray(parsed.tiles)) return null;
  const set = new Set<string>();
  for (const t of parsed.tiles) {
    if (Array.isArray(t) && Number.isInteger(t[0]) && Number.isInteger(t[1])) {
      set.add(`${t[0]}/${t[1]}`);
    }
  }
  return set.size > 0 ? set : null;
}

export type FetchTomTomResult = {
  filePath: string;
  features: Array<{ type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }>;
  bbox: Bbox;
  zoom: number;
  segmentCount: number;
  /** Tuiles ayant retourné ≥1 segment (base d'une whitelist). */
  nonEmptyTiles: TileId[];
};

export type FetchTomTomOptions = {
  bbox?: Bbox;
  zoom?: number;
  outDir?: string;
  noWrite?: boolean;
  silent?: boolean;
  /** Requêtes tuiles en parallèle (défaut: 16). */
  concurrency?: number;
  /** Whitelist JSON { zoom, tiles: [[x,y],...] } intersectée avec la bbox. */
  tileListFile?: string;
  /** Écrit les tuiles non vides du run dans ce fichier (format whitelist). */
  saveNonEmptyTo?: string;
};

/**
 * Récupère les tuiles TomTom et écrit le JSON. Utilisable en import par push-graphhopper.
 */
export async function fetchTomTomTiles(options: FetchTomTomOptions = {}): Promise<FetchTomTomResult> {
  const bbox = options.bbox ?? GENEVA_BBOX;
  const zoom = Math.max(0, Math.min(22, options.zoom ?? 14));
  const outDir = options.outDir ?? join(process.cwd(), 'tomtom');
  const noWrite = options.noWrite ?? false;
  const silent = options.silent ?? false;

  let tiles = bboxToTiles(bbox, zoom);
  const concurrency = Math.max(1, options.concurrency ?? CONCURRENCY);

  if (options.tileListFile) {
    const whitelist = await loadTileList(options.tileListFile, zoom);
    if (whitelist) {
      const before = tiles.length;
      tiles = tiles.filter((t) => whitelist.has(`${t.x}/${t.y}`));
      if (!silent) console.log(`Whitelist ${options.tileListFile}: ${tiles.length}/${before} tuiles conservées`);
    } else if (!silent) {
      console.log(`Whitelist ${options.tileListFile} absente/invalide → sweep complet`);
    }
  }

  if (!silent) {
    console.log('TomTom Traffic — Vector Flow Tiles');
    console.log('Zone:', bbox);
    console.log('Zoom:', zoom, '→', tiles.length, 'tuile(s),', concurrency, 'en parallèle');
  }

  const allFeatures: DecodedFlowFeature[] = [];
  const nonEmptyTiles: TileId[] = [];
  let nextIndex = 0;
  let consecutiveFatalErrors = 0;
  let aborted = false;

  async function fetchOneTile(t: (typeof tiles)[0], i: number): Promise<void> {
    try {
      const buffer = await fetchTile(t.z, t.x, t.y);
      const features = decodeFlowTile(buffer, t.z, t.x, t.y);
      for (const f of features) {
        allFeatures.push(f);
      }
      if (features.length > 0) nonEmptyTiles.push(t);
      consecutiveFatalErrors = 0;
      if (!silent) console.log(`  Tuile ${i + 1}/${tiles.length} (${t.z}/${t.x}/${t.y}): ${features.length} segments`);
    } catch (err) {
      const fatal = err instanceof TomTomHttpError && FATAL_STATUS_CODES.has(err.status);
      if (fatal) {
        consecutiveFatalErrors++;
        if (consecutiveFatalErrors >= MAX_CONSECUTIVE_FATAL_ERRORS) aborted = true;
      }
      if (!silent) console.log(`  Tuile ${i + 1}/${tiles.length} (${t.z}/${t.x}/${t.y}): Erreur — ${err instanceof Error ? err.message : err}`);
    }
  }

  async function worker(): Promise<void> {
    while (!aborted) {
      const i = nextIndex++;
      if (i >= tiles.length) break;
      await fetchOneTile(tiles[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tiles.length) }, () => worker());
  await Promise.all(workers);

  if (aborted) {
    throw new Error(
      `Fetch abandonné : ${MAX_CONSECUTIVE_FATAL_ERRORS} erreurs fatales consécutives ` +
      `(auth/quota TomTom — ex. InsufficientFunds). Aucune donnée écrite.`
    );
  }

  const fc = toFeatureCollection(allFeatures);
  const fetchedAt = new Date().toISOString();
  const latestPath = join(outDir, 'flow-tiles-latest.json');
  const payload = {
    fetchedAt,
    bbox,
    zoom,
    tileCount: tiles.length,
    segmentCount: allFeatures.length,
    type: 'FeatureCollection',
    features: fc.features,
  };

  if (options.saveNonEmptyTo) {
    const list: TileListFile = {
      zoom,
      tiles: nonEmptyTiles.map((t) => [t.x, t.y]),
    };
    const listPayload = { ...list, bbox, generatedAt: fetchedAt };
    await mkdir(dirname(options.saveNonEmptyTo), { recursive: true });
    await writeFile(options.saveNonEmptyTo, JSON.stringify(listPayload), 'utf-8');
    if (!silent) console.log(`Whitelist écrite: ${options.saveNonEmptyTo} (${nonEmptyTiles.length} tuiles)`);
  }

  // 0 segment → ne rien écrire : évite d'écraser flow-tiles-latest.json
  // avec une donnée vide quand le run a partiellement échoué.
  if (!noWrite && allFeatures.length > 0) {
    await mkdir(outDir, { recursive: true });
    const ts = fetchedAt.replace(/[:.]/g, '-').slice(0, 19);
    const outPath = join(outDir, `flow-tiles-${ts}.json`);
    const jsonStr = JSON.stringify(payload, null, 2);
    await writeFile(outPath, jsonStr, 'utf-8');
    await writeFile(latestPath, jsonStr, 'utf-8');
    if (!silent) console.log('Écrit:', outPath, '+ flow-tiles-latest.json');
  } else if (!silent) {
    console.log(allFeatures.length === 0 ? '0 segment: aucun fichier écrit' : '(--no-write: aucun fichier écrit)');
  }

  return {
    filePath: noWrite || allFeatures.length === 0 ? '' : latestPath,
    features: fc.features as FetchTomTomResult['features'],
    bbox,
    zoom,
    segmentCount: allFeatures.length,
    nonEmptyTiles,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bboxIdx = argv.indexOf('--bbox');
  const bbox = bboxIdx >= 0 && argv[bboxIdx + 1]
    ? parseBbox(argv[bboxIdx + 1]!)
    : GENEVA_BBOX;

  const zoomIdx = argv.indexOf('--zoom');
  const zoom = zoomIdx >= 0 && argv[zoomIdx + 1]
    ? Math.max(0, Math.min(22, parseInt(argv[zoomIdx + 1]!, 10)))
    : 14;

  const outDirIdx = argv.indexOf('--out-dir');
  const outDir = outDirIdx >= 0 ? argv[outDirIdx + 1]! : join(process.cwd(), 'tomtom');
  const noWrite = argv.includes('--no-write');
  const concIdx = argv.indexOf('--concurrency');
  const concurrency = concIdx >= 0 && argv[concIdx + 1]
    ? Math.max(1, parseInt(argv[concIdx + 1]!, 10))
    : undefined;
  const tilesFileIdx = argv.indexOf('--tiles-file');
  const tileListFile = tilesFileIdx >= 0 ? argv[tilesFileIdx + 1] : undefined;
  const saveNonEmptyIdx = argv.indexOf('--save-nonempty');
  const saveNonEmptyTo = saveNonEmptyIdx >= 0 ? argv[saveNonEmptyIdx + 1] : undefined;

  await fetchTomTomTiles({ bbox, zoom, outDir, noWrite, concurrency, tileListFile, saveNonEmptyTo });
}

/**
 * Vrai seulement quand ce fichier est le point d'entrée CLI.
 * Un import depuis push-graphhopper ne doit pas relancer un fetch Genève.
 */
function isDirectCliRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectCliRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
