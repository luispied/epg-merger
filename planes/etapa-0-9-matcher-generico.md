# Etapa 0.9: matcher genérico (antes de la Etapa 1)

Prerrequisito: Etapa 0 (✅). Va **antes** de `planes/etapa-1-web-sin-github.md` y decide si
vale la pena seguir con ella.

## Contexto
Probado el 28/09/2026 con listas públicas de iptv-org (Argentina, Chile, Uruguay, España), sin
la configuración de Luis: el matcher le asigna guía al **17–24 %** de los canales, casi todo
"dudoso". Está muy ajustado al proveedor de Luis (banderas, prefijos `AR|`). Problemas vistos:

1. Etiquetas de calidad del nombre ("(1080p)", "[Geo-blocked]", "[Not 24/7]") bajan el puntaje.
2. No usa el país del `tvg-id` (`Clan.es@SD`) ni el país de la lista: "Clan (1080p)" de España
   → `Clan.ar`.
3. No aprovecha `tvg-id` casi exactos (`TelefeRosario.ar@SD` vs `TelefeRosario.ar`).
4. Variantes regionales ("Telefe Buenos Aires") no encuentran el canal base (`Telefe.ar`).
5. Al darle más peso al país aparecen **falsos positivos graves**: "AMC Latin America" y
   "Comedy Central Latin America" → "Playboy TV Latin America" (palabras de región tomadas
   como parte del nombre).

## Criterio para seguir con la Etapa 1
- **Precisión ≥ 95 %** en lo que se marca "Bien" (puntaje ≥ 0,8), en todo el banco de prueba.
- **Sin regresión para Luis:** con su configuración, sus overrides se siguen respetando y el
  matcher solo (sin overrides) acierta al menos lo mismo que hoy contra ellos.
- **Cobertura** comparable a IPTVEditor o m3u4u con la misma lista (prueba manual de Luis con
  `prueba-argentina.m3u`, porque esos servicios piden cuenta).

Si no se llega, se repiensa antes de invertir en el servicio.

## Trabajo, en PRs separados
### 1. Banco de prueba (`tools/match_benchmark.py`, `bench/`) ✅
- **Listas:** copias congeladas de iptv-org (AR, CL, UY, ES, CO, IT, DE, MX) en `bench/lists/`.
- **Respuestas correctas:**
  - automáticas: canales cuyo `tvg-id` (sin `@SD`) existe en la guía;
  - de Luis: sus overrides (elegidos a mano), leídos del mapa y del reporte publicado;
  - revisadas a mano: muestra de asignaciones "Bien" y "Dudoso" por lista, en
    `bench/labels/<lista>.json` (`id` correcto, lista de ids aceptables o `null` = no hay
    guía correcta y cualquier asignación es un error).
- **Métricas por lista:** cobertura, aciertos / errores / sin asignar sobre lo etiquetado,
  precisión de "Bien" y de "Dudoso". Dos modos: con `tvg-id` (lo real) y solo por nombre.
  Un match cuenta como correcto si es el id esperado o el mismo canal en otra fuente (mismo
  nombre normalizado y país).
- La lógica de match de un canal se saca de `generate_for_profile` a una función propia, para
  que el banco use exactamente el mismo código.

### 2. Arreglos, uno por uno, midiendo cada uno contra el banco ✅ (salvo variantes regionales)
- Limpiar etiquetas de calidad y de estado del nombre.
- País: del `tvg-id`, y como último recurso el país dominante de la lista.
- `tvg-id` exacto (sin `@…`, sin distinguir mayúsculas) antes del match por nombre.
- Variantes regionales: probar el nombre sin el sufijo de ciudad/región si no hay match.
- Regiones de continente ("Latin America", "Latam", "Europe"…) como región, no como nombre;
  y el refuerzo por país no puede subir un match que solo comparte palabras genéricas.

### 3. Resultado
Tabla antes / después por lista, y decisión sobre la Etapa 1.

## Resultado (29/09/2026, primera ronda)

Banco: 8 listas de iptv-org (1.648 canales), 355 con respuesta conocida (automáticas por
`tvg-id` + 80 al azar revisadas a mano + los canales "Latin America"). Misma guía para todo.

| | Antes | Después |
|---|---|---|
| Cobertura (canales con guía) | 27 % | 37 % |
| Aciertos sobre las etiquetas automáticas (`tvg-id`) | 157 de 235 | 206 de 231 |
| Precisión de "Bien", muestra al azar revisada a mano | 78 % (25 de 32) | **88 %** (22 de 25) |
| Precisión de "Bien", todo el banco (355 etiquetas) | — | 99 % |
| "Latin America" → Playboy / TNT | 20+ canales | 0 |

La precisión sobre todo el banco está inflada por las etiquetas automáticas (casos fáciles);
la que cuenta para el criterio es la de la muestra al azar: **88 %, todavía debajo del 95 %**.
Los 3 errores que quedan: QVC de Italia → QVC de EE.UU. (no hay otro en la guía), "DSports" →
"DSports +" y "Telemundo Internacional" → la señal satelital de EE.UU. (en los dos últimos la
lista de iptv-org dice que el canal es de EE.UU. y el matcher le cree).

Arreglos hechos:
1. Etiquetas de resolución y entre corchetes fuera del nombre.
2. País del `tvg-id` como pista.
3. `tvg-id` resuelto contra la guía (sin `@SD`, sin mayúsculas) gana sobre un match dudoso.
4. "Latin America" / "Latinoamérica" / "Latam" = región (`country_groups` en
   `matching_rules.json`); un país concreto le gana ("AXN Latin America Mexico").
5. "Bien" exige que el nombre coincida (≥ 0,75 sin refuerzos): el país ayuda a elegir, pero
   un nombre a medias ("RTL 102.5 Disco" → "RTL 102.5") queda "Dudoso".
6. El sufijo de idioma se reconoce aunque haya calidad después ("TLC -EN ᵁᴴᴰ").
7. "+" es parte del nombre ("DSports" ≠ "DSports+").

Efecto en la lista de Luis (misma guía, sin overrides): cambian 27 elecciones, casi todas para
mejor ("Directv Sports" deja de ir a "DIRECTV Sports +", "PE | ATV" a "ATV +", "AMC -EN" a
"AMC+"); ~20 pasan de "Bien" a "Dudoso", varios de ellos errores que hoy no se veían ("ABC 8" →
ABC Chicago, "FOX 4" → Fox Deportes, "HBO Zone" → Showtime Familyzone).

**Pendiente / límites conocidos:**
- "Dudoso" acierta ~40 %: en un producto público conviene no asignarlo por defecto (dejarlo
  como sugerencia en "A revisar") o subir el umbral.
- Una guía sin país conocido (fuentes de EE.UU. sin sufijo) puede quedar "Bien" para un canal
  de otro país si no hay otra (QVC de Italia → QVC de EE.UU.).
- Variantes regionales ("Telefe Salta" → Telefe) y palabras compuestas ("RTL Zwei" vs
  "RTLZWEI") siguen sin resolverse.
- La cobertura real depende de las fuentes: muchos canales locales de estas listas no tienen
  guía en ninguna fuente activa (las sugerencias de "Fuentes de EPG" ayudan).
- Falta comparar la cobertura con IPTVEditor / m3u4u usando `prueba-argentina.m3u` (lo hace
  Luis, porque esos servicios piden cuenta).

## Segunda ronda (29/09/2026)

1. **Umbral de asignación configurable** (`min_assign_score` en `provider_rules.json`):
   medido por rango de puntaje, debajo de 0,7 acierta ~20 %, entre 0,7 y 0,8 ~72 % y desde 0,8
   ~98 %. Genérico: 0,7 (lo de abajo queda como sugerencia en "A revisar", sin asignar). Luis:
   0,45, como siempre.
2. **Nombre a medias** ("RTL 102.5 Disco" → "RTL 102.5"): el puntaje queda en 0,69, debajo del
   umbral genérico (para Luis sigue asignado como "Dudoso").
3. **Palabras pegadas o separadas** ("RTL Zwei" / "RTLZWEI", "TVAgro" / "Tv Agro", "ADN 40" /
   "ADN40"): la guía indexa también la variante pegada y el canal se prueba así si no quedó "Bien".
4. **"Latin America South/North/Panregional"** = región latinoamericana.
5. Guías sin país: no hizo falta; con las fuentes declarando su país (como en la corrida real)
   QVC de Italia ya no va a QVC de EE.UU.

| | Fin 1ª ronda | Fin 2ª ronda |
|---|---|---|
| Cobertura | 37 % | 24 % (se dejan de asignar los matches flojos) |
| Aciertos sobre lo etiquetado | 302 de 355 | 343 de 358 |
| Precisión de lo asignado, todo el banco | ~84 % | 99 % |
| Precisión de "Bien", muestra al azar a mano | 88 % | **91 %** (21 de 23) |
| Precisión de lo asignado, muestra al azar | ~66 % | **91 %** |

Los 2 errores que quedan en la muestra son ambiguos: la lista de iptv-org dice que el canal
es de EE.UU. ("DSports" → "DSports +", "Telemundo Internacional" → señal satelital de EE.UU.).

Lista de Luis (misma guía, id del proveedor incluido): 22 canales cambian, casi todos para
mejor; 8 que no tenían guía ahora la tienen (ADN 40, Cali TV, Tele Islas, NFL RedZone,
TeenNick, WeatherNation, La Tele, MotoGP) y se corrigen "Baby First" (iba a BBC First), "ESPN
U" (iba a Canal U), "Mega Tiempo" (iba a Nuevo Tiempo), "NOW 80s" (iba a NOW US).

**Siguiente:** diccionario de canales de iptv-org (`iptv-org/database`, dominio público, 31.404
canales con nombres alternativos, país y cadena) para nombres alternativos, variantes
regionales ("Telefe Salta" → Telefe) y el país de cada canal.
