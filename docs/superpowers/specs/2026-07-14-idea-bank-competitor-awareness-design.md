---
title: IdeaBank consciente de la competencia — Design
date: 2026-07-14
author: Claude Code
status: approved-pending-implementation
---

# "Generar Ideas" debe conocer al artista y a su competencia

## Problema

`generateDailyIdeas` (`src/services/ideaBankService.js:23`) ya arma ideas personalizadas con el perfil de estilo del artista (tono, temas, formatos, patrones de hook — vía `artist_style_profile`, alimentado por `analyzeArtistStyle` sobre sus últimos 20 videos reales) y, desde el fix reciente, evita repetir hooks ya generados. Pero no sabe nada de la competencia — existe un sistema completo de Competitor Spy (`competitorController.js`/`competitorService.js`) que ya scrapea y analiza competidores, totalmente desconectado del flujo principal de "Generar Ideas".

## Alcance

Que `generateDailyIdeas` incluya, además de la señal propia del artista, lo que le está funcionando a su competencia (posts más virales: hooks, temas, formato) — sin agregar scraping nuevo ni cambiar el costo actual.

## Decisiones

- **Origen de datos**: se reusa el último análisis ya guardado por competidor (tabla `competitor_content_analysis`, columna `raw_posts`, una fila por `(competitor_id, platform)`, siempre la más reciente por el `upsert onConflict: 'competitor_id,platform'` que ya usa `analyzeCompetitorContent`). **No se scrapea en vivo** al generar ideas.
- **Qué competidores**: automático, todos los competidores del artista que ya tengan al menos una fila en `competitor_content_analysis` — sin selector manual.
- **Qué datos de cada uno**: solo los posts más virales (hook/tema/formato), no estadísticas de perfil (seguidores/engagement promedio) — mismo tipo de dato que ya usa `generateStealIdeas`.
- **Costo**: `generateDailyIdeas` sigue costando 5 Sparks — no hay scraping nuevo, no hay costo extra real que justifique subirlo.
- **Sin competidores analizados**: funciona exactamente igual que hoy (la sección de competencia del prompt queda con un texto de fallback), no bloquea ni sugiere nada — cambio no disruptivo para artistas que todavía no usan Competitor Spy.

## Diseño

**Nueva función** en `src/services/ideaBankService.js`: `getCompetitorTopPosts(artistId, limit = 8)`.

1. Trae todos los `competitors` del artista (`eq('artist_id', artistId)`).
2. Trae todas las filas de `competitor_content_analysis` para esos `competitor_id` (`in('competitor_id', [...])`).
3. Aplana `raw_posts` de todas las filas, calcula el mismo score que ya usa `generateStealIdeas` (`competitorService.js:598-607`: `likes + comments*1 + shares*1 + views/100` — reusar la misma fórmula tal cual, no inventar una nueva) y ordena descendente.
4. Devuelve los top `limit` posts across todos los competidores combinados (no por competidor individual, para no dejar que un solo competidor con muchos posts domine el prompt), con el nombre del competidor adjunto a cada uno.

**Prompt** (`generateDailyIdeas`, junto a las secciones existentes): nueva sección `LO QUE LE FUNCIONA A LA COMPETENCIA`, con formato `[Nombre competidor] "hook o tema del post" (plataforma, score de engagement)` por línea, y una regla nueva: *"Podés inspirarte en los patrones de la competencia, pero no copies literalmente — adaptalo al tono del creador."* Fallback cuando no hay datos: `"Sin datos de competencia disponibles"`.

**No se toca**: `generateStealIdeas`, `analyzeCompetitorContent`, el costo de ninguna acción de Competitor Spy, ni la tabla `competitor_content_analysis` (solo lectura).

## Testing

- Unit: `getCompetitorTopPosts` combina posts de varios competidores, ordena por score, respeta el límite, devuelve vacío si no hay análisis guardado.
- Unit: el prompt de `generateDailyIdeas` incluye la sección de competencia cuando hay datos, y el texto de fallback cuando no hay ninguno.
- Unit: el costo en Sparks de `generateIdeas` (controller) no cambia — sigue en 5.
