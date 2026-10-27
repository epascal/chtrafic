#!/usr/bin/env node
/**
 * Récupère les données trafic TomTom (Flow Segment Data) pour une zone (par défaut Genève).
 * Génère une grille de points dans la bbox et appelle l’API pour chaque point.
 *
 * Usage:
 *   TOMTOM_API_KEY=xxx npx tsx src/fetch-tomtom.ts
 *   TOMTOM_API_KEY=xxx npx tsx src/fetch-tomtom.ts --bbox 6.0,46.1,6.2,46.3 --grid 4
 *
 * Options:
 *   --bbox lonMin,latMin,lonMax,latMax   Zone (défaut: Genève 6.05,46.10,6.20,46.25)
 *   --precision low|normal|high|max     Précision (défaut: max). max = zoom 14 + grille 12×12.
 *   --grid N                             Grille N×N points (surcharge --precision)
 *   --zoom N                             Zoom 0-22 (surcharge --precision)
 *   --out-dir PATH                       Dossier de sortie (défaut: ./tomtom)
 *   --no-write                           Ne pas écrire de fichier (test)
 *
 * Précision: low (zoom 10, 2×2) | normal (12, 4×4) | high (13, 8×8) | max (14, 12×12 = 144 pts).
 * Quota gratuit: 2 500 req/jour. max toutes les 5 min ≈ 41 472 req/jour → forfait payant.
 *
 * Pour lancer toutes les 5 minutes (ex. cron) :
 *   toutes les 5 min : 0/5 * * * * cd /chemin/chtrafic && TOMTOM_API_KEY=xxx npx tsx src/fetch-tomtom.ts --grid 2
 */

import { config } from './config.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const { tomtom } = config;
const BASE = tomtom.baseUrl;
const V = tomtom.serviceVersion;

/** Bbox Genève (lonMin, latMin, lonMax, latMax) */
const GENEVA_BBOX = { lonMin: 6.05, latMin: 46.1, lonMax: 6.2, latMax: 46.25 };

/** Précision : zoom élevé = routes secondaires/locales visibles, grille dense = plus de segments. */
const PRECISION_PRESETS = {
  low: { zoom: 10, gridN: 2 },      // 4 pts, gratuit
  normal: { zoom: 12, gridN: 4 },   // 16 pts
  high: { zoom: 13, gridN: 8 },     // 64 pts
  max: { zoom: 14, gridN: 12 },     // 144 pts, précision max
} as const;

interface FlowSegmentResponse {
  flowSegmentData?: {
    frc?: string;
    currentSpeed?: number;
    freeFlowSpeed?: number;
    currentTravelTime?: number;
    freeFlowTravelTime?: number;
    confidence?: number;
    roadClosure?: boolean;
    coordinates?: { coordinate?: Array<{ latitude: number; longitude: number }> };
  };
  error?: string;
  httpStatusCode?: number;
}

function parseBbox(s: string): { lonMin: number; latMin: number; lonMax: number; latMax: number } {
  const parts = s.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error('--bbox doit être lonMin,latMin,lonMax,latMax (4 nombres)');
  }
  const [lonMin, latMin, lonMax, latMax] = parts;
  if (lonMin >= lonMax || latMin >= latMax) throw new Error('bbox invalide (min < max)');
  return { lonMin, latMin, lonMax, latMax };
}

function gridPoints(
  bbox: { lonMin: number; latMin: number; lonMax: number; latMax: number },
  n: number
): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];
  const stepLon = (bbox.lonMax - bbox.lonMin) / (n + 1);
  const stepLat = (bbox.latMax - bbox.latMin) / (n + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      points.push({
        lat: bbox.latMin + stepLat * i,
        lon: bbox.lonMin + stepLon * j,
      });
    }
  }
  return points;
}

async function fetchFlowSegment(
  lat: number,
  lon: number,
  zoom: number,
  style = 'absolute'
): Promise<FlowSegmentResponse> {
  const url = `${BASE}/traffic/services/${V}/flowSegmentData/${style}/${zoom}/json?key=${encodeURIComponent(tomtom.apiKey)}&point=${lat},${lon}&unit=kmph`;
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as FlowSegmentResponse;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bboxIdx = argv.indexOf('--bbox');
  const bboxStr = bboxIdx >= 0 ? argv[bboxIdx + 1] : null;
  const bbox = bboxStr ? parseBbox(bboxStr) : GENEVA_BBOX;

  const precisionIdx = argv.indexOf('--precision');
  const precisionKey = (precisionIdx >= 0 && argv[precisionIdx + 1]) ? argv[precisionIdx + 1]! : 'max';
  const preset = PRECISION_PRESETS[precisionKey as keyof typeof PRECISION_PRESETS] ?? PRECISION_PRESETS.max;

  const gridIdx = argv.indexOf('--grid');
  const gridN = gridIdx >= 0 && argv[gridIdx + 1]
    ? Math.max(1, Math.min(24, parseInt(argv[gridIdx + 1]!, 10)))
    : preset.gridN;

  const zoomIdx = argv.indexOf('--zoom');
  const zoom = zoomIdx >= 0 && argv[zoomIdx + 1]
    ? Math.max(0, Math.min(22, parseInt(argv[zoomIdx + 1]!, 10)))
    : preset.zoom;

  const outDirIdx = argv.indexOf('--out-dir');
  const outDir = outDirIdx >= 0 ? argv[outDirIdx + 1]! : join(process.cwd(), 'tomtom');
  const noWrite = argv.includes('--no-write');

  const points = gridPoints(bbox, gridN);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log('TomTom Traffic — Flow Segment Data');
  console.log('Zone:', bbox);
  console.log('Précision:', precisionKey, '→ zoom', zoom, ', grille', gridN, '×', gridN, '=', points.length, 'points');

  const results: Array<{
    point: { lat: number; lon: number };
    data: FlowSegmentResponse;
  }> = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    process.stdout.write(`  ${i + 1}/${points.length} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})…`);
    try {
      const data = await fetchFlowSegment(p.lat, p.lon, zoom);
      results.push({ point: p, data });
      const speed = data.flowSegmentData?.currentSpeed ?? data.flowSegmentData?.freeFlowSpeed;
      console.log(speed != null ? ` ${speed} km/h` : ' (pas de vitesse)');
    } catch (err) {
      console.log(' Erreur:', err instanceof Error ? err.message : err);
      results.push({ point: p, data: { error: String(err) } });
    }
    // Limiter le débit pour éviter 429
    await new Promise((r) => setTimeout(r, 120));
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    bbox,
    gridN,
    zoom,
    segments: results.map((r) => ({
      point: r.point,
      currentSpeed: r.data.flowSegmentData?.currentSpeed,
      freeFlowSpeed: r.data.flowSegmentData?.freeFlowSpeed,
      currentTravelTime: r.data.flowSegmentData?.currentTravelTime,
      freeFlowTravelTime: r.data.flowSegmentData?.freeFlowTravelTime,
      confidence: r.data.flowSegmentData?.confidence,
      roadClosure: r.data.flowSegmentData?.roadClosure,
      frc: r.data.flowSegmentData?.frc,
      error: r.data.error,
    })),
  };

  if (!noWrite) {
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, `flow-${ts}.json`);
    const jsonStr = JSON.stringify(payload, null, 2);
    await writeFile(outPath, jsonStr, 'utf-8');
    await writeFile(join(outDir, 'flow-latest.json'), jsonStr, 'utf-8');
    console.log('Écrit:', outPath, '+ flow-latest.json');
  } else {
    console.log('(--no-write: aucun fichier écrit)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
