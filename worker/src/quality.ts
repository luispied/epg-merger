// Calidad en el nombre del canal (la playlist de TiviMate): la resolución que midió el relay (streamcheck.ts)
// va al final del nombre con letras pequeñas: «TNT ꜰᴴᴰ». Reemplaza el texto de calidad que puso el proveedor
// («HD», «FHD», «1080p»…). Sin medida, el nombre queda como viene.
import type { Res } from './streamcheck.ts';

export type QualityLabel = 'SD' | 'HD' | 'FHD' | '4K';

/** Las mismas franjas que la etiqueta de Canales (web/app.ts qualityOf): 1000 px de alto es FHD, 1800 es 4K. */
export function qualityLabel(h: number): QualityLabel {
  return h >= 1800 ? '4K' : h >= 1000 ? 'FHD' : h >= 700 ? 'HD' : 'SD';
}

// Mayúsculas: Unicode no tiene F ni S en superíndice mayúscula, así que se usan las versiones de letra pequeña (ꜰ, ꜱ).
const SUPERSCRIPT: Record<QualityLabel, string> = { SD: 'ꜱᴰ', HD: 'ᴴᴰ', FHD: 'ꜰᴴᴰ', '4K': '⁴ᴷ' };

// Texto de calidad que pone el proveedor, y también las marcas ya en letras pequeñas (ᵁᴴᴰ, ᶠᴴᴰ…), para no duplicar.
const QUALITY_TOKEN = /(?:^|\s)[([]?(?:UHD|FHD|QHD|HD|SD|4K|2160p|1440p|1080[pi]|720p|576p|480p|ᵁᴴᴰ|ᶠᴴᴰ|ᴴᴰ|ˢᴰ|ꜰᴴᴰ|ꜱᴰ|⁴ᴷ)[)\]]?(?=\s|$)/gi;

/** El nombre con la calidad medida al final, sin el texto de calidad que traía. */
export function nameWithQuality(name: string, label: QualityLabel): string {
  const clean = name.replace(QUALITY_TOKEN, '').replace(/\s{2,}/g, ' ').trim();
  return clean ? `${clean} ${SUPERSCRIPT[label]}` : name;
}

/** Calidad por canal (id), a partir de lo que midió el relay. Sin medida con ancho y alto, no entra. */
export function qualityMap(res: Record<string, Res> | undefined): Map<string, QualityLabel> {
  const out = new Map<string, QualityLabel>();
  for (const [id, r] of Object.entries(res ?? {})) if (r.w && r.h) out.set(id, qualityLabel(r.h));
  return out;
}
