// La programación que sube la corrida diaria a R2 (tools/pack_schedule.py):
//   ui/schedule/s/<xx>             los canales en 256 tandas: 8 dígitos con el largo del encabezado, el
//                                  encabezado ({archivo: [desde, largo]}, desde el fin del encabezado) y
//                                  la programación de cada canal en gzip ([inicio, fin, título, descripción?][])
//   ui/schedule/hour/<hora>.json   índices por hora, guardados en gzip (Content-Encoding: gzip)
// Un canal se lee con dos lecturas por rango (el encabezado y sus bytes) y viaja comprimido tal cual.
// Mientras no exista la tanda (antes de la primera corrida con este formato) se lee el archivo viejo
// ui/schedule/<archivo>.json.
import type { R2Bucket } from './env.ts';

export type Entry = [number, number, string, string?];
type Header = { start: number; index: Record<string, [number, number]> };

const DIGITS = 8;
const FIRST_READ = 8192; // los encabezados rondan los 2,5 KB

const dec = new TextDecoder();

async function readHeader(bucket: R2Bucket, key: string): Promise<Header | null> {
  // Una tanda más corta que la primera lectura (no pasa con la guía real) se lee entera.
  let obj = await bucket.get(key, { range: { offset: 0, length: FIRST_READ } }).catch(() => bucket.get(key));
  if (!obj) return null;
  let bytes = new Uint8Array(await obj.arrayBuffer());
  const len = Number(dec.decode(bytes.subarray(0, DIGITS)));
  if (!Number.isInteger(len) || len <= 0) return null;
  if (bytes.length < DIGITS + len) {
    obj = await bucket.get(key, { range: { offset: 0, length: DIGITS + len } });
    if (!obj) return null;
    bytes = new Uint8Array(await obj.arrayBuffer());
  }
  return { start: DIGITS + len, index: JSON.parse(dec.decode(bytes.subarray(DIGITS, DIGITS + len))) };
}

/** La programación de un canal (por el nombre de archivo, sha1 de 16): `gz` si los bytes vienen en gzip. */
export type Raw = { gz: boolean; bytes: Uint8Array<ArrayBuffer> };

/** Lector con memoria de encabezados: para leer muchos canales en un mismo pedido. */
export function scheduleReader(bucket: R2Bucket): (file: string) => Promise<Raw | null> {
  const headers = new Map<string, Promise<Header | null>>();
  return async (file) => {
    const key = `ui/schedule/s/${file.slice(0, 2)}`;
    if (!headers.has(key)) headers.set(key, readHeader(bucket, key).catch(() => null));
    const header = await headers.get(key)!;
    if (!header) {
      const old = await bucket.get(`ui/schedule/${file}.json`);
      return old ? { gz: false, bytes: new Uint8Array(await old.arrayBuffer()) } : null;
    }
    const at = header.index[file];
    if (!at) return null;
    const obj = await bucket.get(key, { range: { offset: header.start + at[0], length: at[1] } });
    return obj ? { gz: true, bytes: new Uint8Array(await obj.arrayBuffer()) } : null;
  };
}

/** Un índice por hora: en gzip desde que la corrida los empaca, en texto los de antes. */
export async function readHour(bucket: R2Bucket, key: string): Promise<Raw | null> {
  const obj = await bucket.get(key);
  return obj ? { gz: obj.httpMetadata?.contentEncoding === 'gzip', bytes: new Uint8Array(await obj.arrayBuffer()) } : null;
}

export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

/** Las entradas de un canal, ya descomprimidas (null si no hay o no se pueden leer). */
export async function readEntries(read: (file: string) => Promise<Raw | null>, file: string): Promise<Entry[] | null> {
  try {
    const raw = await read(file);
    if (!raw) return null;
    const data = JSON.parse(raw.gz ? await gunzip(raw.bytes) : dec.decode(raw.bytes));
    return Array.isArray(data) ? data as Entry[] : null;
  } catch {
    return null;
  }
}
