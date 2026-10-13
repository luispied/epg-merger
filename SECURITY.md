# Seguridad

## Reportar una vulnerabilidad

Si encontrás una vulnerabilidad en nowline (el Worker, la web, el relay o las herramientas del repo), no abras un issue público.

Reportala en privado desde la pestaña **Security → Report a vulnerability** de este repositorio. Ahí queda visible solo para los mantenedores.

En el reporte incluí:

- qué parte del sistema afecta (Worker, web, relay, tools/, CI);
- los pasos para reproducirla;
- el impacto que imaginás (qué datos o accesos quedan expuestos).

No hace falta que la pruebes contra servicios de terceros ni contra datos de otros usuarios. Si la prueba requiere tocar producción, avisá antes y usá un entorno local.

## Qué esperar

- Acusamos recibo del reporte lo antes posible.
- Evaluamos si la vulnerabilidad es real y qué tan grave es.
- Coordinamos la corrección y, si corresponde, la publicación del aviso una vez que haya un arreglo disponible.

## Secretos y credenciales

Nunca subas credenciales, tokens ni claves al repositorio. GitHub bloquea los push que contienen secretos conocidos (secret scanning con push protection). Si un secreto se filtró igualmente, reportalo como una vulnerabilidad y rotalo de inmediato.
