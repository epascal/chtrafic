#!/usr/bin/env node
/**
 * Envoie les données trafic (tuiles TomTom) vers une instance GraphHopper
 * au format datafeed (POST /datafeed).
 *
 * Prérequis : une instance GraphHopper qui expose POST /datafeed (traffic).
 * L’API cloud GraphHopper (graphhopper.com) ne propose pas /datafeed ; il faut
 * un serveur open source avec le module traffic (ex. graphhopper-traffic-data-integration).
 *
 * Note : l’image Docker israelhikingmap/graphhopper:10.0 est le moteur GraphHopper
 * officiel sans module traffic : elle n’expose pas /datafeed. Voir docs/GRAPHHOPPER-DOCKER.md.
 *
 * Usage:
 *   GRAPHHOPPER_URL=https://graphhopper.flowride.org npx tsx src/push-graphhopper.ts
 *   npx tsx src/push-graphhopper.ts --file tomtom/flow-tiles-latest.json
 *
 * Options:
 *   --fetch        Récupérer d’abord les tuiles TomTom (zoom 15) puis pousser (nécessite TOMTOM_API_KEY).
 *   --fetch-zoom N Zoom pour --fetch (défaut: 15).
 *   --fetch-tile-list PATH        Whitelist de tuiles (voir --tiles-file de fetch-tomtom-tiles).
 *   --fetch-save-tile-list PATH   Écrire les tuiles non vides du fetch dans ce fichier whitelist.
 *   --bbox lonMin,latMin,lonMax,latMax  Zone pour --fetch (défaut: Genève).
 *   --file PATH    Fichier JSON tuiles si pas --fetch (défaut: tomtom/flow-tiles-latest.json)
 *   --url URL      Base URL GraphHopper (ou GRAPHHOPPER_URL). Ex: https://graphhopper.flowride.org
 *   --dry-run      Ne pas envoyer, afficher le payload uniquement
 *   --limit N      Limiter à N segments (pour test)
 *
 * Format datafeed (GraphHopper) :
 *   value_type "speed" : value en km/h. Le serveur garde cette mesure, plafonnée par la vitesse libre OSM (max × 0.9).
 *   relative_speed optionnel ne remplace pas la mesure.
 *   value_type "relative_speed" : coefficient seul, speed = value × (max × 0.9).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fetchTomTomTiles, GENEVA_BBOX, parseBbox } from './fetch-tomtom-tiles.js';

const DEFAULT_FILE = join(process.cwd(), 'tomtom', 'flow-tiles-latest.json');
/** Fichier écrit pour tomtom-tiles.html (comparaison). */
const TILES_VIEW_FILE = join(process.cwd(), 'tomtom', 'flow-tiles-latest.json');
const DEFAULT_URL = process.env.GRAPHHOPPER_URL ?? 'http://localhost:8989';

type Feature = {
  type: string;
  geometry: { type: string; coordinates: number[][][] | number[][] };
  properties?: Record<string, unknown>;
};

/**
 * Extrait les lignes dirigées de la géométrie.
 * Chaque ring d'un MultiLineString est une polyligne orientée dans le sens de
 * circulation : les envoyer séparément permet au matching côté serveur de
 * respecter le sens. ~27 % des features sont des MultiLineString (les deux sens
 * d'une route peuvent être deux rings d'une même feature) — prendre seulement le
 * premier ring perdait la moitié des directions couvertes.
 */
function getLines(f: Feature): number[][][] {
  const g = f.geometry;
  if (!g || !g.coordinates) return [];
  if (g.type === 'LineString') {
    const ring = g.coordinates as number[][];
    return ring.length >= 2 ? [ring] : [];
  }
  if (g.type === 'MultiLineString') {
    return (g.coordinates as number[][][]).filter((r) => r != null && r.length >= 2);
  }
  return [];
}

/**
 * Mesure TomTom et coefficient.
 * Le serveur garde la mesure et la plafonne à la vitesse libre OSM de l'arête (max × 0.9).
 * Un plancher évite qu'une vitesse nulle retire l'arête du graphe.
 */
const MIN_ABSOLUTE_SPEED_KMH = 5;

function getDatafeedValue(f: Feature): { absolute: number | null; relative: number | null } | null {
  const p = f.properties;
  if (!p) return null;
  let absolute: number | null = null;
  let relative: number | null = null;
  if (typeof p.absolute_speed === 'number' && Number.isFinite(p.absolute_speed) && p.absolute_speed >= 0) {
    absolute = Math.max(MIN_ABSOLUTE_SPEED_KMH, p.absolute_speed);
  }
  if (typeof p.relative_speed === 'number' && Number.isFinite(p.relative_speed)) {
    relative = Math.max(0, Math.min(1, p.relative_speed));
  }
  if (absolute == null && relative == null) return null;
  return { absolute, relative };
}

function buildDatafeed(
  features: Feature[],
  limit?: number
): { payload: Array<{ id: string; points: number[][]; value: number; value_type: string; mode: string; relative_speed?: number }>; usedFeatures: Feature[] } {
  const payload: Array<{ id: string; points: number[][]; value: number; value_type: string; mode: string; relative_speed?: number }> = [];
  const usedFeatures: Feature[] = [];
  // Borne sur le payload (rings), pas sur les features : une feature MultiLineString
  // émet plusieurs entrées. Sans limite explicite, traiter toutes les features.
  const take = limit ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < features.length && payload.length < take; i++) {
    const f = features[i]!;
    const lines = getLines(f);
    const datafeedValue = getDatafeedValue(f);
    if (lines.length === 0 || datafeedValue == null) continue;
    const hasAbsolute = datafeedValue.absolute != null;
    for (const points of lines) {
      if (payload.length >= take) break;
      payload.push({
        id: String(payload.length + 1),
        points,
        value: hasAbsolute ? Math.round(datafeedValue.absolute!) : datafeedValue.relative!,
        value_type: hasAbsolute ? 'speed' : 'relative_speed',
        mode: 'REPLACE',
        ...(hasAbsolute && datafeedValue.relative != null ? { relative_speed: datafeedValue.relative } : {}),
      });
    }
    usedFeatures.push(f);
  }
  return { payload, usedFeatures };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const doFetch = argv.includes('--fetch');
  const fetchZoomIdx = argv.indexOf('--fetch-zoom');
  const fetchZoom = fetchZoomIdx >= 0 && argv[fetchZoomIdx + 1]
    ? Math.max(0, Math.min(22, parseInt(argv[fetchZoomIdx + 1]!, 10)))
    : 15;

  const fileIdx = argv.indexOf('--file');
  const file = fileIdx >= 0 && argv[fileIdx + 1] ? argv[fileIdx + 1]! : DEFAULT_FILE;

  const urlIdx = argv.indexOf('--url');
  const baseUrl = (urlIdx >= 0 && argv[urlIdx + 1] ? argv[urlIdx + 1] : process.env.GRAPHHOPPER_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const datafeedUrl = `${baseUrl}/datafeed`;

  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 && argv[limitIdx + 1] ? parseInt(argv[limitIdx + 1]!, 10) : undefined;

  let features: Feature[];
  let dataMeta: { bbox?: unknown } = {};

  if (doFetch) {
    const bboxIdx = argv.indexOf('--bbox');
    const bbox = bboxIdx >= 0 && argv[bboxIdx + 1]
      ? parseBbox(argv[bboxIdx + 1]!)
      : GENEVA_BBOX;
    const tileListIdx = argv.indexOf('--fetch-tile-list');
    const tileListFile = tileListIdx >= 0 ? argv[tileListIdx + 1] : undefined;
    const saveTileListIdx = argv.indexOf('--fetch-save-tile-list');
    const saveNonEmptyTo = saveTileListIdx >= 0 ? argv[saveTileListIdx + 1] : undefined;
    console.log('Récupération des tuiles TomTom (zoom', fetchZoom, ')…');
    const result = await fetchTomTomTiles({ bbox, zoom: fetchZoom, silent: false, tileListFile, saveNonEmptyTo });
    features = result.features as Feature[];
    dataMeta = { bbox: result.bbox };
    console.log('→', result.segmentCount, 'segments récupérés.\n');
  } else {
    let data: { features?: Feature[]; bbox?: unknown };
    try {
      const raw = await readFile(file, 'utf-8');
      data = JSON.parse(raw) as { features?: Feature[]; bbox?: unknown };
    } catch (e) {
      console.error('Fichier introuvable ou JSON invalide:', file);
      console.error(e);
      process.exit(1);
    }
    features = data.features ?? [];
    dataMeta = { bbox: data.bbox };
  }
  const { payload, usedFeatures } = buildDatafeed(features, limit);

  const skipped = features.length - usedFeatures.length;
  console.log('GraphHopper datafeed — depuis tuiles TomTom');
  console.log('Source:', doFetch ? `fetch zoom ${fetchZoom}` : file);
  console.log('Features en entrée:', features.length);
  if (skipped > 0) console.log('Features ignorées (géométrie/vitesse invalide):', skipped);
  console.log('Segments à envoyer:', payload.length);
  console.log('URL:', datafeedUrl);

  // Écrire le JSON pour tomtom-tiles.html (même jeu de segments pour comparer).
  // Sauté quand 0 segment : ne pas écraser la dernière bonne vue par un fichier vide.
  if (usedFeatures.length > 0) {
    const tilesView = {
      type: 'FeatureCollection' as const,
      features: usedFeatures,
      bbox: dataMeta.bbox,
      fetchedAt: new Date().toISOString(),
      segmentCount: usedFeatures.length,
    };
    try {
      await mkdir(dirname(TILES_VIEW_FILE), { recursive: true });
      await writeFile(TILES_VIEW_FILE, JSON.stringify(tilesView), 'utf-8');
      console.log('Écrit pour tomtom-tiles.html:', TILES_VIEW_FILE);
    } catch (e) {
      console.warn('Impossible d’écrire', TILES_VIEW_FILE, e);
    }
  }

  if (dryRun) {
    console.log('--dry-run: extrait du payload (5 premiers):');
    console.log(JSON.stringify(payload.slice(0, 5), null, 2));
    return;
  }

  if (payload.length === 0) {
    console.log('Aucun segment avec vitesse, rien à envoyer.');
    return;
  }

  const res = await fetch(datafeedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Erreur HTTP', res.status, res.statusText);
    console.error(text.slice(0, 500));
    if (res.status === 404) {
      console.error('\n→ L’instance GraphHopper doit exposer POST /datafeed (module traffic).');
      console.error('  flowride.org peut être derrière un autre chemin ou ne pas avoir le datafeed.');
    }
    process.exit(1);
  }

  const responseText = await res.text();
  console.log('OK:', res.status);
  try {
    const apiBody = JSON.parse(responseText) as { updated?: number; errors?: number };
    if (typeof apiBody.updated === 'number' || typeof apiBody.errors === 'number') {
      console.log('Réponse API:', apiBody);
      if (typeof apiBody.errors === 'number' && apiBody.errors > 0) {
        console.warn('→ Certains segments ont été rejetés par l’API (hors graphe, format invalide, etc.). Voir les logs serveur GraphHopper.');
      }
    }
  } catch {
    if (responseText.length > 0) console.log('Réponse (texte):', responseText.slice(0, 200));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
