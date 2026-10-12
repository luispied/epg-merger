# IA en Tu plan

Resumen de todo lo hablado y hecho sobre usar IA en **Tu plan** (antes «Tu noche»). Armado el 11/10/2026 a partir de la
conversación del 10–11/10 en la sesión «Tareas pendientes epg-merger», los PRs #276 y #279 y `planes/recomendaciones.md`
del repo (que sigue siendo el plan técnico de la función).

## Prueba con muestras (12/10, PR #302)
- Corrida a mano de Merge EPGs con `ai_muestras` = 200: 200 títulos de los canales en uso, 4 tandas, el lote tardó 3 min.
- **Costo medido**: 17.186 tokens de entrada y 7.337 de salida, unos US$ 0,003 (≈ 86 de entrada y 37 de salida por
  título). Con eso: 1.000 títulos nuevos por día ≈ US$ 0,40 por mes; 3.000 ≈ US$ 1,20.
- Géneros: Documental 30, Deportes 28, Película 24, Serie 24, Noticias 22, Reality 16, Otro 15, el resto menos.
- Página: `capturas/ia-muestras/muestras-2026-10-12.html` (también en el artefacto `ia-muestras` de la corrida).
- Para mejorar antes de prender: los infomerciales entran (sugerir un género «Publicidad» y sacarlo de Tu plan), a veces
  los temas repiten el título («zoey 101», «blue bloods»), y con títulos sin descripción cae en «Otro».
- **Ajustes (PR #305 y #308)**: género «Publicidad» (Tu plan nunca lo sugiere), temas sin el nombre del programa, y los
  títulos sin descripción se clasifican por lo que el modelo conoce del título.
- **Tercera prueba** (12/10, 200 títulos): «Otro» bajó de 15–16 a 11, y de 25 títulos sin descripción solo 5 quedaron en
  «Otro» (nombres de canal o programas locales que no dicen nada). Los dos infomerciales cayeron en Publicidad. Errores
  sueltos aceptables: «Mexicánicos» como Música, «100 días a lo salvaje» como Película. Página:
  `capturas/ia-muestras/muestras-2026-10-12-v3.html`. Lista para prender.
- Interruptor: variable del repo `AI_CLASSIFY` = `on` (Settings → Secrets and variables → Actions → Variables).
  Apagada mientras no exista. Alcance recomendado: (a) solo Tu plan.

## Estado en una línea
La IA **no está prendida**. Solo está mergeada la **medición gratis** (#279), que todavía no corrió ni una vez: la última
corrida «Merge EPGs» es del 10/10 a las 20:38 UTC, antes del merge, y la del 11/10 todavía no había arrancado a las
20:40 UTC (GitHub atrasa los cron; el día anterior corrió tres horas tarde).

## Cómo llegamos acá
| Cuándo (UTC) | Qué pasó |
|---|---|
| 10/10 22:17 | Luis: Tu noche sugiere cosas que no le interesan. ¿Se arregla así o hace falta IA? |
| 10/10 22:18 | Propuesta: primero hábitos sin IA. La IA queda para generalizar por género. |
| 10/10 22:40 | **#276 (1.36.0)**: Tu noche aprende lo que se mira, con el porqué, «Más como esto» y «No me interesa». La fase 2 con IA queda anotada en `planes/recomendaciones.md`. |
| 10/10 23:22 | Luis pide ver cómo funcionaría la IA antes de decidir. Se explica (abajo). |
| 11/10 02:00 | Luis pregunta el costo mensual. Se pasan rangos (abajo). |
| 11/10 02:23 | Luis: **«Vamos con Haiku y lotes, empezá midiendo gratis»**. |
| 11/10 02:27 | **#279**: medición gratis en la corrida diaria, sin llamar a ninguna IA. |
| 11/10 05:25 | «Tu noche» pasa a llamarse «Tu plan» (#288, 1.38.1); en #289 (1.39.0) pasa a ser una tarjeta. |

## Objetivo
Con los hábitos, Tu plan sabe **qué** se mira, pero no **de qué tipo** es. La IA lee el título y la descripción de cada
programa de la guía y le pone una etiqueta. Con eso:

- **Sugiere cosas parecidas** en canales que nunca se abrieron: «mirás documentales de naturaleza, hoy a las 22 hay uno en
  Nat Geo».
- **«Más como esto»** sube lo *parecido*, no solo el mismo programa (hoy solo sube el mismo título).
- **«No me interesa»**, usado varias veces sobre el mismo tema, baja ese tema.
- **El porqué** se vuelve más claro: «Porque mirás fútbol uruguayo».
- Opcional, alcance (b): filtrar la Guía por el género real en vez de las categorías del proveedor.

## Qué genera la IA
Por cada **título distinto** (no por emisión ni por persona):

- **Un género** de una lista cerrada (Película, Serie, Deportes, Noticias, Infantil, Documental…).
- **Hasta 3 temas libres**: subgénero, deporte, equipos, público.
- Si es **en vivo o repetición**, cuando la descripción lo dice.

Ejemplos de la propuesta: «Película · thriller, espionaje», «Deportes · fútbol, Peñarol, Nacional · en vivo».

## Modelo y forma de llamarlo
- **Claude Haiku 5.5** (`claude-haiku-5-5`) por la **API de lotes** (Message Batches), elegido por Luis. Los lotes cuestan la
  mitad y pueden tardar horas, lo que no importa en una corrida diaria.
- Tandas de unos **50 títulos por pedido**, con las instrucciones fijas (en caché) y la descripción recortada a 300 caracteres.
- **Sin «pensar»**: es una etiqueta, no un razonamiento. En Haiku 5.5 el pensamiento viene prendido por defecto; se apaga con
  `thinking: {type: "disabled"}` y esfuerzo `low` (se permite hasta `high`). La respuesta, con formato fijo (salida
  estructurada).
- Se descartó Opus 5.5: cuesta unas 50 veces más y para esta etiqueta no suma.

## Costo
**Precio** (lista de Anthropic, verificada hoy): Haiku 5.5 cuesta US$ 0,10 por millón de tokens de entrada y US$ 0,50 de
salida (con lotes, US$ 0,05 y US$ 0,25). Es lo que usa `tools/measure_titles.py`.

**Estimado** (11/10 02:00, sin medir; supone ~70 tokens de entrada y ~25 de salida por título):

| Títulos nuevos por día | Haiku 5.5 | Haiku 5.5 con lotes |
|---|---|---|
| 1.000 (guía estable) | ~US$ 0,75 / mes | ~US$ 0,40 / mes |
| 3.000 (lo más probable) | ~US$ 2,25 / mes | ~US$ 1,10 / mes |
| 8.000 (muchos cambios) | ~US$ 6 / mes | ~US$ 3 / mes |
| Primer día, toda la guía (~20.000 títulos, una vez) | ~US$ 0,50 | ~US$ 0,25 |

- Se paga **una vez por título nuevo**: un noticiero diario se paga un solo día.
- **No depende de cuánta gente use Nowline**: se clasifica la guía, que es la misma para todos.
- **Medido: todavía nada.** Los números reales salen de la medición gratis (abajo) con 5 a 7 días de datos.

## La medición gratis (#279, ya en main)
- `tools/measure_titles.py`, paso «Measure titles for AI (free)» de `merge-epgs.yml` (cron 17:30 UTC, `continue-on-error`).
- Cuenta los títulos distintos de **25 minutos o más** (lo que puede sugerir Tu plan), sin relleno («Programa pagado»,
  infomerciales), en **toda la guía** y en los **canales que usa alguna configuración** (el número que importa).
- Recuerda los vistos en R2 (`ai/seen.json`, olvida a los 60 días). Desde el **segundo día** cuenta los **nuevos**.
- Deja la historia en R2 (`ai/measure.json`, 90 días) y la tabla «Clasificar la guía con IA: medición (sin costo)» en el
  resumen de cada corrida (Actions → Merge EPGs), con la proyección mensual.
- Primer dato esperado: la corrida del 11/10. Promedio confiable: hacia el 16 o 18/10.

## Cómo se guarda cada resultado (una vez, en R2)
- **Caché por título**: clave = hash corto del título normalizado (el mismo `title_key` de la medición), valor = género y
  temas. Un título ya clasificado no se vuelve a mandar nunca. Propuesta: `ai/genres.json` (o partido en lotes), al lado de
  `ai/seen.json`.
- La corrida diaria toma los títulos nuevos de las próximas 30 horas, clasifica solo los que no están en el caché y agrega la
  etiqueta a la programación por canal que ya baja la web, sin pedidos nuevos.
- **A revisar al implementar**: el plan original decía guardar en `ui/genres/` o dentro de `ui/schedule/<canal>.json`, pero
  desde #295 `ui/schedule` va en 256 lotes comprimidos. La etiqueta tiene que entrar en ese formato sin volver a subir todo
  (regla de consumo: subir solo lo que cambió).
- Los **hábitos** (`habits/<cfgId>.json`) suman también género y temas cuando se anota lo que se mira.

## Cómo apagarla
- **Sin clave, no hay IA.** Si falta `ANTHROPIC_API_KEY` o la IA falla, todo sigue como en 1.36.0: lo que no tiene
  etiqueta no suma puntos. Esto sí se habló.
- **Bandera (propuesta, no se habló ni existe)**: una variable del repo en Actions, por ejemplo `AI_CLASSIFY` = `on`/`off`,
  que el paso lee antes de llamar a la IA. Apagarla no borra el caché; Tu plan sigue usando lo ya clasificado.
- **Tope por corrida (propuesto, no hecho)**: como mucho N títulos por corrida (por ejemplo 10.000). Si un día la guía trae
  algo raro, corta ahí y sigue al día siguiente.
- **Registro de gasto (propuesto, no hecho)**: cada corrida anota en su resumen cuántos títulos mandó y cuánto costó.

## Privacidad
Al modelo solo le llega la **guía pública** (títulos y descripciones). Nada de lo que mira cada uno, ni códigos, ni cuentas,
ni nombres de fuentes. Los hábitos no salen del Worker. Si algún día se usa la IA con los hábitos (por ejemplo «explicame
por qué»), avisarlo en la ayuda y dejar apagarlo.

## Pasos de Luis (cuando decida prenderla)
1. **Crear una clave** en la consola de Anthropic, en la sección de claves de API. El costo va a esa cuenta.
2. **Cargarla en GitHub**: repo → Settings → Secrets and variables → Actions → New repository secret, nombre
   `ANTHROPIC_API_KEY`.
3. **Poner un límite de gasto mensual** en la consola de Anthropic, en los límites de gasto, por ejemplo **US$ 5**. Con eso es
   imposible pasarse.

Hecho el 11/10: clave creada (workspace «epg-merger») y secreto `ANTHROPIC_API_KEY` cargado en GitHub. Límite: US$ 5 por mes y US$ 5 de crédito sin recarga automática. La pantalla «Rate limits» es de velocidad (tokens por minuto), no de gasto: se deja como está. Con créditos prepagos y sin recarga automática, cargar US$ 5 ya funciona como tope.

## Pendiente
- [ ] Juntar 5 a 7 días de medición y pasarle a Luis el costo mensual real (toda la guía y canales en uso).
- [ ] Confirmar que la corrida diaria corre: al 11/10 20:40 UTC la medición todavía no había corrido nunca.
- [x] Luis: clave y secreto `ANTHROPIC_API_KEY` (11/10).
- [x] Luis: límite de gasto US$ 5 por mes y US$ 5 de crédito sin recarga automática (11/10).
- [ ] Clasificar de verdad: `tools/classify_genres.py` con lotes, caché en R2, tope por corrida, registro de gasto y bandera.
- [ ] Usar género y temas en los hábitos, en el puntaje de Tu plan, en «Más como esto» / «No me interesa» y en el porqué.
- [ ] Ayudas al día (Guía, Tu plan, modo ver) y CHANGELOG cuando cambie la interfaz.

## Decisiones abiertas de Luis
1. **Alcance**: (a) solo Tu plan, o (b) además filtrar la Guía por género real.
2. ~~Prueba antes de prender~~: hecha el 12/10 (arriba).
4. ~~La bandera~~: hecha (`AI_CLASSIFY`, PR #302). Falta decidir cuándo prenderla.
