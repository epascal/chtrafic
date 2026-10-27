/**
 * Conversion bbox (WGS84) ↔ tuiles Web Mercator (z/x/y)
 * et conversion coordonnées tuile (0–4096) → WGS84.
 */

export interface Bbox {
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
}

export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** Retourne les indices tuile (x, y) pour un point (lon, lat) au zoom z. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  let x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  let y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  x = Math.max(0, Math.min(n - 1, x));
  y = Math.max(0, Math.min(n - 1, y));
  return { x, y };
}

/** Liste des tuiles (z,x,y) recouvrant la bbox au zoom z. */
export function bboxToTiles(bbox: Bbox, zoom: number): TileId[] {
  const tl = lonLatToTile(bbox.lonMin, bbox.latMax, zoom);
  const br = lonLatToTile(bbox.lonMax, bbox.latMin, zoom);
  const out: TileId[] = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) {
      out.push({ z: zoom, x, y });
    }
  }
  return out;
}

const EXTENT = 4096;

/** Convertit un point (px, py) en coordonnées 0–EXTENT dans la tuile (z,x,y) en (lon, lat) WGS84. */
export function tileCoordToLonLat(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
  extent = EXTENT
): [number, number] {
  const n = Math.pow(2, z);
  const lon = ((x + px / extent) / n) * 360 - 180;
  const yNorm = (y + py / extent) / n;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm)));
  const lat = (latRad * 180) / Math.PI;
  return [lon, lat];
}
