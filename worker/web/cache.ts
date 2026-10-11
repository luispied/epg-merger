// Caché en IndexedDB de este navegador, para lo que cuesta calcular y cambia poco (hoy, el cruce de canales con la
// guía). Cada nombre guarda una sola entrada, con una clave que la identifica: si la clave no coincide (cambió la
// guía, la lista o las preferencias), no se usa. Sin IndexedDB (navegación privada, bloqueado), todo sigue igual, sin caché.
const DB = 'nowline';
const STORE = 'cache';

let dbp: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

/** Lo guardado con `name`, si su clave es la misma; si no, null. */
export async function readCache<T>(name: string, key: string): Promise<T | null> {
  try {
    const db = await open();
    if (!db) return null;
    const rec = await new Promise<{ key: string; value: T } | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rec && rec.key === key ? rec.value : null;
  } catch {
    return null;
  }
}

/** Reemplaza lo guardado con `name`. */
export async function writeCache(name: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value }, name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Sin caché: la próxima vez se vuelve a calcular.
  }
}

/** SHA-256 en hexadecimal: una clave corta para comparar lo que cambia. */
export async function hashKey(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
