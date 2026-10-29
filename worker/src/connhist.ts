// Historial de conexiones en uso de una cuenta (lo que guarda connlog.ts), listo para la pantalla de Conexiones: las
// últimas 24 horas y las veces que subió el número. Sin imports: lo usa también la web.

export interface ConnPoint { t: string; n: number; max?: number }
export interface ConnHistory {
  /** Por hora, de la más vieja a la actual: el máximo de conexiones en uso; null si no hubo muestras esa hora. */
  hours: (number | null)[];
  /** Momentos (ms) en que una muestra marcó más conexiones que la anterior, de las últimas 24 horas. */
  rises: number[];
}

const HOUR_MS = 3600 * 1000;
/** Un link figura «probable» si el número subió dentro de esto después de que abrió su canal. El proveedor tarda 4 a 5
 *  minutos en sumar la conexión, y la muestra corre cada 10: 20 minutos cubren los dos. */
export const PROBABLE_AFTER_MS = 20 * 60 * 1000;

export function connHistory(points: ConnPoint[], now: number): ConnHistory {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const hours: (number | null)[] = Array(24).fill(null);
  const rises: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const t = Date.parse(points[i].t);
    const h = Math.floor((t - start) / HOUR_MS);
    if (h >= 0 && h <= 23) hours[h] = Math.max(hours[h] ?? 0, points[i].n);
    if (i > 0 && points[i].n > points[i - 1].n && t >= now - 24 * HOUR_MS) rises.push(t);
  }
  return { hours, rises };
}

/** Si después de que el link abrió su canal (`playT`) subió el número de conexiones. Es una pista, no una certeza. */
export function probableLink(rises: number[], playT: string): boolean {
  const t = Date.parse(playT);
  return rises.some((r) => r >= t && r - t <= PROBABLE_AFTER_MS);
}
