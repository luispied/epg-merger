# Cambios de Nowline web

La versión sigue [SemVer](https://semver.org/lang/es/) y vive en `worker/package.json`; se ve al pie de
Configuración. Cada PR que cambia la web sube la versión y agrega una entrada acá:

- **Mayor** (`2.0.0`): un cambio que obliga a rehacer algo (por ejemplo, el formato de la configuración).
- **Menor** (`1.1.0`): una función nueva.
- **Parche** (`1.0.1`): una corrección o un ajuste visual.

Lo que va acá también se muestra en la app («Novedades»), así que conviene escribirlo para quien la usa. No se muestran
las viñetas que empiezan con «Worker:» o «Interno:» ni las que hablan de tests, y se sacan los paréntesis con rutas o
nombres de código.

## 1.44.0

- **La hoja de un programa dice su género.** Al lado de la hora aparece «Deportes», «Película», «Noticias»… cuando nowline ya lo sabe; en la Guía y en el modo ver.

## 1.43.0

- **Tu plan sugiere cosas parecidas a lo que mirás.** Si mirás mucho deporte, sube el deporte de otros canales, aunque nunca los hayas abierto, y debajo dice «Como lo que mirás: deportes». La publicidad nunca se sugiere.
- Interno: la corrida diaria pone el género a cada programa de la programación; el Worker lo guarda en los hábitos.

## 1.42.10

- **La barra inferior del modo ver queda a la misma altura en la Guía que en Canales.** Se saca el bloqueo de scroll de la página de atrás en el modo ver; la edición lo sigue usando.

## 1.42.9

- **La barra de abajo tiene una píldora que se desliza.** Al pasar de Canales a Guía, Categorías o Perfil, la marca de la pestaña elegida viaja hasta el botón nuevo en vez de aparecer de golpe. Igual en la edición y en el modo ver, y con «reducir movimiento» activado no se anima.

## 1.42.8

- **Al abrir la Guía, la página de atrás ya no se mueve.** En el celular, el scroll de la lista de atrás corría la barra inferior y la hacía verse más arriba que en el modo ver.
- **En el modo ver, el buscador ya no deja un hueco grande debajo del título.** En el celular la distancia se sumaba dos veces con la franja de la hora, y ahora queda igual que en la edición.

## 1.42.7

- **La barra inferior queda igual en el modo ver que en la edición.** El modo ver ahora usa el mismo ajuste de texto grande que la app, así la barra mide y se ubica igual en las dos pantallas.

## 1.42.6

- **Canales ya no muestra el aviso de «conexiones llenas».** El aviso de arriba de la lista queda solo para cuando la cuenta vence pronto o el servicio que habla con tu proveedor no responde. Las conexiones en uso siguen en la página de la cuenta y en Conexiones en uso.

## 1.42.5

- **El modo ver también filtra por categoría.** Aparece el mismo botón de filtro y la misma hoja que en la edición, con solo las categorías visibles. Los filtros de estado (nuevos, a revisar, sin EPG) no están en el modo ver.
- **Las categorías del filtro salen en el mismo orden que la lista.** Antes seguían el orden del proveedor; ahora aparecen como las ordenaste en Canales, en la grilla y en la Guía.

## 1.42.4

- **La carga ya no dice «sin conexión» cuando hay conexión.** Antes, cualquier error de la app en la carga se mostraba como falta de red. Ahora solo aparece si de verdad no hay conexión; si el servidor tarda, se avisa eso.
- **Un pedido colgado ya no traba la carga.** Cada pedido tiene un tiempo máximo y, si la respuesta se corta a mitad en el celular, se vuelve a pedir.
- **La lista de canales se ve aunque la guía no baje.** Arriba aparece «No se pudo bajar la guía» con «Reintentar».

## 1.42.3

- **El filtro de categorías solo ofrece las categorías visibles.** Las ocultas no aparecen en la hoja de filtros, y los estados sin canales (Ocultos, Editados, Elegidos a mano) tampoco salen si no hay nada que mostrar.

## 1.42.2

- **El modo ver carga como la edición.** El logo de inicio se ve al abrir y no vuelve al recargar. Mientras llegan los canales, aparecen tarjetas de carga en vez del texto «Cargando los canales…». Si la carga tarda más de 15 segundos, aparece el aviso para probar de nuevo.

## 1.42.1

- **En modo ver, el nombre de la categoría ya no deja ver lo que pasa por debajo al hacer scroll.** El encabezado queda con fondo sólido desde arriba.

## 1.42.0

- **Filtros de la lista en una hoja**: al lado del buscador hay un botón de filtros (con un número si hay algo puesto). En la hoja elegís un estado (Todos, A revisar, Sin EPG…) y una o más categorías. Lo que elegiste aparece arriba como chips, cada uno con su ×, y «Quitar todos». Ya no hay una fila fija de filtros.
- Interno: `ui/filtros.tsx` (Preact) dibuja el botón, los chips y la hoja; app.ts sigue decidiendo qué canales se ven.

## 1.41.6

- **La rueda queda solo para Configuración.** En Perfiles, el proveedor se toca como una fila con flecha (como las cuentas): ahí se cambian su nombre, su dirección, su lista o se quita. Ya no hay un engranaje dentro de Perfil.
- **Configuración no repite el conteo de canales.** El «3391 canales · 1739 con guía · guardado…» sigue en la lista de Canales.

## 1.41.5

- **El nombre de la app va siempre en minúscula**: «nowline», como en el logo. Sin negrita en el texto corrido. Cambia en la pantalla de bienvenida, la ayuda, Compartir, el aviso de actualización, el ícono de inicio y el título de la pestaña.

## 1.41.4

- **Configuración ya no muestra el commit.** Al pie solo queda la versión de Nowline, que es lo que le sirve a quien usa la app.
- Interno: el build ya no lee el commit de git.

## 1.41.3

- **Nowline se actualiza sola, sin avisos con la app abierta.** Ya no aparece «Hay una versión nueva» con el botón **Actualizar**, ni llega una notificación push por cada versión nueva. La versión nueva se ve al abrir la app. Al abrirla después de una actualización, un aviso breve dice «Nowline se actualizó» y **Qué hay nuevo** muestra los cambios.
- Worker: se quitó el aviso push de versión nueva (`notifyNewVersion`).
- Tests: se quitó la prueba de ese aviso.

## 1.41.2

- **La Guía y la lista abren más rápido.** El cruce de cada canal con la guía se guarda en este navegador: se vuelve a calcular solo cuando cambia la guía del día, tu lista o tus preferencias.
- Interno: caché en IndexedDB (`worker/web/cache.ts`) con una clave que incluye la fecha de la guía, el nombre, el id y la categoría de cada canal, y las preferencias de cruce.
- Tests: el cruce guardado y su reemplazo al cambiar la guía (`e2e/cruce-cache.spec.ts`).

## 1.41.1

- Worker: anota en su registro (Workers Logs) el tipo de cada pedido (`playlist`, `epg`, `stream`, `api/cfg`…), sin ids, códigos ni tokens, para saber qué gasta más CPU. No cambia ninguna respuesta.
- Interno: el registro de consumo (`tools/consumo.py`) suma la CPU p99 por tipo de pedido. Necesita que el token de analíticas tenga además el permiso «Workers Observability»; sin él, lo dice en el issue.

## 1.41.0

- **Los avisos van arriba.** Ya no quedan tapados por la barra de abajo, por el pie de la revisión ni por una página abierta: en el celular aparecen debajo de la hora, centrados, y en la computadora arriba a la derecha. Siempre quedan por encima de todo.
- **La prueba de canales caídos muestra su avance.** Mientras prueba, arriba de la lista de canales aparece una franja fija: «Probando 50 de 180 · 3 caídos», con su barra y **Detener**, que la corta y guarda lo que alcanzó a probar. Antes de arrancar dice que está en espera. Al terminar, un aviso dice cuántos quedaron caídos y **Ver** los muestra.
- Worker: la prueba deja su avance en `healthprog/` después de cada tanda (lo devuelve `GET /health` como `progress`) y mira `healthstop/`, que deja `DELETE /health/run`.
- Ayudas de Canales y de Perfil al día.
- Tests nuevos: el avance y «Detener» en el Worker (`test/worker.test.ts`) y la franja en `e2e/prueba.spec.ts`.

## 1.40.0

- **Nowline abre con su logo, como las apps del celular.** Al abrir la app (y el modo ver) se ve el ícono con «nowline» en el centro, en claro u oscuro según tu tema, y se va con un fundido apenas está lista tu pantalla. No suma espera: la app carga debajo, y no vuelve a aparecer al navegar ni al recargar.
- **Instalada en el celular, sin pantallazo negro ni blanco.** En Android el inicio del sistema usa el fondo de la app, y en el iPhone, desde la pantalla de inicio, aparece el mismo logo antes de que cargue la página.
- Interno: las imágenes de inicio del iPhone se arman con `npm run splash-images` (`splash-images.mjs`, en `web/img/splash/`).

## 1.39.3

- **La Guía gasta mucho menos datos.** Baja la programación de cada hora solo de tus canales, unos 27 KB en vez de unos 400 KB de toda la guía. Lo mismo en el modo ver y en el chequeo de qué canales dan programación.
- Interno: la corrida y la guía de una configuración nueva arman ese índice por configuración (`tools/pack_schedule.py --configs`, `ui/schedule/cfg/<cfgId>`). Mientras no está al día con la configuración, el Worker entrega el de toda la guía.
- Worker: `GET /api/cfg/<id>/hour/<hora>.json` y `GET /api/view/<código>/hour/<hora>.json`.
- Tests del índice por configuración (Python y Worker); los tests de pantalla aceptan las dos rutas.

## 1.39.2

- Interno: la corrida sube a R2 solo los archivos que cambiaron: compara cada uno con el que ya está (`tools/r2_sync.py`) en vez de volver a subir todo. Lo mismo al armar la guía de una configuración nueva entre corridas, que antes volvía a subir los ~270 mapas de imágenes cada vez.
- Interno: el índice de la guía y los mapas de imágenes se guardan en gzip: el índice baja de 2,3 MB a 0,6 MB y los mapas de 13 MB a 4,5 MB.
- Worker: entrega el índice de la guía comprimido tal cual y lee los mapas de imágenes en gzip; los de antes, en texto, se siguen leyendo.
- Tests nuevos de la subida (`tests/test_r2_sync.py`) y de la guía y los mapas en gzip.

## 1.39.1

- Interno: la programación que sube la corrida diaria a R2 va empacada: los ~17.500 archivos por canal pasan a 256 tandas y todo va en gzip (`tools/pack_schedule.py`). `ui/` baja de 203 MB a 76 MB y las escrituras diarias de unas 17.600 a unas 320.
- Worker: lee cada canal de su tanda con dos lecturas por rango y lo sirve comprimido tal cual, igual que los índices por hora (`src/schedule.ts`); mientras no haya tandas, sigue leyendo los archivos de antes. La corrida borra esos archivos viejos por canal después de subir las tandas.
- Tests nuevos del empaque (`tests/test_pack_schedule.py`) y de la lectura en el Worker (`test/schedule.test.ts`).

## 1.39.0

- **En la Guía, la vista se elige al lado del título.** Ya no hay una barra con tres botones debajo de «Guía»: a la derecha del título dice «Grilla  Próximos», con la que estás viendo subrayada y la otra apagada. Es una fila menos y la grilla gana lugar.
- **Tu noche sale del selector y tiene su tarjeta.** Arriba de Grilla y Próximos, «Tu noche, armada para vos» (de día, tu mañana o tu tarde) dice hasta qué hora arma lo mejor de tus canales y abre el plan en su propia página. La flecha de al lado del título te devuelve a donde estabas.
- **«Ahora» aparece solo cuando hace falta.** En la Grilla, si te alejás de la hora actual, abajo a la derecha aparece «Ahora» con una flecha hacia donde está; tocalo y volvés. Mientras la línea de ahora se ve, no está.
- Ayudas de la Guía, de Canales y del modo ver al día.
- Tests de la Guía y del modo ver al día; test nuevo de «Ahora» en `e2e/guide.spec.ts`.

## 1.38.2

- **Todas las pestañas abren igual: con su nombre como título.** Canales ahora dice «Canales» arriba, del mismo tamaño y a la misma altura que Guía, Categorías y Perfiles (antes era la única que mostraba el nombre de la app). En el modo ver, lo mismo.
- En una pantalla grande, el ícono de Nowline queda arriba de la barra lateral.
- El nombre de la app aparece al pie de Configuración, arriba de la versión, y al final de la lista del modo ver.
- Test de Configuración al día con el pie nuevo («Versión 1.38.2»).

## 1.38.1

- **La Guía ya no se queda mostrando celdas grises.** Si la abrías pasada la media hora, los bloques de «cargando» de la primera hora no se iban nunca y tapaban los programas.
- **«Tu noche» pasa a llamarse «Tu plan».** El botón ya no cambia de nombre con la hora, así entra siempre (antes «Tu madrugada» no cabía). El plan sigue diciendo arriba si es tu mañana, tu tarde, tu noche o tu madrugada.
- Los modos de la Guía (Grilla, Próximos, Tu plan) ya no llevan ✓: el elegido se marca con el fondo gris, como los demás botones segmentados.
- Tu plan ya no sugiere «Canal no disponible» como alternativa: es relleno de la guía, no un programa.
- Ayudas de la Guía y del modo ver al día.
- Test nuevo en `e2e/guide.spec.ts`: la Guía abierta pasada la media hora.

## 1.38.0

- **Grilla ahora se llama Nowline.** Es el nombre con el que la app va a estar en el App Store y en Google Play. Tus canales, links, perfiles y códigos siguen igual: no hay que cambiar nada en el reproductor.
- **Ícono nuevo**, con los colores de la app: la grilla de programación con la línea ámbar de «ahora» cruzando lo que se está dando. Se lee mejor en tamaños chicos, como la pestaña del navegador.
- En Android, el ícono también tiene versión de un solo color para los íconos temáticos, y los avisos usan esa silueta.
- El nombre arriba de la app va en minúscula, con el punto de la i en ámbar como el de la línea de «ahora».
- Si ya la tenés en la pantalla de inicio: en Android el nombre y el ícono se actualizan solos; en iPhone y iPad se ven al quitarla y volver a agregarla desde Safari.

## 1.37.0

- **En una pantalla grande, las pestañas van a la izquierda.** En la compu, Canales, Guía, Categorías y Perfil pasan de la barra flotante de abajo a una columna fija a la izquierda, y el contenido usa todo el alto.
- **Letra grande.** Nuevo interruptor en Configuración que agranda toda la app (textos, botones y la Guía) para leer más cómodo. Se recuerda en ese navegador.
- **La Guía muestra dónde está cargando.** Mientras llegan los programas de una hora, en su lugar se ven celdas grises que titilan, en vez de un hueco vacío.
- Ayudas de Canales, Configuración y del modo ver al día (pestañas a la izquierda, letra grande).
- Interno: los últimos colores sueltos de `base.css` y `web.css` pasan a tokens en `worker/web/tokens.css`, y un test falla si vuelve a aparecer un color fijo o una regla de tema oscuro fuera de ese archivo.

## 1.36.7

- **Las hojas se cierran con una animación.** Un canal, Configuración, la ayuda, el programa de la Guía y las demás hojas ya no desaparecen de golpe al tocar la ✕ o Esc: se van con un movimiento corto. En el celular suben desde abajo al abrirse y bajan al cerrarse.
- **En el celular, bajá la hoja con el dedo para cerrarla.** Arrastrá hacia abajo la rayita de arriba o el título: si la soltás antes de la mitad del recorrido, vuelve a su lugar. La rayita es un poco más grande para que se note.
- Con «reducir movimiento» del sistema, las hojas se cierran al instante, como antes.
- Ayudas de Canales y del modo ver al día (cómo cerrar una hoja).
- Interno: `worker/web/ui/sheet.ts` le da a todas las hojas la salida animada y el arrastre (la ✕, Esc, el gesto y también los cierres desde el código; si una hoja se vuelve a abrir mientras sale, se queda); `worker/web/ui/kit.tsx` con `<Progress>` para las barras de cuánto va. Tests nuevos en `e2e/hojas.spec.ts`.

## 1.36.6

- **Lo que está en el aire, en verde.** En la Guía, la línea y la hora de ahora, el borde y la barra del programa que está dando, «En el aire» en la hoja del programa y la barra de cuánto va (también en Canales y en el modo ver) pasan del ámbar al verde. El ámbar queda solo para lo que se toca o se elige: la Guía pasa de ocho cosas en ámbar a dos.
- **Lo elegido se ve igual en todos lados.** Los filtros de Canales, las categorías de la Guía, «Tengo tiempo», los modos de la Guía y los botones segmentados (tema, tipo de proveedor) se marcan del mismo modo: fondo gris y texto en negrita. Antes había cinco formas distintas.
- Los chips y filtros sin elegir tienen un borde más visible, así se nota que son botones.
- En Próximos y Tu noche las horas van en el color del texto, y la línea del plan es una guía fina en lugar de ámbar.
- Perfil: el perfil en uso, «En uso» y los «Agregar…» con menos ámbar.
- Los rótulos de sección en mayúsculas («DEPORTES», «GUÍA ASIGNADA», «MI PROVEEDOR») tienen todos el mismo tamaño y color.
- El botón de ayuda (?) va siempre al lado del título y sin círculo, en todas las pantallas (en Canales y en el modo ver estaba a la derecha). La derecha queda para las acciones y para cerrar.
- Tu noche: el programa que está en el aire se destaca con un tinte verde suave en la tarjeta y «quedan…» en verde, en lugar de la raya verde del costado.
- Ayudas de la Guía y del modo ver al día (el verde es lo que está en el aire).

## 1.36.5

- Interno: auditoría de diseño, paso 2. Los colores, sombras y radios se definen en un solo lugar (`worker/web/tokens.css`), con el claro y el oscuro de cada token juntos en `light-dark(claro, oscuro)`; `build.mjs` lo expande en los bloques de siempre (anda en cualquier navegador). Antes `--accent` se definía en 5 lugares y había 21 bloques `:root`. Suma las escalas de letra, espacio, z-index y tiempos, y `--live` para lo que está en el aire, que las pantallas van a ir adoptando.
- Interno: se borran 171 declaraciones de `base.css` que `web.css` ya pisaba enteras (y 28 reglas que quedaron vacías). La prueba de capturas da 0 diferencias en las 48 pantallas: nada cambia a la vista.

## 1.36.4

- La **barra de abajo** ya no deja leer lo que pasa por detrás: es más sólida y la lista se desvanece antes de llegar a ella.
- En la **Guía**, la hora actual ya no tapa la marca de la media hora, y los programas muy cortos se ven como una franja sin texto (tocala para ver cuál es) en vez de letras sueltas.
- En el **modo ver**, cada canal dice primero cuánto le queda («Quedan 42 min · hasta las 23:45») y no se corta.
- En la computadora, con la hoja de un canal abierta a la derecha, la barra de búsqueda y filtros también se corre y no queda tapada.
- En el celular, los botones y las filas ya no quedan resaltados después de tocarlos.
- Los canales sin logo muestran las mismas iniciales en Canales y en la Guía.
- Con «reducir movimiento» activado, el círculo de «cargando» sigue girando (más lento) y no parece colgado.
- Los avisos que aparecen dentro de una hoja también los lee el lector de pantalla.
- Interno: estilos sin uso borrados, el hover de todo `web.css` solo con mouse (`@media (hover: hover)`), `ui/mono.ts` con las iniciales compartidas. Tests nuevos en `e2e/guide.spec.ts` y `e2e/ver.spec.ts`.

## 1.36.3

- Las etiquetas de resolución (SD, HD, FHD, 4K) se completan mucho más rápido: unos 100 canales por día en vez de 32, y si un canal no se pudo medir se vuelve a intentar al día siguiente en vez de a la semana.
- Con la Guía abierta, las etiquetas aparecen apenas llegan, sin tener que cambiar de pestaña.
- Interno: el relay prueba y mide cada canal con un solo pedido. Antes abría una segunda conexión enseguida, y con cuentas de pocas conexiones el proveedor podía rebotarla y la medición quedaba vacía por una semana.

## 1.36.2

- En la Guía, el **↻** de un programa que vuelve a empezar muestra la repetición más cercana. Cuando un programa repetía varias veces, a veces mostraba la de mañana y no la de hoy, y en la hoja del programa faltaban repeticiones.
- Interno: test en `e2e/guide.spec.ts` con la misma emisión repetida en la respuesta de `/api/ui/again`.

## 1.36.1

- **Ayuda de la Guía.** La Guía tiene su propio **?** al lado del título, con todo lo que hace: Grilla, Próximos y Tengo tiempo, Tu noche y lo que aprende de lo que mirás, las categorías y la hoja de cada programa.
- **Ayuda en el modo ver.** Quien usa Grilla en modo «solo ver» tiene un **?** arriba (y en la Guía) que explica, con letra grande, los canales, las conexiones en uso, la Guía, qué hacer si en la tele dan otra cosa y cómo salir.
- Ayudas al día con la app de hoy: qué son las etiquetas SD, HD, FHD y 4K, los avisos de arriba de los canales, las conexiones que se están mirando en la cuenta, la hora de los eventos del proveedor, el buscador de Categorías y «Volver al orden del proveedor».
- En la ayuda, las preguntas de «Más preguntas» ya no muestran la flecha dada vuelta estando cerradas.
- Interno: `CLAUDE.md` suma la ayuda de la Guía y la del modo ver a las que hay que mantener al día. Tests nuevos de las dos ayudas en `e2e/guide.spec.ts` y `e2e/ver.spec.ts`.

## 1.36.0

- **Tu noche aprende lo que mirás.** Cada vez que abrís un canal con un link de Grilla se anota el canal, la hora y el programa que pasaba, y Tu noche (o tu tarde, o tu mañana) sube lo de siempre: los programas que mirás seguido, tus canales a esa hora y lo que tiene la campana. Sigue armando el plan con lo mejor que hay, sin que nada se pise.
- **El porqué de cada sugerencia:** debajo de cada programa del plan dice por qué está ahí: «Lo mirás seguido», «Tu canal a esta hora», «Le pusiste la campana»…
- **No me interesa y Más como esto.** Tocá un programa de la Guía y elegí **No me interesa** para que no aparezca más en Tu noche, o **Más como esto** para que te lo sugiera más. El plan cambia al momento, y se deshace tocándolo otra vez. Funciona también en el modo ver, y cada perfil tiene sus gustos.
- Ayuda de la Guía al día.
- Interno: plan de la fase 2, con IA para sugerir programas parecidos, en `planes/recomendaciones.md`.
- Worker: `habits/<cfgId>.json` por perfil (`src/habits.ts`), anotado al abrir un canal con un link corto; rutas `GET/POST /api/cfg/<id>/habits` y `/api/view/<código>/habits`. Se borra con la configuración y con `tools/delete_cfg.py`.

## 1.35.0

- **Novedades al actualizar.** Cuando Grilla se actualiza, al abrirla aparece «Grilla se actualizó» con lo nuevo de cada versión desde la última que viste; cada novedad muestra su título y se toca para ver el detalle. La primera vez que se abre Grilla no aparece. También está siempre en **Ver novedades**, al pie de Configuración.
- **Aviso de versión nueva con la app abierta:** «Hay una versión nueva de Grilla» con el botón **Actualizar**, que recarga la app. La app busca versiones nuevas cada vez que volvés a ella.
- **Notificación** a quien tenga los avisos activados cuando sale una versión con funciones nuevas (no con cada arreglo chico): «Grilla se actualizó a 1.35.0», y al tocarla se abren las novedades. Llega una sola vez por dispositivo, aunque tenga varios proveedores.
- Ayuda: «Novedades y versiones nuevas» en Configuración.
- Worker: el cron lee `novedades.json` de los archivos de la web (binding `ASSETS` en `wrangler.toml`), anota la versión avisada en `meta/version.json` y avisa solo cuando sube la versión menor o la mayor; la primera vez solo la anota. `build.mjs` arma `public/novedades.json` con las últimas 12 versiones del CHANGELOG.

## 1.34.0

- **Aviso cuando el relay no responde.** El servicio que habla con el proveedor (relay) baja la lista, prueba los canales caídos y lee la suscripción. Si deja de responder, arriba de los canales aparece «La lista del proveedor no se actualiza desde hace 5 h» (o «Los canales caídos y la cuenta no se actualizan desde hace 3 días»), y la fila «Canales caídos» dice «sin probar desde hace 3 días: el servicio que prueba no responde». Antes todo seguía con datos viejos sin avisar. Sale si la última prueba falló y lo último bueno tiene más de un día, o si la última bajada de la lista falló y la guardada tiene más de 2 horas.
- Worker: la prueba diaria anota `relayOk`/`relayFail` en `health/<cfgId>.json`, la bajada de la lista anota `okAt`/`failAt` en `relaylist/<cfgId>.json` (se borra con la configuración y con `tools/delete_cfg.py`), y `GET /api/cfg/<id>/health` suma `listAt`, `listOkAt` y `listFailAt`.
- Perfil y Categorías: al desplazarse, el encabezado (título, ‹ y ?) ya no deja ver lo que pasa por debajo. Cubre todo el ancho y la zona de la barra de estado con fondo sólido, y aparece una línea fina cuando hay algo debajo (en lugar del degradé de antes). El círculo de «tirar para refrescar» ya no asoma debajo de la barra de estado del iPhone.
- Animaciones cortas donde ayudan a seguir qué cambió: las pestañas de abajo y la Guía aparecen con un fundido, cada página nueva dentro de Perfil entra desde la derecha, los modos de la Guía cambian con un fundido, lo que se prende (categorías, campana) hace un «pop», los avisos de arriba bajan al aparecer, el menú «…» se abre desde su botón y las conexiones del modo ver se despliegan. Con «reducir movimiento» del sistema se apagan.
- Ayuda de «Canales caídos» al día. Tests nuevos: el estado del relay en el Worker y el aviso en la web (`e2e/relay.spec.ts`).

## 1.33.3

- Fin de la migración a Preact (ver `planes/react.md`): la tarjeta de revisión de arriba de la lista (con los canales nuevos) y el menú «…» de una fila pasan a componentes en `worker/web/ui/canales.tsx`. La barra de estado con «Reintentar», la píldora de «sin conexión», los filtros con su cuenta, los íconos sueltos y el QR pasan a `worker/web/ui/piezas.tsx`. `app.ts` ya no arma HTML con texto: se borran `icon()`, `esc()` y el último `innerHTML`. Se ve y se comporta igual.
- Se borran unos 90 selectores de CSS que ya no usaba nadie (restos de pantallas viejas: la fila de guía de antes, el aviso de canales nuevos, el estado de la guía, fuentes de EPG…).
- Tests de humo de la tarjeta de revisión, el menú «…» (Esc y tocar afuera) y «Reintentar» cuando la grilla no carga. El Worker de prueba acepta canales extra.

## 1.33.2

- Limpieza de la migración a Preact: las piezas de la guía que seguían siendo HTML pasan a componentes en `worker/web/ui/epg.tsx` (el logo, lo que está dando ahora, la opción elegible, el buscador de guías y «Ver programación de hoy»). Las usan la lista de Canales, la hoja del canal y la hoja de la selección, que también pasa a Preact (`worker/web/ui/seleccion.tsx`). Se ve y se comporta igual.
- Se borra código que ya no usaba nadie (la fila de guía vieja y su «Ahora» desplegable).
- Tests de humo de la hoja de la selección (elegir una guía para varios, mover y ocultar) y de la programación del día.

## 1.33.1

- Los botones del encabezado de las hojas (cerrar ×, volver, anterior ‹ y siguiente ›) ahora tienen un círculo de fondo y el ícono en el color del texto: antes eran íconos grises sueltos que casi no se notaban, sobre todo en el celular. Al apretarlos se oscurecen un poco. Anterior y siguiente sin a dónde ir quedan con un borde fino y el ícono apagado. Vale para todas las hojas, también en el modo ver. Ver `planes/botones-de-las-hojas.md`.

## 1.33.0

- Guía: **varias categorías a la vez**. Cada botón de categoría se suma o se saca (vuelve a tocarlo para sacarla) y **Todas** limpia. El filtro es el mismo en Grilla, Próximos y Tu noche, y queda guardado en el dispositivo. Con dos o más elegidas, la Grilla sigue con un encabezado por categoría.
- Con más de 8 categorías, la fila muestra las elegidas, una raya y las 5 con más canales con guía. **Más** abre una hoja con buscador, las elegidas arriba y cuántos canales con guía tiene cada una.
- **Tu noche** (o mañana, tarde, madrugada) arma el plan solo con lo elegido y lo nombra («lo mejor de Deportes y Películas»). Si no alcanza para llenar el rato, dice desde qué hora no encontró nada y ofrece **Sumar** la categoría con más canales o **Elegir otras**.
- Anda igual en el modo ver.
- Arreglo: con una categoría elegida, Tu noche volvía a pedir la programación y a armar el plan en cada render.
- Ayuda de la Guía al día. Tests de humo nuevos (`e2e/guia-categorias.spec.ts`).

## 1.32.2

- «Tu código» (Perfil → Usar en otro dispositivo → Ver tu código) pasa a ser una hoja con los dos códigos a la vista, cada uno con su **Copiar** al lado y sin «Cancelar»: arriba el **código para editar** (el del hogar) y abajo el **código para ver** de cada perfil del proveedor (`ver.<código>`). Un perfil que todavía no tiene código para ver lo crea al copiarlo. La hoja está en `worker/web/ui/codes.tsx`.
- Ayuda: «Usar en otro dispositivo» cuenta lo de los códigos para ver, y la ayuda de Perfil suma **Modo ver: para alguien que solo mira** (cómo se comparte, qué ve quien lo usa, el aviso de «la guía no coincide» y cómo quitar el acceso), que faltaba desde la 1.32.0.
- Modo ver: en «Tu noche» (o mañana, tarde, madrugada) ya no dice «Tocá la campana y te aviso», porque ahí no hay campana. Dice que se toca un programa para verlo o una opción para cambiarlo.
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
