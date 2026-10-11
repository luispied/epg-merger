# Tu noche con lo que solés mirar

## Por qué
Luis (10/10/2026): «En la Guía, en Tu noche, me sugiere cosas que no me interesan. ¿Cómo le digo que me sugiera cosas
que usualmente veo?». Hasta 1.35.0, Tu noche elegía solo por el programa: partidos en vivo primero, después películas,
largo, sin repeticiones ni noticieros. No sabía nada de quien mira.

## Fase 1: hábitos, sin IA (1.36.0) ✅
Lo que ya pasa por Grilla alcanza para saber qué se mira:

- **Aprender de lo que se abre.** Cada vez que un link corto abre un canal (`/s/<código>/<id>`, que ya anota el último
  canal con `notePlay`), el Worker suma en `habits/<cfgId>.json`, por perfil del link: el canal (por su guía), la hora UTC
  y el título que pasaba en ese momento (de `ui/schedule/`, sin títulos genéricos; la misma emisión cuenta una vez).
  Lo que no se mira hace 90 días se olvida; se guardan como mucho 300 canales y 500 títulos.
- **Señales que ya había:** la campana y las categorías elegidas.
- **Pedidos:** «Más como esto» y «No me interesa» en la hoja del programa (en el editor y en el modo ver). Se deshacen
  tocándolos otra vez o con Deshacer.
- **Puntaje:** `habitAffinity` (`worker/web/ui/guide.tsx`) suma al puntaje de siempre: el título visto (hasta +4), el
  canal a esa hora ±1 (hasta +3), el canal en general (hasta +1,5), la campana (+3) y «Más como esto» (+3). «No me
  interesa» lo saca del plan. Pesa como un partido en vivo: lo de siempre sube, pero no tapa todo.
- **El porqué:** debajo de cada sugerencia, la razón que más pesó («Lo mirás seguido», «Tu canal a esta hora», «Le
  pusiste la campana», «Pediste más como esto», «De tus canales»).
- Rutas: `GET/POST /api/cfg/<id>/habits` (editor: todos los perfiles juntos) y `GET/POST /api/view/<código>/habits`
  (el perfil). Se borra con la configuración y con `tools/delete_cfg.py`.

Límites: solo cuenta lo que se mira con links de Grilla (no lo que se mira con otra app), solo canales con guía, y
«Más como esto» sube el mismo programa, no otros parecidos.

## Fase 2: IA para entender de qué trata cada programa (pendiente)
Con los hábitos, Tu noche sabe *qué* se mira, pero no *de qué tipo* es. Un modelo de lenguaje puede leer título y
descripción de la guía y clasificar cada programa (género, subgénero, deporte y equipo, público, si es estreno o
repetición). Con eso:

- «Más como esto» sugiere programas parecidos en canales que nunca abriste («te gustan los documentales de
  naturaleza: hoy a las 22 hay uno en Nat Geo»).
- Las categorías del proveedor (que a veces son cualquier cosa) se completan con el género real del programa.
- El porqué puede ser más claro: «Porque mirás fútbol uruguayo».

Cómo haría falta armarlo:
- **Clasificar una vez por título, no por persona.** La corrida diaria ya junta toda la guía; clasificar los títulos
  nuevos de cada día (muchos se repiten) y guardar `ui/genres/<sha1>.json` al lado de `ui/schedule/`. La guía es la misma
  para todos: no se manda nada de quien mira.
- **Costo:** decenas de miles de títulos por día, la mayoría repetidos. Con caché por título y un modelo chico (Haiku)
  en lotes, debería quedar en centavos por día. Medirlo con una semana de guía antes de prenderlo.
- **Privacidad:** los hábitos no salen del Worker; el modelo solo ve la guía pública. Si alguna vez se usa para armar el
  plan con los hábitos (por ejemplo, «explicame por qué»), avisarlo en la ayuda y dejar apagarlo.
- **Sin IA disponible**, todo sigue como en la fase 1.

### Decisiones (11/10/2026)
- Modelo: **Claude Haiku 5.5** por la **API de lotes** (mitad de precio; la corrida diaria no necesita la respuesta al
  instante). Sin «pensar»: es una etiqueta, no un razonamiento.
- Antes de gastar nada, **medir gratis** cuántos títulos nuevos aparecen por día: `tools/measure_titles.py`, en la
  corrida diaria (paso «Measure titles for AI (free)»). Cuenta los títulos distintos de 25 minutos o más (lo que puede
  sugerir Tu noche), en toda la guía y en los canales que usa alguna configuración, recuerda los vistos en
  `ai/seen.json` de R2 y deja cada día en `ai/measure.json` y en el resumen de la corrida, con la proyección mensual.
- 11/10: Luis cargó `ANTHROPIC_API_KEY` en el repo, US$ 5 de crédito sin recarga y un límite de US$ 5 por mes. Pidió
  una prueba con muestras antes de prender la IA y un interruptor para apagarla (`AI_CLASSIFY`).

## Estado
- ✅ 1.36.0: fase 1 (Worker, puntaje, porqué, «Más como esto» / «No me interesa», ayuda y tests).
- 🔄 Fase 2: midiendo gratis el volumen y el costo (`tools/measure_titles.py`).
- 🔄 Fase 2: `tools/classify_genres.py` clasifica con Haiku 5.5 por lotes (caché `ai/genres.json`, gasto en
  `ai/spend.json`, lote sin terminar en `ai/pending.json`). Prueba a mano: Actions → Merge EPGs → Run workflow con
  `ai_muestras` (página `ia-muestras` en los artefactos). Diaria solo con la variable del repo `AI_CLASSIFY` = `on`
  (apagada por defecto), con tope `AI_MAX_TITLES` (3000). Resumen y decisiones en `planes/ia-tu-plan.md` de los
  archivos del proyecto.
- Pendiente: clasificar de verdad, usar géneros y temas en los hábitos y en Tu noche.
