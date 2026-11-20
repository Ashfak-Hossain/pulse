import { cellToLatLng, latLngToCell } from 'h3-js';

// The coarse place of a point: its H3 cell at resolution 8 (about 0.7 km²). The server computes
// it; clients never send one. Moves to @pulse/geo when that package exists
export function h3Cell(location: { lat: number; lng: number }): string {
  return latLngToCell(location.lat, location.lng, 8);
}

/** The centre of a cell: the only point the server keeps of a home pin. */
export function h3CellCentre(cell: string): { lat: number; lng: number } {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}
