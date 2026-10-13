// La guía XMLTV que baja el reproductor (/g/<código>.xml.gz) para un perfil infantil (kids.ts): sin los <programme>
// cuyo título no es apto. La guía del perfil es la de la configuración entera (epg/<cfgId>.xml.gz), así que se filtra
// al pasar: se descomprime, se saca lo no apto y se vuelve a comprimir, sin guardar la guía entera en memoria.
// Qué es apto sale del mismo índice que usa el modo ver (ui/schedule/topics.json, por título normalizado), así que
// un título sin género o sin clasificar no sale nunca. Si el índice falta, la guía sale vacía (lo seguro).
import type { R2Bucket } from './env.ts';
import { isApt, type Kids } from './kids.ts';
import { gunzip, readStored } from './schedule.ts';

const TOPICS = 'ui/schedule/topics.json';
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; apt: Set<string> }>();

/** Igual que `norm` de tools/measure_titles.py: espacios juntos y en minúsculas (la clave del índice). */
export const titleKey = (title: string): string => title.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** Los títulos (ya normalizados) con un género apto para el perfil. */
export async function aptTitles(bucket: R2Bucket, kids: Kids): Promise<Set<string>> {
  const id = kids.genres.join('|');
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.apt;
  const raw = await readStored(bucket, TOPICS);
  if (!raw) return new Set();
  const idx = JSON.parse(raw.gz ? await gunzip(raw.bytes) : new TextDecoder().decode(raw.bytes)) as { g?: string[]; t?: string[]; r?: number[][] };
  const genres = idx.g ?? [];
  const apt = new Set<string>();
  (idx.t ?? []).forEach((name, i) => {
    const g = idx.r?.[i]?.[0] ?? -1;
    if (g >= 0 && isApt(genres[g], kids)) apt.add(name);
  });
  cache.set(id, { at: Date.now(), apt });
  return apt;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Las entidades de un texto XML (&amp; &#233; &#xE9;…). Una pasada: lo decodificado no se vuelve a decodificar. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== '#') return ENT[e.toLowerCase()] ?? all;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

const OPEN = '<programme';
const CLOSE = '</programme>';

/** Quita de una guía XMLTV los <programme> que no son aptos. Recibe el texto por trozos y devuelve lo que sigue. */
export class KidsGuide {
  private readonly apt: Set<string>;
  private buf = '';
  constructor(apt: Set<string>) {
    this.apt = apt;
  }

  push(text: string): string {
    this.buf += text;
    let out = '';
    for (;;) {
      const start = this.buf.indexOf(OPEN);
      if (start < 0) {
        // Puede quedar al final el comienzo de un <programme (cortado entre dos trozos).
        const cut = Math.max(0, this.buf.length - (OPEN.length - 1));
        out += this.buf.slice(0, cut);
        this.buf = this.buf.slice(cut);
        return out;
      }
      out += this.buf.slice(0, start);
      const end = this.buf.indexOf(CLOSE, start);
      if (end < 0) {
        this.buf = this.buf.slice(start);
        return out;
      }
      const block = this.buf.slice(start, end + CLOSE.length);
      if (this.kept(block)) out += block;
      this.buf = this.buf.slice(end + CLOSE.length);
    }
  }

  /** Al terminar: lo que queda afuera, y un programa a medio escribir nunca sale. */
  end(): string {
    const start = this.buf.indexOf(OPEN);
    const rest = start < 0 ? this.buf : this.buf.slice(0, start);
    this.buf = '';
    return rest;
  }

  private kept(block: string): boolean {
    const m = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/.exec(block);
    return !!m && this.apt.has(titleKey(decodeEntities(m[1])));
  }
}

/** La guía comprimida en gzip (como la guarda la corrida) pasada por el filtro, y vuelta a comprimir. */
export function filterGuide(body: ReadableStream<Uint8Array<ArrayBuffer>>, apt: Set<string>): ReadableStream<Uint8Array<ArrayBuffer>> {
  const guide = new KidsGuide(apt);
  const filter = new TransformStream<string, string>({
    transform(chunk, controller) {
      const out = guide.push(chunk);
      if (out) controller.enqueue(out);
    },
    flush(controller) {
      const out = guide.end();
      if (out) controller.enqueue(out);
    },
  });
  return body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(filter)
    .pipeThrough(new TextEncoderStream())
    .pipeThrough(new CompressionStream('gzip'));
}
