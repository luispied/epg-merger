# Diseño de Nowline

Guía de referencia de la interfaz web: los tokens, los estados de los controles y los componentes que ya existen. Las
reglas de trabajo (qué se revisa antes de mergear un cambio de interfaz) están en `CLAUDE.md`; el plan y el estado de la
auditoría, en `planes/auditoria-diseno.md`.

## Dónde vive cada cosa

| Qué | Dónde |
| --- | --- |
| Colores, sombras, formas, medidas, escalas | `worker/web/tokens.css` (único lugar que los define) |
| Estilos base y de componentes | `worker/web/base.css` y `worker/web/web.css`: solo piden tokens con `var()` |
| Piezas compartidas de la interfaz | `worker/web/ui/kit.tsx` |
| Pantallas | `worker/web/ui/*.tsx` |

Cada token se escribe una sola vez con `light-dark(claro, oscuro)`. `worker/tokens.mjs` lo expande al armar la hoja de
estilos, así anda en cualquier navegador. El tema lo elige el sistema, salvo que la persona lo fuerce en Configuración
(`data-theme`). Un valor con comas propias (una sombra de varias capas) separa el claro del oscuro con « | ».

## Tokens por rol

**Fondos y texto.** `--bg` es el fondo de la app; `--surface` y `--surface-2` son las superficies elevadas (tarjetas,
hojas); `--fill` es el relleno neutro de lo elegido y de los botones grises; `--hairline` son los separadores. `--text`
es el texto principal, `--muted` el secundario y `--faint` el terciario (rótulos y fechas).

**Bordes de controles.** `--chip-line` es el borde de chips y filtros sin elegir. Tiene 3:1 contra el fondo, que es lo
que piden los componentes de interfaz.

**Acento (ámbar).** `--accent` es lo que se toca y lo elegido; `--on-accent` es el texto sobre él; `--accent-soft` y
`--on-accent-soft` son el fondo suave y su texto. `--amber` y `--on-amber` son el botón principal, que es el mismo ámbar
en los dos temas.

**Estados.** `--live` es lo que pasa ahora (en el aire, en vivo) y siempre es verde, nunca ámbar. `--red` y `--orange`
son errores y avisos; `--blue` y `--gray` son informativos. `--danger` no existe: lo destructivo usa `--red`.

**Superficie invertida.** `--inverse-surface`, `--inverse-text` y `--inverse-accent` son para los avisos flotantes.

**Control deshabilitado.** `--disabled-fill` y `--disabled-ink`: fondo y texto de un control que no se puede usar. Se
usan en lugar de `opacity`, que también aclara el texto. Todavía no los usa ninguna pantalla: ver «Estados de control».

**Logos.** `--logo-tile`, `--logo-ink` y `--qr-bg` son fondos fijos para logos con imagen y para el código QR. Son
blancos o casi blancos en los dos temas, a propósito.

**Formas, sombras y medidas.** `--radius-sm`, `--radius`, `--radius-lg` y `--radius-full` son los radios; `--shadow`,
`--shadow-lg` y `--shadow-logo` son las sombras; `--gutter` es el margen lateral (16 px más el área segura del
celular), `--tab-h` la barra de pestañas y `--rail-w` la barra lateral del escritorio ancho.

**Escalas.** Se usan siempre y no se inventan valores sueltos:

- Letra: `--fs-xs` (11), `--fs-sm` (12), `--fs-md` (13), `--fs-base` (15), `--fs-lg` (17), `--fs-xl` (20), `--fs-2xl` (28).
- Espacio: `--sp-1` (4), `--sp-2` (8), `--sp-3` (12), `--sp-4` (16), `--sp-6` (24).
- Capas: `--z-sticky`, `--z-toolbar`, `--z-page`, `--z-tabbar`, `--z-toast`, `--z-sheet`, `--z-menu`, `--z-splash`.
- Tiempos: `--dur-1` (120 ms), `--dur-2` (200 ms), `--dur-3` (280 ms); curvas `--ease-out` y `--ease-in`.

## Reglas de color

- **Ámbar: solo para acción y selección.** Botones que hacen algo, el elegido de un filtro, la pestaña activa.
- **Verde: solo para lo que está en vivo.** Un canal o un programa al aire.
- **Un solo «elegido».** Relleno `--fill` y letra 600, en filtros, chips, segmentados y modos de la Guía. No hay dos
  formas distintas de marcar algo como elegido.
- **Chips sin elegir** con borde `--chip-line`. El elegido pierde el borde.

## Componentes que ya existen

Se reusan antes de inventar un estilo nuevo:

- **Botones:** `.btn` con `.btn-primary`, `.btn-tonal`, `.btn-gray`, `.btn-plain` y `.btn-danger`; `.icon-btn` (con
  `.filled` para el de acción).
- **Chips y segmentados:** `.chip-btn` (con `aria-pressed` para el elegido) y `.segmented` / `.seg`.
- **Campos e interruptores:** `.input`, `.select` y `.switch`.
- **Tarjetas y filas:** `.card` (con `.row-card` y `.section-card` en la lista de canales).
- **Avisos:** `.toast`, que sale arriba en el escritorio y arriba al centro en el celular.
- **Hojas:** `dialog.sheet`, con salida animada y arrastre para cerrar en el celular (`ui/sheet.ts`).
- **`ui/kit.tsx`:** `Progress` (barra de progreso), `BrandFoot` (la marca al pie) y `Skeleton` (el esqueleto de carga,
  el mismo en la edición y en el modo ver).

Si falta algo, se agrega a `ui/kit.tsx` en vez de escribir un estilo en la pantalla.

## Estados de control

Todo control tiene los mismos cinco estados:

- **Reposo.** El estado por defecto.
- **Hover.** Solo con puntero (`@media (hover: hover)`). Nunca queda pegado en el celular.
- **Foco.** Contorno de 2 px en `--accent`, con 2 px de separación, solo con `:focus-visible` (teclado). No aparece al
  tocar ni al hacer clic.
- **Presionado.** Un tono más oscuro del relleno (`color-mix` con `--accent` o `--text`, según el control).
- **Deshabilitado.** Hoy los botones usan `opacity: .45` (`.btn:disabled`). La meta es `--disabled-fill` y
  `--disabled-ink`. Ese cambio se ve distinto, así que se hace cuando Luis elija el mock.

## Cómo agregar un token

1. Escribirlo en `worker/web/tokens.css` con su claro y su oscuro en `light-dark(claro, oscuro)`, dentro de la sección
   que le toca. Si es un color de marca, que venga de la paleta existente.
2. Usarlo con `var(--nombre)` en `base.css`, `web.css` o en el estilo en línea. Nunca un hex suelto.
3. `worker/test/tokens.test.ts` falla si aparece un color fijo fuera de `tokens.css` o una regla de tema oscuro aparte.

## Pendiente

- Página `/estilos` con los tokens y los componentes, para revisar el diseño en un solo lugar. Es una pantalla nueva:
  necesita mock con tema claro y oscuro lado a lado y la elección de Luis antes de mergear.
- Componentes de `ui/kit.tsx` que todavía viven como clases comunes (`Sheet`, `Row`, `Chip`, `Segmented`, `Kicker`,
  `Mono`). Se arman como componente cuando una pantalla nueva lo necesite.
- Pasar los botones deshabilitados a `--disabled-fill` y `--disabled-ink`, según el mock elegido.
