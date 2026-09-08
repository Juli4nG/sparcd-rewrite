import type { AppliedTag } from './drafts';

export const SPECIES_DRAG_TYPE = 'application/x-sparcd-species';

export type SpeciesDragData = { scientificName: string; commonName: string };

export const encodeSpeciesDrag = (data: SpeciesDragData): string => JSON.stringify(data);

export function parseSpeciesDrag(raw: string): AppliedTag | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const { scientificName, commonName } = value as Record<string, unknown>;
    if (typeof scientificName !== 'string' || !scientificName.trim()) return null;
    if (typeof commonName !== 'string') return null;
    return { scientificName: scientificName.trim(), commonName, count: 1 };
  } catch {
    return null;
  }
}
