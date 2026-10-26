import { useEffect, useState } from 'preact/hooks';
import { Skeleton } from './kit.tsx';

// Sinopsis de películas y series (tools/sinopsis_tmdb.py): un solo archivo que se baja la primera vez que se abre una
// hoja de programa y queda en memoria. La clave es el título como lo normaliza el script; null si no hay sinopsis.
interface Sinopsis { [titulo: string]: { s: string } | null }

/** Igual que `normalizar` de tools/sinopsis_tmdb.py: sin tildes ni símbolos, en minúsculas y con espacios simples. */
export const claveTitulo = (titulo: string) =>
  titulo.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

let loaded: Promise<Sinopsis | null> | null = null;
/** El archivo de sinopsis, una sola vez por sesión; si no llega, vuelve a probar en la próxima hoja. */
function loadSinopsis(): Promise<Sinopsis | null> {
  loaded ??= fetch('/api/ui/sx.json', { signal: AbortSignal.timeout(30_000) })
    .then((r) => (r.ok ? r.json() as Promise<Sinopsis> : null))
    .catch(() => null)
    .then((sx) => { if (!sx) loaded = null; return sx; });
  return loaded;
}

const PLEGAR_DESDE = 160; // caracteres: un texto más corto entra en tres líneas y no lleva «Ver más»

/** Lo que dice el programa en la hoja: la sinopsis de la película o serie si la hay, si no lo que dice la guía.
 *  Se pliega a tres líneas con «Ver más». Mientras llega el archivo, el esqueleto de siempre. */
export function Descripcion({ titulo, guia }: { titulo: string; guia?: string }) {
  const [sx, setSx] = useState<Sinopsis | null | undefined>(undefined);
  const [abierta, setAbierta] = useState(false);
  useEffect(() => { void loadSinopsis().then(setSx); }, []);
  if (sx === undefined) return <Skeleton rows={2} />;
  const texto = sx?.[claveTitulo(titulo)]?.s || guia;
  if (!texto) return null;
  const larga = texto.length > PLEGAR_DESDE;
  return (
    <>
      <p class={`gd-sh-desc${larga && !abierta ? ' plegada' : ''}`}>{texto}</p>
      {larga && (
        <button type="button" class="link-btn" aria-expanded={abierta} onClick={() => setAbierta(!abierta)}>
          {abierta ? 'Ver menos' : 'Ver más'}
        </button>
      )}
    </>
  );
}
