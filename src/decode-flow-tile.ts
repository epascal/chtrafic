/**
 * Décodage d’une tuile PBF TomTom Traffic (Vector Flow Tiles)
 * en GeoJSON en utilisant le format MVT (compatible Mapbox).
 */

import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import type { Feature, FeatureCollection } from 'geojson';

const FLOW_LAYER_NAMES = ['Traffic flow', 'traffic_flow', 'flow'];

export interface DecodedFlowFeature {
  type: 'Feature';
  geometry: Feature['geometry'];
  properties: Record<string, unknown>;
}

/**
 * Décode un buffer PBF (tuile Vector Flow TomTom) et retourne des Features GeoJSON.
 * @param buffer Données binaires de la tuile
 * @param z zoom, @param tx tile x, @param ty tile y (pour conversion en WGS84)
 */
export function decodeFlowTile(
  buffer: ArrayBuffer | Uint8Array,
  z: number,
  tx: number,
  ty: number
): DecodedFlowFeature[] {
  const pbf = new Pbf(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);
  const vt = new VectorTile(pbf);
  const features: DecodedFlowFeature[] = [];

  const layerName = Object.keys(vt.layers).find((name) =>
    FLOW_LAYER_NAMES.some((n) => name.toLowerCase().includes(n.toLowerCase()))
  ) ?? Object.keys(vt.layers)[0];

  if (!layerName) return features;

  const layer = vt.layers[layerName];
  if (!layer) return features;

  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    try {
      const geojson = f.toGeoJSON(tx, ty, z);
      features.push({
        type: 'Feature',
        geometry: geojson.geometry,
        properties: geojson.properties ?? {},
      });
    } catch {
      // skip feature if geometry decode fails
    }
  }

  return features;
}

export function toFeatureCollection(features: DecodedFlowFeature[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features as Feature[],
  };
}
