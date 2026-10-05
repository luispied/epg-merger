# Cambios de Grilla web

La versión sigue [SemVer](https://semver.org/lang/es/) y vive en `worker/package.json`; se ve al pie de
Configuración. Cada PR que cambia la web sube la versión y agrega una entrada acá:

- **Mayor** (`2.0.0`): un cambio que obliga a rehacer algo (por ejemplo, el formato de la configuración).
- **Menor** (`1.1.0`): una función nueva.
- **Parche** (`1.0.1`): una corrección o un ajuste visual.

## 1.1.2

- Arriba de la lista queda un solo mensaje: el aviso de canales nuevos pasa a ser una fila dentro de la tarjeta de
  revisión (antes eran dos mensajes seguidos).
- El conteo de canales nuevos del aviso ahora coincide con el del filtro «Nuevos» (contaba nombres sin repetir y el
  filtro, canales: con nombres repetidos daban 219 y 249).

## 1.1.1

- Un link desactivado ahora responde la playlist con un solo canal, «⚠ Link desactivado: reactivalo en Grilla», para que el
  reproductor muestre el motivo (antes daba un error que casi ninguno muestra). La guía y los streams siguen dando 403.
  Ojo: el reproductor reemplaza su lista por ese canal hasta que se reactive el link.

## 1.1.0

- Los links de cada dispositivo se pueden **desactivar y reactivar** (switch en la pestaña Links) en vez de solo borrarlos:
  un link desactivado no responde (error 403) pero conserva su nombre y su dirección. Quitarlo sigue disponible.

## 1.0.1

- La versión se ve también en la pantalla de alta y al pie de la ayuda.
- Releases automáticos en GitHub (tag `vX.Y.Z` y notas de esta lista) y un chequeo que pide subir la versión en los PR que
  cambian la web.

## 1.0.0

Primera versión numerada. Resume lo que tiene la web hoy:

- Alta con proveedor Xtream o lista M3U, y canales de ejemplo para probar.
- Lista de canales con guía asignada, estado por excepción, gestos (deslizar, mantener apretado), menú «…» y
  arrastre con mouse; vistas condensada, detallada y de logos.
- Modo Revisar con progreso, hoja del canal con «Está bien / Siguiente», alternativas ordenadas por país.
- Categorías y secciones (con encabezados fijos), Configuración y Ayuda por pantalla, con botón para volver.
- Links por dispositivo (copiar playlist y guía, QR, compartir) desde la pestaña Links.
- Funciona sin conexión (PWA), tema claro y oscuro, panel fijo en escritorio ancho.
- Hora de los eventos PPV pasada a la hora del dispositivo (zona del proveedor configurable).
