# ¿Pasar la web de Grilla a React?

Evaluación sobre `main` (1.25.5). Medido en el repo, no estimado, salvo donde se indica.

**Decisión (Luis, 2026-10-09): Preact gradual.** La Guía es la primera pantalla nueva en Preact y las viejas se migran de a una.

## Cómo está hoy

- **Un solo archivo**: `worker/web/app.ts`, 4.895 líneas, 30 secciones (canales, perfiles, editor, links, push…).
- **Render por strings**: 56 `innerHTML`, 46 `addEventListener` manuales, 176 búsquedas de nodos por id/selector. `render()` se llama desde 25 lugares y rehace `#cards` entero en cada cambio.
- **Lo que ya cuida la performance**: lista paginada con sentinela (`state.shown`, IntersectionObserver), `content-visibility: auto` en las filas, memo por canal durante el render (`infoMemo`, pensado para 10.000 canales).
- **Peso** (build actual): `app.js` 150 KB min / **50 KB gzip** (incluye `@grilla/core`), `app.css` 98 KB / 21 KB gzip. Build con esbuild, sin framework. Service worker cachea por hash.
- **Tests**: ninguno de UI. Los tests cubren el Worker y `core`, no la web.

## ¿Mejora la app con React?

**Performance: no, por sí solo.** La lista ya está paginada y el costo real está en cuántos nodos hay en pantalla, no en quién los crea. React 19 suma ~60 KB gzip (react + react-dom, cifra conocida, no medida acá): duplica el JS de la primera carga. En la grilla tipo TiviMate lo que decide la fluidez es virtualizar en dos ejes (filas de canales y franja horaria), y eso hay que hacerlo con o sin framework.

**Escalabilidad y mantenimiento: sí, bastante.** Es donde está el dolor real:
- El estado y el DOM se sincronizan a mano. Cada pantalla nueva repite el patrón `innerHTML` + buscar nodos + colgar listeners, y un `render()` completo pierde foco, selección y scroll si no se cuida.
- Componentes con estado propio (hojas, filas, chips, el editor) se podrían probar y reutilizar. La Guía va a necesitar exactamente eso: celdas, detalle, recordatorio, "cambiar la guía".
- Un archivo de 4.900 líneas hace que hilos en paralelo choquen seguido.

**UI más pulida: indirectamente.** El pulido sale del CSS y del diseño, que ya son buenos y se conservan. Lo que sí trae el ecosistema son piezas accesibles hechas (menús, hojas, listas virtuales, animaciones de entrada y salida) que hoy se escriben a mano.

## Opciones

| | Peso extra (gzip) | Gana mantenimiento | Ecosistema | Riesgo |
|---|---|---|---|---|
| Quedarse vanilla | 0 | No | — | Bajo hoy, crece con cada pantalla |
| **Preact + signals** | ~6 KB | Sí | Casi todo React vía `preact/compat` | Bajo |
| React 19 | ~60 KB | Sí | Completo | Bajo, pero más JS |
| Reescritura total de una | — | Sí | — | **Alto**: 4.900 líneas sin tests de UI |

## Recomendación

**Preact con signals, migración incremental, y la Guía como primera pantalla nueva escrita en Preact.**

- Misma forma de escribir que React (JSX/TSX, hooks, componentes), con el peso de una librería chica. Si algún día hace falta una pieza que solo anda en React, `preact/compat` cubre la mayoría, y pasar de Preact a React es cambiar imports.
- Signals encaja con el `state` global que ya existe: se puede envolver sin reescribir la lógica, y solo se re-renderiza lo que cambió (mejor que el `render()` completo de hoy).
- esbuild ya compila TSX: no hace falta Vite ni otra herramienta. El Worker sigue sirviendo `public/` igual.
- El CSS (`base.css`, `web.css`) queda como está. Nada de Tailwind ni CSS-in-JS.

React completo lo elegiría solo si sabés que vas a querer librerías grandes de React (React Aria, Motion) desde el principio.

## Plan (en PRs, cada uno verde y con capturas)

1. **Base** (1.25.7): Preact en el build (`jsxImportSource`, componentes en `worker/web/ui/`), el aviso (toast) como primera pieza, y tests de humo con Playwright (`worker/e2e/`, también en CI). Sin cambios visibles. `@preact/signals` entra con la Guía, que es la primera que lo usa.
2. **Guía nueva en Preact** (el trabajo del otro hilo), con virtualización en los dos ejes. Convive con el resto vanilla.
3. **Migrar por pantalla**, de lo más aislado a lo más central: Perfil/cuentas (~1.100 líneas; hecho en 1.27.1, `worker/web/ui/perfiles.tsx`), Links (las tarjetas de arriba; hecho en 1.27.2, `worker/web/ui/cards.tsx`), Configuración y push (hecho en 1.27.4, `worker/web/ui/settings.tsx`), Categorías y orden (hecho en 1.27.5, `worker/web/ui/categorias.tsx`), editor de canal (hecho en 1.27.6, `worker/web/ui/canal.tsx`; la guía asignada y las opciones son islas de HTML de la lista hasta que la lista migre), y por último la lista de Canales (hecho en 1.27.7, `worker/web/ui/canales.tsx`; los gestos y menús de la lista siguen en `app.ts`). Las piezas compartidas de la guía (logo, «ahora», opción elegible, buscador, programación del día) pasaron a `worker/web/ui/epg.tsx` en 1.33.2, junto con la hoja de la selección (`worker/web/ui/seleccion.tsx`). Cada pantalla suma sus tests de humo sobre el Worker de prueba (`worker/e2e/fake-worker.ts`).
4. Al final se borra el helper de `innerHTML` y `app.ts` queda como arranque.

Cada paso es reversible y la app sigue funcionando entera entre uno y otro. Calculo unos 8 a 10 PRs en total (inferido, depende de cuánto se rediseñe en el camino).
