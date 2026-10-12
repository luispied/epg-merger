// Piezas comunes de la interfaz (auditoría de diseño, paso 3b). Las pantallas las usan en vez de armar el mismo marcado
// cada una: así se ven y se comportan igual en todos lados.

/** Barra de cuánto va (0 a 100). `cls` elige el tamaño de la pantalla (np-bar: fila y hoja; vw-bar: modo ver; rv-bar:
 *  revisión). Con `label` es una barra de progreso para el lector de pantalla; sin, es decorativa (el texto de al lado ya
 *  dice cuánto queda). */
export function Progress({ value, cls, label }: { value: number; cls: string; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const bar = <i style={{ width: `${pct}%` }} />;
  return label
    ? <div class={cls} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>{bar}</div>
    : <span class={cls} aria-hidden="true">{bar}</span>;
}

/** La marca al pie (Configuración y modo ver): ícono y wordmark chicos. Las pestañas llevan su título, no la marca; en
 *  el escritorio el ícono va arriba de la barra lateral. */
export function BrandFoot() {
  return (
    <div class="brand-foot">
      <img src="img/icon.svg" alt="" width="28" height="28" />
      <span class="wordmark"><span aria-hidden="true">nowl<span class="wm-i">ı</span>ne</span><span class="sr-only">nowline</span></span>
    </div>
  );
}
