# Cambios de Grilla web

La versión sigue [SemVer](https://semver.org/lang/es/) y vive en `worker/package.json`; se ve al pie de
Configuración. Cada PR que cambia la web sube la versión y agrega una entrada acá:

- **Mayor** (`2.0.0`): un cambio que obliga a rehacer algo (por ejemplo, el formato de la configuración).
- **Menor** (`1.1.0`): una función nueva.
- **Parche** (`1.0.1`): una corrección o un ajuste visual.

## 1.32.2

- «Tu código» (Perfil → Usar en otro dispositivo → Ver tu código) pasa a ser una hoja con los dos códigos a la vista, cada uno con su **Copiar** al lado y sin «Cancelar»: arriba el **código para editar** (el del hogar) y abajo el **código para ver** de cada perfil del proveedor (`ver.<código>`). Un perfil que todavía no tiene código para ver lo crea al copiarlo. La hoja está en `worker/web/ui/codes.tsx`.
- Ayuda: «Usar en otro dispositivo» cuenta lo de los códigos para ver, y la ayuda de Perfil suma **Modo ver: para alguien que solo mira** (cómo se comparte, qué ve quien lo usa, el aviso de «la guía no coincide» y cómo quitar el acceso), que faltaba desde la 1.32.0.
- Regla nueva del proyecto (`CLAUDE.md`): cada cambio de interfaz actualiza las ayudas o agrega una nueva.

## 1.32.1

- Modo ver: las conexiones quedan como en la cuenta del editor, una tarjeta chica «2 de 2 · Conexiones en uso»; tocarla despliega qué está mirando cada link.
- Modo ver: «Lo que dan en la tele no es esto» sube en la hoja del canal, justo debajo de lo que dan ahora, para que se encuentre sin bajar.
- Compartir para ver: el código ya no se muestra, solo el botón **Copiar código**, como con los links.

## 1.32.0

- Modo «solo ver»: en la página de un perfil, **Compartir para ver** crea un **código para ver** (`ver.<código>`). Se pega al entrar a Grilla, donde va el código de otro dispositivo, y ese dispositivo queda en modo ver: la grilla y la Guía de ese perfil, sin poder cambiar nada (pensado para alguien a quien le cuesta usar apps). Al abrir Grilla otra vez vuelve al modo ver, hasta tocar **Salir del modo ver**. El código también se puede copiar, compartir por WhatsApp o mail con el link directo (`/ver#código`), escanear con QR, cambiar por uno nuevo o quitar. Los links de reproducción no cambian.
- La página para ver (`web/ver.html`, `web/ver.tsx`) es aparte del editor y no guarda ninguna clave: letra grande, «Canales» con lo que dan ahora, cuánto queda y lo que sigue, búsqueda por canal o programa, la hoja de cada canal con la descripción y lo que viene, y la **Guía** (Grilla, Próximos y Tu noche) sin avisos ni «Cambiar la guía».
- En el modo ver, arriba de los canales: **las conexiones de la cuenta** («2 de 2», «Están todas ocupadas») y qué está mirando cada link activo, con hace cuánto. Se actualiza cada minuto.
- **La guía no coincide**: en la hoja de un canal del modo ver, «Lo que dan en la tele no es esto» le avisa a quien arma la grilla. En el editor aparece el aviso «La guía de «X» no coincide · Lo marcó Abuela desde el modo ver»; tocarlo abre la lista con **Cambiar guía** y **Resuelto**.
- Worker: `POST`/`DELETE /api/cfg/<cfgId>/profiles/<id>/view` crean o quitan el código (`view/<código>.json`); `GET /api/view/<código>` devuelve el nombre del perfil y sus canales (sin credenciales ni links, logos por el Worker); `GET /api/view/<código>/connections` da conexiones en uso, máximo y qué mira cada link (sin sus códigos, en caché 1 minuto); `POST /api/view/<código>/report` marca un canal y `GET`/`DELETE /api/cfg/<cfgId>/reports` los lista o resuelve (`reports/<cfgId>.json`, hasta 50). Borrar el perfil o la configuración borra su código y sus avisos. La playlist sale de la misma función (`playlistRows`), sin cambios.
- El service worker guarda la página para ver aparte, así no reemplaza al editor sin conexión.

## 1.31.1

- Los títulos de los programas ya no quedan cortados cuando la guía pone el partido o el episodio aparte: el subtítulo va pegado al título con « · » («Live: Fútbol Serie A · Inter de Milán vs. Parma»), en la grilla, la Guía, la hoja del programa y la búsqueda. Antes se perdía si el programa tenía descripción. Se ve con la próxima corrida diaria de la guía.
- Buscar también mira la descripción de lo que está dando cada canal, y encuentra aunque las palabras estén en otro orden («inter parma»). Las descripciones van en un archivo aparte por hora (`ui/schedule/hour/<hora>-d.json`) que se baja recién al buscar.
- En la vista detallada de Canales, el programa en el aire ocupa hasta dos líneas antes de cortarse.

## 1.31.0

- Resolución real de cada canal: una etiqueta SD, HD, FHD o 4K en la lista de Canales y en la Guía (con el mouse encima se ve el ancho × alto). No sale del nombre del canal: se mide el video que manda el proveedor.
- La mide el relay junto con la prueba diaria de canales caídos: cada canal una vez por semana, solo los que andan y como mucho 8 por tanda (unos 32 por día), para no comerse el tiempo de la prueba. Lee el comienzo del stream (MPEG-TS, o el primer segmento si es HLS; con un playlist maestro alcanza su RESOLUTION) y saca las medidas del SPS del video, H.264 o HEVC, en Python puro y sin ffprobe (`video_res.py`). Cuesta unos KB por canal: entra de sobra en lo gratis.
- Worker: queda en `res` de `health/<cfgId>.json` (`src/streamcheck.ts`). Con un relay viejo no se mide nada y la app sigue igual, sin etiquetas: hay que volver a desplegar el relay en Fly.

## 1.30.1

- Categorías y Perfil pasan a ser páginas enteras, como la Guía: la barra de abajo queda siempre a mano para ir de una a otra (marca dónde estás) y ya no hay cruz para cerrarlas. Lo que se abre desde ellas (una categoría, la ayuda, cambiar de cuenta) sigue siendo una hoja encima. En el escritorio, Esc vuelve a Canales.
- Tirar para refrescar anda solo en la lista de Canales: en la Guía y en las páginas ya no se dispara al desplazarse hacia arriba.
- Refrescar ya no vacía la lista ni la lleva arriba de todo mientras vuelve a bajar los datos: queda como está con el ícono girando. En el iPhone, ese salto en medio del gesto podía dejar la app sin responder a los toques ni a la barra de abajo.

## 1.30.0

- Guía: tercer modo, **Tu mañana / Tu tarde / Tu noche / Tu madrugada** (el nombre cambia con la hora; si queda menos de hora y media, arma la parte que sigue). Encadena programas de los canales sin que se pisen, saltando de canal, hasta el final de ese rato: primero lo que es en vivo o un partido, después las películas largas, y afuera el relleno, los noticieros y las repeticiones. Cada paso muestra una alternativa («o … en …»); tocarla rearma el plan desde ahí. «Cambio a … a las …» marca los saltos de canal y la campana de cada programa pide el aviso. Sigue el filtro de categorías de arriba.

## 1.29.0

- Guía: arriba se elige cómo verla, **Grilla · Próximos**. Próximos es una lista de lo que empieza en las próximas 3 horas en todos los canales, ordenada por hora: «Recién empezados, todavía llegás» (los que empezaron hace 15 minutos o menos) y «Lo que viene», con «Empieza ya», «Empieza en 14 min» o «Empezó hace 7 min» y el ↻ cuando vuelve a empezar. El mismo programa a la misma hora en varios canales va en una sola fila («y 2 más»). Tocar una fila abre la hoja del programa.
- «Tengo tiempo»: en Próximos, un control para decir cuánto rato tenés (de 20 minutos a 6 horas); lo que no entra entero se ve apagado con «Se pasa 33 min». El modo y el rato se recuerdan en el navegador.

## 1.28.0

- Guía: «Llegás desde el principio». Si un programa ya empezó y lo vuelven a dar más tarde, en el mismo canal o en otro de la lista, la celda muestra «↻» con la hora en que vuelve a empezar, y la hoja del programa dice dónde y cuándo, con un botón para el aviso y las otras horas en que lo dan.
- Worker: `POST /api/ui/again` (`src/again.ts`) recibe los ids de guía de la lista y devuelve las repeticiones, leyendo la programación por canal de R2. Compara título, duración y sinopsis para no confundir capítulos distintos ni programas de liga con repeticiones; la respuesta se guarda 15 minutos.

## 1.27.7

- La lista de Canales pasa a Preact, en `worker/web/ui/canales.tsx`: las filas (compacta, detallada y logos), los encabezados de categoría, la búsqueda, el vacío con «Ver todos los canales», el esqueleto mientras carga y el modo selección. Se ve y se comporta igual. Con esto todas las pantallas están en Preact; los gestos y menús de la lista siguen en `app.ts`.
- Tests de humo de la lista: filas y categorías, buscar, el vacío, la vista detallada, ocultar desde «…» y elegir varios.

## 1.27.6

- La hoja de un canal pasa a Preact, en `worker/web/ui/canal.tsx`, con el modo «Revisar». Se ve y se comporta igual. La guía asignada y las opciones siguen usando las piezas de la lista de canales hasta que la lista pase a Preact.
- Tests de humo de la hoja del canal: la guía que encontró sola, ‹ ›, renombrar, sin guía y automática, buscar y elegir otra guía, mover de categoría y ocultar. El Worker de prueba suma una guía con tres canales.

## 1.27.5

- Categorías pasa a Preact, en `worker/web/ui/categorias.tsx`: la lista con sus secciones, el buscador, arrastrar y deslizar, la hoja de una categoría y la de ordenar sus canales. Se ve y se comporta igual.
- Tests de humo de Categorías: el buscador, mover con el teclado y arrastrando, ocultar y renombrar una categoría, y ordenar sus canales.

## 1.27.4

- Configuración pasa a Preact, con los avisos push, en `worker/web/ui/settings.tsx`. Se ve y se comporta igual. Se arma de cero cada vez que se abre.
- Tests de humo de Configuración: lo que muestra, las preferencias que se guardan (tema, logos, filtro al abrir), «Actualizar la guía ahora» y «Usar en otro dispositivo».

## 1.27.3

- Conexiones: un link sin canales anotados dice «Sin canales registrados todavía» en vez de «Todavía no abrió ningún canal». Grilla anota los canales desde la 1.26.0, así que un dispositivo que ya estaba mirando antes puede estar conectado sin figurar.

## 1.27.2

- La tarjeta de los links recién armados (arriba de los canales) y la de los atajos pasan a Preact, en `worker/web/ui/cards.tsx`. Se ven y se comportan igual.
- Test de humo de las dos tarjetas: copiar, abrir el QR, descartar y que no vuelvan al recargar.

## 1.27.1

- Perfil (cuentas, perfiles y links) pasa a Preact: la lista, las páginas de cuenta, conexiones, perfil, proveedor y «Usar en otro dispositivo», sus formularios, la lista para cambiar de cuenta y el aviso de arriba de los canales. Se ve y se comporta igual que antes; ahora vive en `worker/web/ui/perfiles.tsx` en vez de `app.ts`.
- Tests de humo de Perfil con un Worker de prueba (`worker/e2e/fake-worker.ts`): la lista, la cuenta y sus conexiones, copiar un link, crear un perfil y cambiar qué ve. Pasan igual con la versión anterior.
- Arreglo de la Guía: de y media en adelante quedaba vacía, porque pedía las horas corridas media hora.

## 1.27.0

- Pestaña nueva **Guía**: la grilla de canales × hora, como la de TiviMate. Arranca en la hora actual con una línea que marca el ahora, se desliza de costado (hasta ~30 h adelante) y para abajo, y se filtra por categoría. El título de cada programa queda a la vista aunque haya empezado antes.
- Tocar un programa abre su hoja: descripción, lo que sigue, «Avisarme» y «Cambiar la guía de este canal». Los huecos sin programación (rayados) y los canales sin guía llevan directo a corregir el canal.
- Es la primera pantalla hecha en Preact. Baja solo las horas de programación que se ven y pinta solo las filas y programas en pantalla.

## 1.26.0

- En la página de una cuenta, tocar «Conexiones en uso» muestra qué links están conectados: arriba los que están mirando (con el canal y hace cuánto lo abrieron) y abajo los demás, con su último canal. El proveedor solo dice cuántas conexiones hay; Grilla ve cuándo cada link abre un canal, y avisa si hay conexiones que no son de sus links (otra app con la misma cuenta).

## 1.25.8

- La barra de abajo pierde la pestaña **Revisar**, que casi siempre decía que no había nada. Los canales dudosos se siguen revisando de a uno desde la tarjeta de arriba de la grilla (aparece sola cuando hay alguno) o con el filtro «A revisar». La ayuda lo explica así.

## 1.25.7

- La web empieza a pasar a Preact, de a una pantalla (plan en `planes/react.md`). La primera pieza es el aviso de abajo («Listo…», «No se pudo…»): se ve y se comporta igual que antes.
- Tests de humo de la web con Playwright (`npm run e2e` en `worker/`), que también corren en cada PR.

## 1.25.6

- Arreglo: las conexiones en uso ya no pueden mostrar más que el máximo («4 de 3»). El proveedor sigue contando por un rato la conexión de un canal que se dejó (al cambiar de canal o estrenar un link) y a veces informa de más; ahora se ve «3 de 3», como llenas.

## 1.25.5

- El botón «Cancelar» del alta de proveedor ya no queda pegado al texto de arriba («¿Ya usás Grilla en otro dispositivo?…»): tiene su aire.

## 1.25.4

- «Hora de eventos» ya no se muestra cuando el proveedor informa su zona horaria: se usa siempre esa, sola. La fila aparece solo si el proveedor no la informa, para elegirla a mano.

## 1.25.3

- Arreglo: la hora de los eventos (PPV) ahora sigue la zona horaria del proveedor. Si la cambiás en el panel del proveedor, la grilla se acomoda sola (con la próxima consulta de la cuenta: al abrir Perfil o en la prueba diaria). En la página del proveedor, «Hora de eventos» arranca en «Automática»; elegir una zona a mano la deja fija.

## 1.25.2

- «Probar con canales de ejemplo» usa canales públicos y gratuitos de Uruguay en vez de Argentina.

## 1.25.1

- La barra inferior queda a 1rem (16px) del borde inferior en todos los equipos.

## 1.25.0

- **Usar en otro dispositivo**: el respaldo y el código de hogar quedan juntos en una sola página (en Perfil, y con un atajo desde Configuración). El código es lo recomendado; el archivo de respaldo queda como alternativa, para tener una copia aparte. La pantalla de bienvenida ofrece las dos: «Pegá el código o importá un respaldo».
- Arreglo: el código ya no pierde proveedores. Antes cada dispositivo subía su lista sin mirar la del servidor, así que si sumabas un proveedor en el celular y después otro en la compu, el del celular desaparecía del código. Ahora se juntan antes de subir, y un proveedor quitado en un dispositivo no vuelve a aparecer desde otro.

## 1.24.9

- La barra inferior baja más en iPhone: queda a ~18px del borde (antes ~38px, porque sumaba entera la zona de la rayita de inicio). Sin esa zona, sigue a 4px.

## 1.24.8

- Perfiles: sin el párrafo explicativo de arriba; ya está en la ayuda (?) y la lista arranca directo con el proveedor.

## 1.24.7

- Ayudas al día con los últimos cambios: la de Perfil explica proveedor › cuenta › perfil › links (conexiones en uso, el aviso de vencimiento, desactivar un link, Qué ve) sin repetir secciones; la principal suma la pestaña **Revisar** y su pie (Usar sugerencia, Sin guía, Saltar), tirar para refrescar, **Reintentar** y los filtros que aparecen solos (Nuevos, Sin programación, Caídos).
- Configuración: la ayuda de los avisos incluye vencimientos y recordatorios, el respaldo menciona varios proveedores y el hogar, y se aclara dónde quedan el usuario y la contraseña (solo cifrados, junto a los links).

## 1.24.6

- Arreglo: los logos de los canales volvieron a verse en TiviMate y demás reproductores. Desde que los logos pasan por el Worker, las guías armadas entre corridas diarias apuntaban a logos que el Worker todavía no sabía de dónde bajar. Ahora esas guías suben junto con lo necesario para encontrarlos, y un logo que no se encontró se vuelve a buscar al minuto en vez de a la hora.

## 1.24.5

- En la revisión de un canal, **Sin guía** pasa al pie junto a **Usar sugerencia** y **Saltar**, y la tarjeta de la sugerencia ya no repite el botón **Usar**. Elegir **Sin guía** ahí pasa al canal siguiente.

## 1.24.4

- Tirar hacia abajo estando arriba de la grilla la vuelve a cargar (configuración, lista y guía), como en las apps del celular.
- La grilla falla menos al abrir: si un pedido se corta (pasa con datos móviles) se reintenta solo dos veces antes de rendirse, y una guía que responde con error ya no deja la carga colgada.
- Si igual no carga, el aviso trae un botón **Reintentar**.
- La barra inferior baja 4 px más.

## 1.24.3

- En la página de una cuenta, los perfiles quedan alineados con el resto de la lista (tenían la sangría de la lista general).

## 1.24.2

- Perfil abre al instante: se dibuja con lo que ya se bajó al abrir la app y se actualiza por detrás (antes esperaba al servidor y a cada proveedor, más de un segundo). El Worker además lee los links en paralelo y una sola vez por pedido.
- Los perfiles llevan todos el mismo ícono: un círculo con su inicial (antes una tele o un filtro según tuvieran filtro).

## 1.24.1

- Arreglo: las cuentas con links de antes mostraban «Hasta 3» en vez de las conexiones en uso. Esos links no guardaban la huella de su cuenta y la web no encontraba sus datos; ahora la reciben solos al abrir Perfil, sin cambiar de dirección.

## 1.24.0

- Perfil se reordena en **cuentas > perfiles > links**. La cuenta es tu usuario y contraseña del proveedor (la tuya o la de un familiar): tiene la suscripción, las conexiones, los canales caídos y «Usar esta cuenta». Dentro de cada cuenta, los perfiles eligen **qué se ve** (por ejemplo «Chicos») y tienen sus links.
- Un mismo link sirve para varios dispositivos: «Copiar o compartir» lo deja a mano para cargarlo en otra tele. Otro link solo hace falta si lo querés apagar o pasar de perfil por separado.
- «Qué ve» es del perfil y vale para todos sus links. Un perfil se puede renombrar, pasar a otra cuenta o borrar (sus links pasan a otro perfil). Una cuenta se renombra, cambia sus datos o se borra (sus perfiles pasan a otra cuenta). Los links nunca cambian de dirección.
- Los links de antes quedan solos en un perfil por cuenta y filtro.

## 1.23.1

- Arreglo: al generar un link, un segundo toque mientras se guardaba mostraba el error «null is not an object (#lnkName)». Ahora el botón se bloquea hasta terminar (también en «Crear perfil»).

## 1.23.0

- Perfiles rediseñado (opción H): una lista corta con una fila por perfil, agrupadas por proveedor. Cada perfil tiene su página con suscripción, conexiones, sus dispositivos, «Agregar dispositivo» (ya no pregunta a qué perfil), usuario y contraseña, y «Usar este perfil». El del perfil en uso tiene además «Canales caídos» y «Probar ahora».
- Los perfiles se pueden **renombrar**, también el tuyo (antes siempre «Tu cuenta»), y **borrar**: sus dispositivos pasan a otro perfil con los mismos links. «Agregar perfil» crea la cuenta de un familiar con su primer dispositivo.
- El engranaje de cada proveedor tiene su nombre, la dirección del servicio, recargar la lista, la hora de eventos (ahora una por proveedor) y «Quitar proveedor». «Hogar» tiene el código para abrir todo en otro dispositivo.
- Configuración queda con la guía, el respaldo y las preferencias: la suscripción, los canales caídos, recargar la lista, la hora de eventos, el hogar y borrar la configuración pasaron a Perfil.
- Un dispositivo nuevo de tu cuenta ya no pide usuario y contraseña si otro link tuyo los tiene.

## 1.22.0

- Varios proveedores: la web guarda todas tus configuraciones (una por proveedor) en un **hogar**. Perfiles las agrupa por proveedor, cada grupo se puede renombrar y «Agregar otro proveedor» crea una configuración nueva sin perder la actual.
- Usar un perfil de otro proveedor lo vuelve su perfil activo y abre su grilla. El cambio rápido (mantener apretada la pestaña Perfil) también muestra los perfiles de todos los proveedores.
- Un dispositivo se puede pasar a un perfil de otro proveedor con su botón ⇄: el link no cambia.
- Código de hogar: en Configuración, «Abrir en otro dispositivo» muestra un código que, puesto en otro navegador («Usar un código de hogar», o «Tengo un código de hogar» al empezar), trae todos los proveedores. El Worker guarda el hogar cifrado en el navegador; sin el código no se puede leer.
- El respaldo (Exportar) incluye todas las configuraciones del hogar, y al importarlo se suman.

## 1.21.0

- Perfiles en la web: la pestaña de abajo «Links» pasa a ser **«Perfil»**, con la inicial del perfil activo. Un toque abre Perfiles: una tarjeta por cuenta del proveedor (la tuya y las de familiares) con días de suscripción, conexiones en uso, canales caídos (del activo) y sus dispositivos; «Usar» la vuelve el perfil activo. Mantener apretada la pestaña (o clic derecho) cambia de perfil sin entrar.
- En Canales aparece un aviso solo cuando el perfil activo vence en 7 días o menos o tiene todas las conexiones en uso.
- Un dispositivo se puede pasar a otro perfil (o a uno nuevo) con su botón ⇄: el link no cambia.
- Conexiones en uso: el relay las informa (`activeConnections`) y el Worker las pide al momento al abrir Perfiles (`GET /api/cfg/<id>/accounts`). Hasta que se publique el relay nuevo se ve el máximo de conexiones.
- Lo que antes se llamaba «perfil» de un dispositivo (qué categorías y canales ve) ahora se llama **filtro**, para no confundirlo con los perfiles.

## 1.20.0

- Perfiles, primera parte (en el Worker; la web llega en la próxima versión, ver `planes/perfiles.md`): cada configuración tiene un perfil activo (la cuenta principal o la de un familiar). La prueba de canales caídos y la lista que baja el relay se hacen con la cuenta del perfil activo; al cambiarlo, la prueba se pide enseguida y lo que había probado la cuenta anterior no cuenta.
- Un link se puede pasar a otro perfil o a otra configuración (otro proveedor) sin cambiar su dirección: el reproductor no hay que tocarlo y con la próxima actualización usa la cuenta nueva.
- Hogar: una clave que junta todas las configuraciones de una persona. El Worker guarda solo lo que cifra el navegador.

## 1.19.1

- Las fuentes de EPG van enmascaradas: en la guía de la web y en el XML que baja el reproductor cada fuente tiene un alias opaco en vez de su nombre, y el texto del alta ya no nombra proveedores. La web ya no puede pedir el catálogo ni el uso de fuentes (no los usaba). El matching no cambia.
- Sin rastros de las fuentes, como regla general para cualquier fuente: los logos de canal salen del Worker (`/logo/…`) en la web, la playlist y el XML del reproductor (el Worker baja cada uno la primera vez y después lo sirve desde R2); las imágenes de programa del XML, también (`/img/…`, de paso, sin guardarlas); se sacan los `<url>` de canales y programas y los links a sitios de las fuentes en títulos y descripciones (también en la programación de la web). Los links de reproducción no cambian.
- Los ids de canal de la guía también van enmascarados (`g` + 14 caracteres + el país, p. ej. `g196a8620ccb9db.ar`) en la guía de la web, la programación, el XML del reproductor y el `tvg-id` de la playlist; los nombres de guía salen sin el `.us` del final. Una configuración guardada con el id real pasa al alias la primera vez que se abre en la web (con la guía ya enmascarada) y ahí cambian juntas su playlist y su guía; hasta entonces sigue igual. El matching elige exactamente lo mismo.
- La interfaz ya no muestra ids de guía ni fuentes: sin el tooltip con id y fuente, sin buscar por id, y una guía que ya no está se ve como «Guía que ya no está» en vez de su id.

## 1.19.0

- La lista del proveedor y la prueba de canales caídos ya no pasan por GitHub: las hace solo el relay. Se retiran la corrida que bajaba listas con `XTREAM_PROFILES` (`tools/push_lists.py`), la prueba diaria de GitHub (`check-streams.yml`) y el vínculo por huella (`known/`, `links/`). Los links ya creados siguen andando igual. Sin relay, la lista se sube desde el navegador o con `tools/grilla_home.py`, y «Probar ahora» avisa que falta el relay.
- `refresh-lists.yml` solo arma la guía de las configuraciones nuevas o cambiadas.

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
