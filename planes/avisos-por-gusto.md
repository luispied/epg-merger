# Avisos por gusto

## Qué es
La campana avisa sola «Esta noche dan un documental» según el género que más mira la persona. Es una propuesta: no se
construye nada hasta que Luis elija una de las tres pantallas (mocks en `capturas/mocks-avisos-gusto/`, capturas en
claro y oscuro, iPhone y escritorio, en `/mnt/project-files/capturas/mocks-avisos-gusto/`).

## Cómo funciona hoy
- **Push** (`worker/src/push.ts`): Web Push con VAPID. Las suscripciones son **por configuración** y por dispositivo
  (`push/<cfgId>.json`), solo desde el editor (llevan la clave de edición). La corrida programada (`crons = */30 * * * *`)
  llama a `checkAllPush`, que hoy manda tres tipos: canales nuevos, vencimiento de la cuenta y recordatorios.
- **Campana** (`remind.ts`, `ui/guide.tsx`): «Avisarme» guarda `remind/<cfgId>.json` (hasta 30) y `notifyReminders` manda
  el push entre 0 y 30 minutos antes de que empiece. En el **modo ver no existe**: `host.viewer` oculta la campana y no hay
  suscripción push, porque no hay clave de edición.
- **Gustos** (`habits.ts`, `habitAffinity` y `genreTaste` en `ui/guide.tsx`): por perfil, qué canales, horas y títulos se
  abren con links de nowline, con el género de cada programa (5º campo de la programación, de la IA de #317/#328).
  «Más como esto» y «No me interesa» ya existen. `Publicidad` nunca se sugiere. Hoy el puntaje se calcula **en la web**.

## Reglas propuestas
| Tema | Regla |
|---|---|
| Cuántos | **Máximo 1 por día y 3 por semana** por configuración (no por dispositivo: un aviso, todos los dispositivos). Cuentan solo los de gusto: canales nuevos, vencimientos y campanas que la persona pidió no gastan cupo. |
| Silencio | Nunca entre las **22:00 y las 9:00** hora de la persona. Ventana de envío por defecto **18:00 a 21:00** (la corrida es cada 30 min, alcanza). Se guarda la zona horaria del dispositivo al prender (hoy el Worker solo conoce Buenos Aires). |
| Qué es un gusto | El género con más peso en `genreTaste` (≥ 3 emisiones vistas en 30 días y ≥ 25 % de lo mirado) o el de un «Más como esto» vigente. Nunca `Publicidad`, `Noticias` ni `Otro`. Ni títulos con «No me interesa». |
| Qué programa | De la programación de los canales de la lista (visibles), empieza entre 30 min y 4 h desde el envío, dura ≥ 40 min, no es repetición ni se vio antes, no tiene ya campana y no se avisó el mismo título en 14 días. El mejor por puntaje de hábitos (el de Tu plan). Si no hay uno bueno, **no se manda nada**. |
| Cómo se apaga | Interruptor propio en Configuración, **apagado por defecto** (se ofrece una vez; si no lo prende, no se vuelve a pedir). Apagar «Avisos» lo apaga todo. Desde el aviso (la hoja del programa) se apaga un género: «No avisarme de documentales». |
| Cómo se deshace | Toast con «Deshacer» al apagar un género; el género apagado se vuelve a prender en la hoja de Configuración (opción B) o apagando y prendiendo el interruptor (A). Tres «No me interesa» seguidos en un género lo apagan solos (y lo dice). |
| Modo ver | No hay push (no hay campana). Dos caminos: dejarlo sin avisos y que **Tu plan** siga dando el porqué, o la opción C, una tarjeta dentro de la app que sirve igual en la edición y en el modo ver, con su interruptor en Configuración. |
| Privacidad | Los hábitos no salen del Worker; el mensaje lleva solo género, título y canal de la guía pública. |

## Riesgos de molestar
- Spam: por eso tope bajo, apagado por defecto y «si no hay algo bueno, nada». Mejor 3 por semana que 7.
- Gustos de la casa mezclados: el editor junta todos los perfiles; el aviso puede ser de quien no tiene el celular.
  Duda para Luis: atar cada suscripción a un perfil.
- Género mal puesto por la IA (errores sueltos medidos en #302): la hoja deja decir «No me interesa» y apagar el género.
- Repetirse: el mismo documental en tres canales, o el de siempre cada día; lo cubre la regla de 14 días y de repeticiones.
- iPhone: el push solo anda con la app instalada; sin permiso, la opción C sigue funcionando.
- Hora: un aviso a las 3 de la mañana por tener mal la zona. Se guarda la del dispositivo y se prueba con zonas distintas.

## Costo
**US$ 0 de IA.** El género ya viene clasificado en la corrida diaria (US$ ~1/mes, sin cambios). El aviso es una cuenta
sobre `habits/<cfgId>.json` y la programación ya guardada, y una escritura chica por día en `push/<cfgId>.json`. Cloudflare:
la corrida de 30 min ya existe; se suman lecturas de R2 solo para configuraciones con push y el interruptor prendido.

## Qué hay que construir
1. **Worker**: pasar el puntaje de gustos (`habitAffinity`, `genreTaste`, `planScore`) de `ui/guide.tsx` a `core/` para
   usarlo en el Worker sin duplicarlo; `notifyTaste` en `push.ts` (después de `notifyReminders` en `checkAllPush`); estado en
   `PushState.taste` (`on`, `off: string[]`, zona, últimos avisos con fecha y título); la lectura de la programación de
   `schedule.ts` por canal de la lista.
2. **Rutas**: `GET/POST /api/cfg/<id>/push/taste` (prender, apagar géneros, zona).
3. **Web**: fila e interruptor en `ui/settings.tsx` (A o B), hoja en `ui/` si es B; botón «No avisarme de …» en la hoja del
   programa; tarjeta en la Guía y fila en la configuración del modo ver si es C (`ver.tsx`).
4. **Ayuda** (regla del proyecto): temas `settings` y `guide` de `index.html`, `<Help>`, ayuda del modo ver.
5. **Tests**: unitarios de reglas (tope, silencio, zona, 14 días, sin candidato), de worker y e2e (interruptor, géneros, deshacer).
6. Versión (menor) y CHANGELOG.

## Alternativas (mocks)
- **A · Un interruptor** (`a.html`): una fila nueva bajo «Avisos» con valores fijos; el aviso lleva a la hoja del programa
  con «No avisarme de documentales». La más simple y lo más rápido de construir.
- **B · Hoja con control** (`b.html`): la fila abre una hoja con géneros, horario, cuántos por semana y los últimos avisos
  con «Menos así». Más control, más pantalla y más ayuda que mantener.
- **C · Dentro de la app** (`c.html`): tarjeta arriba de la Guía (reusa `gd-teaser`) sin permisos y también en el modo ver.

**Recomendación**: A para el push (opcional, apagado por defecto) más C para que el modo ver y quien no quiere
notificaciones tengan lo mismo. B solo si A se queda corto después de usarla. Es un orden, no un paquete: se puede construir
A sola.

## Decisiones por defecto de esta propuesta (para confirmar)
Tope 1 por día y 3 por semana; silencio de 22 a 9; envío de 18 a 21; apagado por defecto; sin Noticias; datos de la casa
(todos los perfiles juntos, como Tu plan en el editor); sin temas (el 2º campo de la IA no llega a la web; sumarlo pesa
en las tandas de R2 y no hace falta para avisar por género).
