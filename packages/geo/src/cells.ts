import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';

// A point on Earth in degrees (WGS84, the same system as GPS and PostGIS SRID 4326).
export interface Point {
  lat: number;
  lng: number;
}

// An H3 cell ID, 15 hex characters
export type Cell = string;

// Homes are stored at resolution 8 (about 0.74 km²)
export const HOME_RESOLUTION = 8;

// The H3 cell that contains a point. O(1).
export function toCell(point: Point, resolution = HOME_RESOLUTION): Cell {
  return latLngToCell(point.lat, point.lng, resolution);
}

// The centre of a cell: the only position we ever show for a home. O(1).
export function cellCenter(cell: Cell): Point {
  const [lat, lng] = cellToLatLng(cell);

  return { lat, lng };
}

// The cell itself plus every cell within k rings of it: 1, 7, 19, 37… cells. O(k²).
export function cellsWithin(cell: Cell, k: number): Cell[] {
  return gridDisk(cell, k);
}
