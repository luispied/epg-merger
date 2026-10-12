# Perfil infantil: solo lo apto, nunca publicidad

Estado: **implementado con la opción A** (1.48.0, 12/10/2026). Luis eligió la pantalla A y las reglas por defecto de abajo.
Ver «Lo que se implementó» al final.

## Qué se quiere
Un perfil (Proveedor > Cuenta > **Perfil** > Links; ver `planes/perfiles.md`) que solo muestra programas de géneros aptos
para chicos y nunca publicidad. Hoy el perfil ya tiene un filtro de **canales** («qué ve»: categorías y canales, `DeviceFilter`
en `worker/src/playlist.ts`) y la IA ya clasifica **programas** por género (`tools/classify_genres.py` → `ai/genres.json`;
`pack_schedule.py --genres` lo agrega como 5º elemento de cada entrada de la programación). Falta unir las dos cosas.

## Cómo se aplica hoy el filtro del perfil (lo que se encontró)
- **Es por canal, no por programa.** `playlistRows` deja pasar un canal por su categoría o su nombre. Lo usan la playlist del
  reproductor (`servePlaylist`) y el modo ver (`serveView`, que devuelve los canales del perfil del código).
- **La Guía lee la programación pública**: `/api/ui/schedule/<archivo>` (por canal) y el índice por hora
  `/api/cfg|view/<id|código>/hour/<hora>.json` (`cfgHour`), que solo recorta a los canales del perfil. Ninguno filtra por programa.
- **El género llega al navegador solo en la programación por canal** (5º elemento; `guide.tsx` lo usa en `genreTaste` y
  `planScore`, con `NEVER_SUGGEST = 'Publicidad'`). El índice por hora **no** lleva género.
- **Hallazgo importante: lo corto no se clasifica.** `classify_genres.py` usa los títulos de `measure_titles.py`, que son
  los de **25 minutos o más** de los canales en uso. Casi todos los dibujitos duran entre 11 y 30 minutos, así que hoy
  quedarían «sin clasificar» y un perfil estricto los ocultaría. Además la IA depende de `AI_CLASSIFY=on` y de `AI_MAX_TITLES`
  por corrida. Sin resolver esto, el perfil infantil sería un perfil casi vacío.
- El modo ver está atado a un perfil por código (`view/<código>.json` → `viewProfile`) y no puede cambiar nada: es el lugar
  natural para el dispositivo de un chico.

## Reglas candidatas

### Géneros aptos (la lista de la IA es cerrada: `GENRES` en `classify_genres.py`)
| Género | Propuesta |
|---|---|
| Infantil, Educativo | **Entran siempre** (no se pueden sacar) |
| Documental, Cocina, Música, Deportes, Estilo de vida | **Opcionales**, apagados por defecto (un documental de naturaleza puede ser crudo; un partido, tolerable) |
| Película, Serie, Telenovela, Humor, Entretenimiento, Reality, Noticias, Religión, Otro | **No entran**: el género no dice la edad (una «Película» puede ser infantil o de terror) |
| Publicidad | **Nunca**, ni opcional |
| Sin género (no clasificado) | **No se muestra** (lo seguro) |

Límite del género: no es una calificación de edad. «Infantil» según la IA puede colarse con dibujos para adultos
(sátiras animadas). Mitigaciones posibles, de menor a mayor costo: (1) lista de títulos bloqueados por perfil; (2) pedirle a
la IA un campo extra «apto para chicos» (sí/no/dudoso) junto al género, que cuesta unos tokens más por título y se mide
antes; (3) mostrar «Qué se está ocultando» para que el adulto vea qué se filtró y qué no.

### Programas sin clasificar
- **No se muestran.** En la Guía la celda queda como «No disponible en este perfil» (no un hueco, para que se entienda
  que hay algo y la línea de tiempo no se rompa); en la hoja del programa no hay descripción.
- Para que no quede vacío, **hay que clasificar también lo corto**, al menos en los canales que usa un perfil infantil
  (ver «Qué construir»). Opcional más adelante: «confiar en los canales infantiles» (todo lo que pasa en un canal de la
  categoría Infantiles entra aunque no tenga género). Es menos seguro: queda apagado y es decisión de Luis.

### En vivo
Lo que está en el aire **sigue la misma regla**: si el programa de ahora no es apto o no tiene género, la tarjeta del
canal dice «No disponible en este perfil» en lugar del título, la barra y el «después». No se oculta el canal entero (parpadearía
según la hora); el canal entra o no por sus categorías.

### Qué filtra: los tres, más lo que los rodea
- **Guía**: celdas no aptas enmascaradas; búsqueda y «Próximos» solo con aptos.
- **Tu plan**: filtro duro **antes** de puntuar. Los hábitos, «Más como esto» y el género favorito no pueden meter un
  género que el perfil no admite.
- **Lista de canales**: sigue el filtro por categorías. Al activar el perfil se proponen las categorías infantiles (por
  nombre) y se pueden editar. El texto «ahora / después» de cada tarjeta usa la misma regla que la Guía.
- **Playlist y guía XMLTV del reproductor**: los links del perfil siguen mostrando los canales del filtro. **No se puede
  ocultar un programa en el reproductor** con la playlist; sí se puede filtrar el XMLTV de sus links (fase 4). Ver límites.

### Cómo se activa y quién puede quitarlo
- Es una propiedad del perfil: `kids?: { genres: string[] }` en `config.profiles` (lo maneja el Worker por
  `/api/cfg/<id>/profiles`, que el PUT de la config no pisa). Nada cambia en los links ni en sus códigos.
- Se activa y se quita **desde la edición, con la clave de edición** (la que ya tiene quien arma los perfiles). **El modo ver
  nunca puede**: no tiene la clave ni pantalla para eso. Quitar el perfil infantil muestra qué va a cambiar.
- Decisión abierta: ¿pedir además el «código de la casa» al quitarlo? Sirve si el editor queda abierto en un aparato que
  usan los chicos; mientras tanto la defensa es que ese aparato esté en modo ver (el editor no se abre desde ahí).

### Cómo evitar que el modo ver lo esquive
La regla tiene que valer **en el Worker**, no solo en la pantalla: esconder con CSS o filtrar en el navegador se esquiva
mirando la red.
1. Para un perfil infantil, `/api/view/<código>/hour/…` y un nuevo `/api/view/<código>/schedule/<archivo>` devuelven la
   programación **ya filtrada**: las entradas no aptas salen sin título ni descripción (con su hora, para dibujar el hueco).
2. El modo ver de un perfil infantil usa solo esas rutas; no pide `/api/ui/schedule/…` (que es público).
3. `/api/view/<código>/habits` y los «Más como esto» ignoran lo que no es apto (el género se verifica en el Worker, no
   se cree el que manda el navegador).
4. `serveView` ya filtra los canales por el perfil. El modo ver no tiene acceso al editor ni a la clave.
5. Prueba con el Worker real: pedir cada ruta con un código infantil y comprobar que ningún título no apto aparece.
Límite: la programación por canal y por hora sin código sigue siendo pública (es la guía de TV de todos); el filtro
protege a quien usa la app con ese código, no a quien sabe el `cfgId` y sabe pedir rutas a mano.

## Límites honestos (esto va en la ayuda tal cual)
- **La IA se equivoca.** Clasifica por título y descripción, sin ver el programa. Un dibujo para adultos puede salir como
  «Infantil» y un programa de chicos como «Otro». Se sabe de errores sueltos en las pruebas (`planes/ia-tu-plan.md`).
- **No es control parental.** No reemplaza el PIN del reproductor ni la calificación por edad del proveedor. Es un
  filtro de lo que **Nowline muestra**: quien tenga el link de la playlist en TiviMate puede abrir cualquier canal que esté
  en la lista, y el reproductor no sabe qué programa es.
- **No cubre lo que no clasifica**: programas cortos sin clasificar (hasta resolverlo), canales fuera de los que usa la
  configuración, y el título del programa en vivo si la guía del proveedor está mal.
- El tipo de seguridad es «lo seguro es ocultar»: ante la duda, no se muestra, aunque a veces oculte de más.

## Pantalla: tres alternativas
Maquetas en `capturas/mocks-perfil-infantil/mock.html` (con `tokens.css` y las clases de la app: `menu-row`, `switch`,
`segmented`, `chip-btn`, hojas; un solo «elegido» con relleno `--fill` y letra 600; ámbar solo en la acción). Capturas en
claro y oscuro en los archivos del proyecto: `capturas/mocks-perfil-infantil/{a,b,c}-{light,dark}.png`.

- **A. Interruptor en la página del perfil (recomendada).** Fila «Perfil infantil» con interruptor entre «Qué ve» y
  «Cuenta», como «Letra grande» o «Avisos». Al prender se abre una hoja que dice qué cambia y deja elegir los géneros;
  ya activo, aparecen «Géneros que entran» y «Qué se está ocultando». Sirve para perfiles nuevos y existentes; reusa el
  patrón de interruptor que ya existe.
- **B. Tipo al crear el perfil.** Segmentado Normal / Infantil en «Perfil nuevo». Lo más simple y sin riesgo de activarlo
  por error, pero un perfil que ya existe no se puede convertir.
- **C. Preajuste dentro de «Qué ve».** Segmentado Todo / A medida / Infantil arriba de los filtros, con el código de la casa
  para quitarlo. Un solo lugar para lo que filtra, pero mezcla el filtro por categoría con el de programa y hay que
  rehacer la hoja de «Qué ve».

## Qué construir (fases; cada una un PR chico)
1. **Clasificar lo corto** (`tools/measure_titles.py` y `classify_genres.py`): incluir títulos de menos de 25 minutos al
   menos de los canales de perfiles infantiles, **midiendo antes el costo y el peso extra en R2** (hoy `ui/schedule/s`
   ~78 MB). Con los números del plan de IA (~86 tokens de entrada y ~37 de salida por título), cada 1.000 títulos nuevos
   cuestan centavos, pero hay que medir cuántos son. Opcional: campo «apto» además del género.
2. **Worker**: `kids` en `ProfileDef` (validación y límites), función única `isApt(género, kids)` y las rutas filtradas del
   modo ver (arriba), con tests de que nada no apto sale. No se toca `short/`, `devices/` ni `TOKEN_KEY`.
3. **Web**: la pantalla elegida (con piezas de `ui/kit.tsx`; si falta una, se agrega ahí), enmascarado en la Guía, en
   Tu plan, en las tarjetas «ahora/después» y en el modo ver; esqueleto y «Probar de nuevo» como en el resto. Ayuda al día
   (temas de `index.html`, textos `<Help>` y ayuda de `ver.tsx`), versión **menor** y CHANGELOG, e2e (activar, quitar, ver
   enmascarado, Tu plan sin géneros no aptos).
4. **Reproductor** (si Luis quiere): XMLTV de los links del perfil sin programas no aptos (`/g/<código>.xml.gz`).
5. **Después**: títulos bloqueados o permitidos a mano; «Qué se está ocultando».

## Decisiones para Luis
1. Pantalla: A, B o C.
2. Géneros aptos por defecto: ¿solo Infantil y Educativo, con el resto opcional?
3. ¿Clasificar lo corto (fase 1) aunque suba el costo? Sin eso el perfil queda casi vacío.
4. ¿Pedir el código de la casa para quitarlo?
5. ¿«Confiar en los canales infantiles» para los sin clasificar, o siempre estricto?
6. ¿Filtrar también la guía del reproductor (fase 4)?

## Lo que se implementó (1.48.0, opción A)
- **Pantalla**: fila «Perfil infantil» con interruptor en la página del perfil (sección «Para chicos»), hoja de géneros y, ya
  activo, «Géneros que entran» y «Qué se está ocultando» (`ui/perfiles.tsx`; la hoja es `#kidsDialog`, con el estilo de `ask-sheet`).
- **Reglas** (decisiones 2 y 3 por defecto): entran siempre Infantil y Educativo; opcionales y apagados Documental, Cocina,
  Música, Deportes y Estilo de vida; Película, Serie y lo demás no; Publicidad nunca; lo sin clasificar no se muestra, también
  en vivo («No disponible en este perfil»). Tu plan filtra antes de puntuar (los programas no aptos llegan sin título, así
  que no hay con qué puntuarlos). La clasificación de lo corto (≥5 min) ya salió en #352 y crece de a 10.000 títulos por corrida:
  la ayuda dice que el perfil se va completando.
- **Dónde se guarda**: `kids?: { genres }` en `config.profiles` (`worker/src/kids.ts`: `parseKids`, `isApt`). Se activa y se
  quita con `PUT /api/cfg/<id>/profiles/<id>` `{ kids }` (o `null`), que exige la clave de edición; el modo ver no tiene cómo.
- **Dónde se aplica** (en el Worker): `/api/view/<código>/hour/…` y la nueva `/api/view/<código>/schedule/<archivo>.json`
  devuelven la programación ya filtrada (título, descripción y género de lo no apto, vacíos; la hora queda). Los hábitos del
  modo ver (`/habits`) dejan afuera lo no apto. `serveView` suma `kids: true` y la web de ver usa solo esas rutas (nunca
  `/api/ui/schedule/…`). Prueba con el Worker real en `test/worker.test.ts`.
- **Dudas 4, 5 y 6**: (4) el código de la casa para quitarlo **no se pidió**: el editor no tiene hoy un paso simple para
  pedirlo (el editor ya tiene la clave y el código se pega en otra parte); quitarlo pide la clave de edición y una
  confirmación que dice qué cambia. (5) Sin clasificar queda **estricto**. (6) La **guía XMLTV del reproductor no se filtra**
  en esta primera versión (fase 4): un reproductor que use los links del perfil ve la guía completa de sus canales; la ayuda
  lo dice como límite.
- **Límite sin cambios**: en la edición se ve todo (el filtro vale en el modo ver del perfil), y la programación por canal y por
  hora sin código sigue siendo pública.
