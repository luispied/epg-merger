# Cambios de Grilla web

La versión sigue [SemVer](https://semver.org/lang/es/) y vive en `worker/package.json`; se ve al pie de
Configuración. Cada PR que cambia la web sube la versión y agrega una entrada acá:

- **Mayor** (`2.0.0`): un cambio que obliga a rehacer algo (por ejemplo, el formato de la configuración).
- **Menor** (`1.1.0`): una función nueva.
- **Parche** (`1.0.1`): una corrección o un ajuste visual.

## 1.18.0

- Con el relay configurado, la prueba de canales caídos y los datos de cada cuenta (vencimiento, conexiones) los hace el cron del Worker, sin la corrida de GitHub ni `XTREAM_PROFILES`: una vez por día por configuración, o al tocar «Probar ahora» (lo toma el cron, puede demorar hasta media hora).

## 1.17.0

- Relay opcional (`relay/`) para bajar la lista del proveedor sin depender de un secret por persona en GitHub: si el Worker tiene `RELAY_URL` y `RELAY_SECRET`, la lista la baja el relay al dar de alta una configuración, al pedir la playlist con la lista vieja y al cambiar los servidores o los datos de la cuenta. Sin relay, todo sigue como antes.

## 1.16.0

- «Tu proveedor» muestra una fila de suscripción por cada cuenta que usan tus dispositivos (la tuya y la de cada familiar), con su vencimiento y conexiones. La corrida de GitHub guarda los datos de cada cuenta que esté en `XTREAM_PROFILES`.
- Al agregar un dispositivo con una cuenta que GitHub ya conoce, la configuración se anota para esa cuenta (baja la lista y prueba los canales con cualquiera de las dos).
- La fecha de vencimiento se escribe en español.

## 1.15.0

- Cuentas adicionales del proveedor (por ejemplo, la de un familiar): al agregar un dispositivo en Links se elige «Mi cuenta», una cuenta ya cargada o «Otra cuenta nueva» con su nombre, usuario y contraseña. Con una cuenta ya cargada no hay que escribir los datos de nuevo (se reutilizan cifrados).
- Cada dispositivo muestra su cuenta, y «¿Cambiaron tus datos del proveedor?» permite actualizar solo los de una cuenta sin tocar los de las otras.

## 1.14.2

- Salud de la guía: los canales que dejaste sin guía a propósito ya no se cuentan como «sin guía» (el número ahora coincide con el filtro «Sin EPG»).

## 1.14.1

- Al cerrar la edición de un canal ya no queda marcado en la grilla.
- El menú inferior vuelve a ser una cápsula flotante, más abajo y translúcida para ver lo que hay detrás.
- Los avisos (toast) son redondeados y algo translúcidos.

## 1.14.0

- La barra inferior queda pegada al borde de abajo, de lado a lado, en vez de flotar.
- En Links se puede cambiar la dirección del servicio de IPTV si falla o se mudó («¿Cambió la dirección del servicio de IPTV?»), sin tocar los links ya instalados. La descarga de la lista por GitHub también usa la dirección nueva.

## 1.13.3

- Las tarjetas de arriba de la lista («Tu lista está lista» y «N canales para revisar») pasan al estilo del resto de la app:
  llenas, sin la raya ámbar a la izquierda ni el contorno; el ámbar queda para el botón principal.

## 1.13.2

- Configuración → Guía: «Probar canales ahora» y «Canales caídos» se juntan en una sola fila, «Canales caídos». Muestra el resultado
  (cuántos caídos y cuántos se probaron, y cuándo se puede volver a probar), tocarla abre el filtro «Caídos» y el botón chico
  «Probar ahora» lanza la prueba (una vez por día).

## 1.13.1

- La campana de «Avisarme» se ve siempre en los programas que todavía no empezaron. Antes se escondía si el Worker no tenía las
  claves de avisos (VAPID) y no se entendía por qué faltaba; ahora, al tocarla sin esas claves, explica qué falta.

## 1.13.0

- **Canales nuevos del proveedor más rápido**: si la lista la baja GitHub (proveedor que bloquea a Cloudflare), cuando el reproductor
  pide la playlist y la copia guardada tiene más de 10 minutos, el Worker lanza una corrida que la vuelve a bajar. Ese pedido sale
  con lo que había y el siguiente (uno o dos minutos después) ya trae lo nuevo, por ejemplo un partido que apareció en PPV. Antes
  podía tardar hasta 3 horas. Cuida los minutos de Actions: una vez cada 10 minutos por configuración y hasta 12 por día en
  total; la corrida normal sigue siendo cada 3 horas.

## 1.12.1

- Los avisos (toasts) se pueden cerrar con una ✕.
- **Canales nuevos**: el aviso de arriba sale una sola vez, la primera apertura de la app en que el canal apareció (antes volvía a
  salir cada vez que abrías la app, hasta tocar «Marcar como vistos»). El filtro «Nuevos» los sigue mostrando 24 horas y después
  pasan solos a vistos.
- **Probar canales a mano**: Configuración → Guía → «Probar canales ahora» lanza la prueba en GitHub (necesita el token del
  Worker). La prueba corre como mucho una vez cada 20 horas, sea la de la madrugada, la lanzada desde la app o desde GitHub →
  Actions: si ya se hizo, se saltea y la app dice cuándo se puede volver a lanzar.

## 1.12.0

- **Recordatorios de programas**: en la hoja de un canal, «Ver programación de hoy» muestra una campana en cada programa que
  todavía no empezó. Tocarla (la primera vez pide permiso para los avisos) guarda el recordatorio y llega un push antes de que
  empiece: la revisión es cada 30 minutos, así que el aviso llega entre 0 y 30 minutos antes. Se quita volviendo a tocar la
  campana (o con «Deshacer»); máximo 30 a la vez; los que pasan sin poder avisarse se descartan solos. Solo aparece si el
  Worker tiene los avisos (claves VAPID) activados.

## 1.11.1

- Se quita la pestaña **Guía** de la 1.11.0: mostraba lo mismo que la lista principal (y sin la barra de progreso del programa),
  así que no aportaba nada. «Qué dan ahora» sigue en cada canal de la lista.

## 1.11.0

- Pestaña «Guía» con lo que daba ahora cada canal y lo que seguía (quitada en la 1.11.1).

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
