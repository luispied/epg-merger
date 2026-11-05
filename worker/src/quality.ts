// Calidad en el nombre del canal (la playlist de TiviMate): la resolución que midió el relay (streamcheck.ts)
// va al final del nombre con letras pequeñas: «TNT ᶠᴴᴰ». Reemplaza el texto de calidad que puso el proveedor
// («HD», «FHD», «1080p»…). Sin medida, el nombre queda como viene.
import type { Res } from './streamcheck.ts';
import { stripQualityText } from '../../core/src/names.ts';

export type QualityLabel = 'SD' | 'HD' | 'FHD' | '4K';

/** Las mismas franjas que la etiqueta de Canales (web/app.ts qualityOf): 1000 px de alto es FHD, 1800 es 4K. */
export function qualityLabel(h: number): QualityLabel {
  return h >= 1800 ? '4K' : h >= 1000 ? 'FHD' : h >= 700 ? 'HD' : 'SD';
}

const SUPERSCRIPT: Record<QualityLabel, string> = { SD: 'ˢᴰ', HD: 'ᴴᴰ', FHD: 'ᶠᴴᴰ', '4K': '⁴ᴷ' };
const SUPERDIGIT: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

/** Los fps en un número entero (59,94 queda en 60) y en superíndices, con la marca «ᶠᵖˢ» al final. */
export function fpsSuffix(fps: number): string {
  return `${String(Math.round(fps)).replace(/\d/g, (d) => SUPERDIGIT[d])}ᶠᵖˢ`;
}

/** El nombre con la calidad medida al final, sin el texto de calidad que traía: «TNT ᴴᴰ ⁵⁰ᶠᵖˢ». */
export function nameWithQuality(name: string, label: QualityLabel, fps?: number): string {
  const clean = stripQualityText(name);
  if (!clean) return name;
  return `${clean} ${SUPERSCRIPT[label]}${fps ? ` ${fpsSuffix(fps)}` : ''}`;
}

/** Lo que midió el relay por canal: la etiqueta de calidad y, si lo dio, los cuadros por segundo. */
export interface Measured { label: QualityLabel; fps?: number }

/** Calidad y fps por canal (id), a partir de lo que midió el relay. Sin medida con ancho y alto, no entra. */
export function qualityMap(res: Record<string, Res> | undefined): Map<string, Measured> {
  const out = new Map<string, Measured>();
  for (const [id, r] of Object.entries(res ?? {})) {
    if (!r.w || !r.h) continue;
    const fps = r.f && r.f >= 1 && r.f <= 240 ? Math.round(r.f) : undefined;
    out.set(id, { label: qualityLabel(r.h), fps });
  }
  return out;
}
