# Tests E2E de punta a punta: plan

Estado: **propuesta** (2026-10-12). Solo el plan; no se implementa nada todavía. Decisiones pendientes de Luis en la
última sección.

## 1. Lo que ya hay

- **Harness**: `worker/playwright.config.ts`. Dos proyectos, `iphone` (iPhone 13) y `escritorio` (Desktop Chrome), en
  Chromium, con `locale: es-UY` y los service workers bloqueados. `worker/e2e/serve.mjs` sirve `public/` (la web
  compilada).
- **Worker simulado**: `worker/e2e/fake-worker.ts` y `page.route` en cada spec. No hay Worker real, ni R2, ni relay en
  los tests: las respuestas de `/api` las escribe el test.
- **Tests**: 21 archivos de `worker/e2e/*.spec.ts`, unos **81 tests** (contados con `grep` sobre `test(`), que corren en
  los dos proyectos, o sea unas 160 ejecuciones.
- **Capturas**: `visual.spec.ts` (5 pantallas × claro/oscuro × 2 proyectos = 20 capturas). Solo corre con `VISUAL=1`.
- **CI** (`.github/workflows/check-worker.yml`, se dispara con cambios en `worker/**` y `core/**`):
  - Trabajo `worker`: `tsc` del Worker y de la web, `node build.mjs`, `node --test worker/test/*.test.ts`, y después
    `npx playwright install --with-deps chromium` y `npx playwright test`. La instalación del navegador no tiene caché.
  - Trabajo `visual` (solo en PRs): compila main y el PR, saca las capturas de las dos y las compara. Es informativo:
    no frena el PR.
- **Tests de unidad del Worker**: `worker/test/*.test.ts` (`again`, `schedule`, `tokens`, `worker`). No los revisé en
  detalle para este plan; asumo que cubren la lógica del Worker y no la web.

## 2. Mapa de flujos contra la cobertura actual

| Flujo | Cubierto hoy | Hueco |
|---|---|---|
| Bienvenida y alta | `smoke.spec` (arranca en bienvenida, cambia el formulario según el proveedor, avisos); `inicio.spec` (logo) | Alta completa: crear la configuración, guardar credenciales, llegar a Canales. Nada de esto va contra un Worker real. |
| Código de casa y modo ver | `ver.spec`: pegar el código deja en modo ver; link quitado; filtro por categoría | Salir del modo ver pidiendo el código de la casa; código incorrecto; **que nunca se llegue al editor** sin el código, ni quitando `/ver` de la URL (decisión del 2026-10-12). |
| Canales | `canales.spec` (filas, filtro, buscar, búsqueda por programa, vista detallada, ocultar, selección); `barra-pildora` | Filtros de categoría: solo se listan las categorías visibles (regla del 2026-10-12). Revisar si ya está cubierto. |
| Categorías y orden | `categorias.spec` (lista, buscador, mover con teclado, hoja, orden de canales, páginas enteras, tirar para refrescar) | Que el orden de la lista coincida con el orden de las categorías en los filtros. |
| Hoja del canal | `canal.spec` (guía que encontró sola, ‹ ›, renombrar, sin guía, automática, mover, ocultar) | Lo que muestra cuando la guía cambia de día; cruce guardado (`cruce-cache.spec` lo toca). |
| Guía | `guide.spec` (resolución, programa corto, grilla y hoja del programa, Próximos, Tu mañana/tarde/noche, «Ahora», ayuda con `?`, esqueleto); `guia-categorias.spec` | La carga desde IndexedDB (caché de la guía, #301) y el comportamiento sin conexión. |
| Tu plan y recomendaciones | `tu-noche-habitos.spec` (sin hábitos, con hábitos y «No me interesa», publicidad que la IA reconoce, género, «Más como esto») | IA real: hoy todo va mockeado. Ningún test pasa por el clasificador por lotes. |
| Perfil, proveedor, cuenta, perfil, links | `perfiles.spec` (lista, cuenta, copiar link, agregar perfil, qué ve, compartir para ver, abrir en modo ver, tu código); `cards.spec` (copiar, QR, descartar) | «Probar canales caídos» de punta a punta (`relay.spec` cubre solo el aviso de relay caído); editar proveedor y cuenta (vencimiento, conexiones); quitar un link; un link usado en varios dispositivos. |
| Conexiones | Solo lo que aparece dentro de Perfil (cuenta y sus conexiones) | Pantalla de Conexiones como tal (ver `planes/conexiones.md`). |
| Modo ver completo | `ver.spec` (7 tests), `inicio.spec` (logo y esqueleto en modo ver), `reports.spec` (lo marcado desde modo ver), `barra-pildora` | Ajustes de tema: deben ser exactamente los 3 íconos del editor. Splash y skeleton igual que la edición, en los mismos casos. |
| PWA | `ver.spec` (manifest con su código) | Service worker y caché offline: el harness los bloquea, así que no se prueban. |
| Configuración | `settings.spec` (guía, avisos, versión, preferencias, actualizar la guía, otro dispositivo, letra grande) | Push y avisos del navegador (el Worker manda con `push.ts`; acá no hay nada). |
| Ayudas | `?` de la Guía y del modo ver | El resto de los temas de `.help-topic` (main, guide, settings, categories, links) y los `<Help>` de `ui/*.tsx`. Ninguno se abre en un test. |
| Primera carga que nunca falla | `inicio.spec` (logo a los 5 s), `revision.spec` (Reintentar la grilla, guía que no baja, «sin conexión») | Timeouts de 20 s; primer uso con cero configuraciones; respuesta lenta (no solo error); reintento que sí trae datos. |
| Tema claro y oscuro | Solo `visual.spec` (con `VISUAL=1`) | Los tests funcionales corren siempre en el tema por defecto. |
| iPhone y escritorio | Los dos proyectos corren todo | Tablet no está en el harness. Los paneles anclados del escritorio solo tienen 2 tests (`hojas.spec`). |

## 3. Lo que de verdad falta para «punta a punta»

1. **Todo el Worker es simulado.** Si el Worker cambia la forma de una respuesta, la web sigue pasando sus tests. Hoy
   nada lo detecta.
2. **No hay un Worker real en ningún lado de la prueba.** Eso incluye R2 (configuraciones, `short/`, `devices/`), que
   es lo que hace que los links de reproducción anden.
3. **El relay (Fly) y el proveedor no entran en CI.** Por la decisión de arquitectura (`docs/arquitectura.md`) el CI no
   tiene credenciales de proveedor. Se mantienen mockeados; no hay nada que probar contra un proveedor real en CI.

## 4. Fases

**Fase 0. Determinismo, antes de agregar tests**
- Quitar los `waitForTimeout(700)` de `canales.spec.ts` y `seleccion.spec.ts` (el toque después de mantener apretado).
  Esperar el estado (la hoja abierta, la selección marcada), no el tiempo.
- Fijar el reloj en todos los specs con `page.clock.setFixedTime(...)` (Playwright 1.56 lo soporta). Hoy `visual.spec`
  usa `NOW` fijo, pero `ver.spec` calcula `H` con `Date.now()`, y eso puede fallar al cambiar de hora.
- Mantener `animations: 'disabled'` solo en capturas. En funcionales, esperar con aserciones web-first (`expect(...)
  .toBeVisible()`), no con pausas.
- Caché del navegador de Playwright en el CI (`actions/cache`) o imagen con Chromium, para que la instalación no se
  repita en cada corrida.
- Medir antes de decidir: leer la duración de los últimos runs de `check-worker` (no medí tiempos para este plan).

**Fase 1. Huecos con el Worker simulado (rápidos, sin infraestructura nueva)**
- Alta completa y código de casa, incluido el «nunca llegar al editor sin código».
- Probar canales caídos de punta a punta (franja, detener, resultado).
- Pantalla de Conexiones.
- Ayudas: cada `?` y cada tema de `.help-topic` abre su texto. Una lista generada desde `ui/*.tsx` y
  `web/index.html` evita olvidarse de una.
- Primera carga: respuesta lenta (no solo error), reintento que trae datos, cero configuraciones.
- Tema oscuro en los flujos clave (alta, Canales, Guía, modo ver), no solo en capturas.

**Fase 2. Punta a punta contra un Worker real, local**
- Levantar el Worker de `worker/src/index.ts` con `wrangler dev` (o Miniflare) y R2 local, sembrar una configuración de
  prueba y correr un subconjunto: alta, Canales, Guía, modo ver con código, link de reproducción. Son 6 a 8 flujos.
- Esto cubre el contrato web ↔ Worker. Hay que verificar en la práctica que `wrangler dev` corre en el runner sin
  login; no lo probé.
- **Regla de seguridad**: estos tests nunca apuntan al Worker de producción, a su R2 real ni al relay de Fly. No tocan
  `short/` ni `devices/` de producción (hard rule del proyecto: los links de reproducción no se cambian).

**Fase 3. Visual y matriz**
- Sumar a `visual.spec.ts` las pantallas que faltan (alta, Conexiones, ayuda, Perfil) en claro y oscuro.
- Pasar la prueba de capturas de informativa a bloqueante, solo cuando lleve varias semanas sin falsos cambios.

**Lo que no se hace**: tests contra el proveedor real, contra el relay de producción o contra R2 de producción.

## 5. Cómo mantenerlos deterministas

- Las animaciones ya dieron flakies. Mitigación: reloj fijo, sin pausas, aserciones que esperan estado.
- Los `waitForTimeout` que quedan (`canales`, `seleccion`) se reemplazan en Fase 0.
- Datos fijos en `fake-worker.ts` (IDs, horas). Ya hay hora fija en `visual.spec` y `ver.spec` usa la real.
- `retries`: hoy es 0 en local y en CI no está configurado (queda el default de Playwright, que es 0). Propongo dejarlo en
  0 y arreglar cada flaky en vez de reintentar: un reintento que pasa esconde el problema.
- El filtro de 404 de consola en `perfiles.spec` es una excepción puntual. No conviene extenderlo.

## 6. Costo en CI (estimado; sin medir)

- Hoy: ~160 ejecuciones de funcionales + build + instalación de Chromium en cada corrida. La instalación suele ser el
  costo fijo más grande; el caché lo baja.
- Fase 1 suma pocos tests (decenas de segundos). Fase 2 suma el arranque de `wrangler dev` y un subconjunto corto.
- El trabajo `visual` compila dos veces y saca 20 capturas. Solo corre en PRs.
- Si la suite completa pasa de unos minutos, usar `--shard` en la matriz de proyectos.
- Opción: smoke corto en cada PR, suite completa en `main`. Ver decisiones.

## 7. Decisiones que necesito de Luis

1. **Fase 2 con Worker real local**: ¿sí? Recomiendo sí, con 6 a 8 flujos. Sin esto, la prueba no es punta a punta.
2. **Cuándo corre la suite completa**: ¿en cada PR, o un smoke corto en PR y la suite completa en `main`? Recomiendo lo
   segundo si el tiempo supera unos minutos.
3. **Retries**: ¿cero (arreglar flakies) o uno en CI? Recomiendo cero.
4. **Capturas**: ¿la prueba visual pasa a bloqueante en algún momento? Recomiendo esperar a que sea estable.
5. **Confirmar la regla**: los tests nunca tocan producción (Worker, R2, relay). Lo dejo escrito como regla del plan.
