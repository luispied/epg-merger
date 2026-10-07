# Cambios de Grilla web

La versión sigue [SemVer](https://semver.org/lang/es/) y vive en `worker/package.json`; se ve al pie de
Configuración. Cada PR que cambia la web sube la versión y agrega una entrada acá:

- **Mayor** (`2.0.0`): un cambio que obliga a rehacer algo (por ejemplo, el formato de la configuración).
- **Menor** (`1.1.0`): una función nueva.
- **Parche** (`1.0.1`): una corrección o un ajuste visual.

## 1.10.0

- **Vencimiento de tu suscripción**: la corrida diaria lee del proveedor cuándo vence y cuántas conexiones permite (solo esos
  datos, nunca usuario ni contraseña) y Configuración → «Tu proveedor» lo muestra, en naranja si faltan 7 días o menos.
  Con los avisos activados, también llega una notificación al cruzar los 7, 3 y 1 día y el día que vence; si renovás, empieza
  de nuevo. Los proveedores que no informan la fecha simplemente no muestran nada.

## 1.9.0

- **Canales caídos**: una corrida diaria de GitHub (de madrugada, `check-streams`) prueba una tanda de unos 200 canales,
  de a uno y sin bajar video, y deja el resultado en el Worker. Los que fallan dos pruebas seguidas figuran como caídos:
  fila nueva en Configuración → Guía y filtro **Caídos** (aparece solo cuando hay). Solo avisa: no oculta nada. No prueba
  canales ocultos, separadores ni eventos sueltos (PPV), y se corta sin anotar nada si el proveedor rechaza la cuenta.

## 1.8.0

- **Salud de la guía**: en Configuración, una fila nueva muestra qué porcentaje de tus canales con guía tiene programación
  ahora y cuántos no tienen nada en las próximas 12 horas (fuente vieja o canal sin datos). Tocarla abre el filtro nuevo
  **Sin programación** (aparece en la barra solo cuando hay canales así) para cambiarles la guía.

## 1.7.0

- **Corregís una vez y alcanza**: al elegir o confirmar la guía de un canal (en la hoja del canal, con «Está bien» o «Usar
  sugerencia»), Grilla la repite en sus variantes —el mismo canal en SD, HD, FHD o 4K, del mismo país, región e idioma— que
  todavía tenían una guía dudosa o ninguna. El aviso cuenta en cuántas la aplicó y «Deshacer» revierte todo junto. Los canales
  que ya elegiste a mano no se tocan.

## 1.6.3

- Links tiene su propia **ayuda** (botón «?» junto al título): qué es un dispositivo, cómo funciona el perfil, secciones y
  canales sueltos, desactivar y cambiar los datos del proveedor.
- El perfil se simplifica: se quita el modo. Cada categoría, sección o canal tiene un interruptor que significa «se ve en este
  dispositivo» (encendido) o «no se ve» (apagado), como en el resto de la app. «Mostrar todo» y «Ocultar todo» reemplazan a los
  botones anteriores. Las categorías nuevas del proveedor aparecen encendidas.

## 1.6.2

- El perfil de un dispositivo toma el mismo diseño que Configuración y Categorías: secciones con título, filas en tarjeta con
  interruptores, buscador y botones iguales a los de Categorías, y el modo como selector «Se oculta / Se muestra solo».

## 1.6.1

- Perfil de un dispositivo: se arregla el diseño del selector de modo (se veía recortado) y se agregan «Elegir todo» y
  «Deseleccionar todo». Marcar una sección marca todas las categorías que tiene adentro (y desmarcarla las desmarca);
  si solo hay algunas marcadas, la sección se ve a medias.

## 1.6.0

- **Perfiles por link**: en Links, cada dispositivo tiene un botón de perfil para elegir qué categorías y canales ve su
  playlist, ocultando lo marcado o mostrando solo lo marcado (por ejemplo, la tele de los chicos sin adultos). El link
  no cambia al editar el perfil y los demás dispositivos no se tocan. Sin perfil, ve todo como antes.

## 1.5.0

- Los links de cada dispositivo quedan fijos: si cambia tu usuario, contraseña o la URL de tu lista, en Links → «¿Cambiaron tus
  datos del proveedor?» los actualizás en todos de una vez y las direcciones siguen siendo las mismas (no hay que tocar el reproductor).

## 1.4.0

- Se quita todo lo que dependía de GitHub para generar links: la importación desde GitHub, los gists, la interfaz vieja de
  GitHub Pages y la rama `data`. El repo puede quedar privado.
- La descarga de la lista del proveedor desde GitHub se mantiene (para proveedores que bloquean a Cloudflare), ahora cada
  3 horas, y baja la guía del release con el token del workflow.

## 1.3.1

- La guía asignada en la hoja del canal pasa a una tarjeta neutra (sin fondo ni barra ámbar): el estado va en un chip arriba a
  la derecha (✓ y porcentaje, «dudosa», «Elegida por vos») y el canal sin guía se ve con borde punteado.

## 1.3.0

- **Avisos push** (navegador y app instalada): un interruptor «Avisos» en Configuración suscribe el dispositivo y el Worker
  manda una notificación cuando aparecen canales nuevos en tu lista (revisa cada 30 minutos). Tocarla abre la app en «Nuevos».
  En iPhone funciona solo con la app instalada. El interruptor aparece solo si el Worker tiene las claves VAPID
  (`tools/gen_vapid.mjs` y `worker/README.md`).

## 1.2.0

- El menú inferior ahora es una cápsula flotante (como el de WhatsApp), con la pestaña activa en píldora.
- Abrir un canal o una categoría ya no deja el cursor en el nombre (en el celular abría el teclado solo): se edita al tocarlo.
- En el modo Revisar, «Revisando · n de n» y su barra quedan en el encabezado fijo de la hoja y ya no los tapa el título al desplazar.

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
