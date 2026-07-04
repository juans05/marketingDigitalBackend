# Spy Mode v2 — Especificación de Funcionalidades

**Proyecto:** Vidalis Marketing Platform  
**Fecha:** 2026-07-02  
**Estado:** Pendiente de implementación

---

## Funcionalidad A — Análisis de Contenido Viral

### Descripción
Scrapear los últimos 10–20 posts del competidor por plataforma y usar IA para identificar qué patrones de contenido funcionan mejor (temas, hooks, formatos, duración).

### Flujo
1. Usuario hace clic en **"Analizar Contenido"** en la tarjeta del competidor
2. El microservice Python scrapea los últimos posts de cada plataforma
3. La IA (Groq/Claude) analiza los posts y extrae patrones
4. El backend guarda el análisis en Supabase (`competitor_content_analysis`)
5. El frontend muestra los resultados en tabla por columnas

### Vista de resultados — Tabla por columnas

| Métrica              | TikTok           | Instagram        | YouTube          |
|----------------------|------------------|------------------|------------------|
| Posts analizados     | 15               | 12               | 8                |
| Tema dominante       | Tutoriales IA    | Detrás de cámara | Reviews tools    |
| Formato top          | Reel vertical    | Carrusel         | Long-form 10min  |
| Duración promedio    | 45s              | —                | 12min            |
| Hora pico            | 7pm – 9pm        | 12pm – 2pm       | Sábado 10am      |
| Días de mayor eng.   | Lun, Mié, Vie    | Mar, Jue         | Sábado           |
| Hook más común       | "¿Sabías que...?"| Pregunta + CTA   | "En este video…" |
| Hashtags top         | #ia #programar   | #dev #codigo     | —                |
| Emoji más usado      | 🤖 💡            | 👨‍💻 🔥           | —                |

### Schema de BD — `competitor_content_analysis`
```sql
CREATE TABLE competitor_content_analysis (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competitor_id UUID REFERENCES competitors(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  analyzed_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  posts_count   INTEGER,
  top_topics    TEXT[],
  top_formats   TEXT[],
  peak_hours    TEXT[],
  peak_days     TEXT[],
  common_hooks  TEXT[],
  top_hashtags  TEXT[],
  avg_duration  TEXT,
  raw_posts     JSONB,
  ai_summary    TEXT
);
```

### Costo en Sparks
- **30 Sparks** por análisis de contenido (más costoso que análisis de perfil)

---

## Funcionalidad B — Seguimiento Histórico Semanal

### Descripción
Guardar automáticamente las métricas del competidor cada semana para construir una línea de tiempo y detectar tendencias de crecimiento o caída.

### Flujo
1. Un cron job corre cada lunes a las 6am (por artista con competidores activos)
2. Scrapea métricas básicas de cada competidor (seguidores, engagement)
3. Guarda snapshot en `competitor_snapshots`
4. El frontend muestra gráfica de evolución semanal

### Vista de resultados — Gráfica por columnas de plataforma

```
Evolución últimas 8 semanas — @midudev

         TikTok          Instagram       YouTube
         ──────────────  ──────────────  ──────────────
Seg. 8   320K            —               210K subs
Seg. 7   334K            —               225K subs
Seg. 6   341K            —               238K subs
Seg. 5   350K            —               251K subs
Seg. 4   355K            —               268K subs
Seg. 3   360K            —               279K subs
Seg. 2   365K            —               291K subs
Hoy      368K  (+15%)    —               305K (+45%)
```

- Variación mostrada como `+X%` respecto a la semana anterior
- Gráfica de línea con Chart.js en el frontend
- Alerta automática si el competidor crece >5% en una semana

### Schema de BD — `competitor_snapshots`
```sql
CREATE TABLE competitor_snapshots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competitor_id   UUID REFERENCES competitors(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  snapshot_date   DATE NOT NULL,
  followers       INTEGER DEFAULT 0,
  following       INTEGER DEFAULT 0,
  likes           INTEGER DEFAULT 0,
  videos          INTEGER DEFAULT 0,
  posts           INTEGER DEFAULT 0,
  engagement_rate DECIMAL(5,2) DEFAULT 0,
  UNIQUE (competitor_id, platform, snapshot_date)
);
```

### Costo en Sparks
- **Gratis** — es un proceso automático del sistema, no consume Sparks del usuario

---

## Funcionalidad C — "Roba Ideas" con IA

### Descripción
Tomar los posts más virales del competidor y que la IA genere ideas de contenido originales, adaptadas al estilo y audiencia del artista propio.

### Flujo
1. Usuario hace clic en **"Robar Ideas"** en la tarjeta del competidor
2. El sistema toma los top 5 posts virales del competidor (de `competitor_content_analysis`)
3. Obtiene el perfil del artista (género, audiencia, tono) de la tabla `artists`
4. La IA genera 5 ideas de contenido originales adaptadas
5. Las ideas se guardan en el Banco de Ideas existente (`idea_bank`)

### Vista de resultados — Ideas en columnas por plataforma

| #  | Idea de contenido                          | Para TikTok | Para Instagram | Para YouTube |
|----|--------------------------------------------|-------------|----------------|--------------|
| 1  | "Tutorial: crea tu primer agente de IA..." | ✓ 30s Reel  | ✓ Carrusel 6p  | ✓ 15min      |
| 2  | "Herramientas que uso cada día..."          | ✓ 45s Reel  | ✓ Post + CTA   | —            |
| 3  | "El error más común al aprender IA..."      | ✓ 60s Reel  | —              | ✓ 20min      |
| 4  | "Reacción a código de principiante..."      | ✓ 90s Reel  | —              | ✓ 25min      |
| 5  | "Detrás de cámara: cómo grabo mis videos"  | —           | ✓ Stories      | ✓ 10min      |

- Cada idea incluye: título sugerido, hook de apertura, CTA, plataformas recomendadas
- Un click envía la idea directamente al Banco de Ideas con estado `pending`
- El artista no copia — adapta con su propio estilo

### Prompt de IA (resumen)
```
Contexto del artista: {género, audiencia, tono, plataformas activas}
Top posts virales del competidor: {lista de posts con métricas}
Tarea: Genera 5 ideas de contenido originales que NO copien sino que adapten
       los temas que funcionan al estilo y audiencia del artista.
Output: JSON con array de ideas {title, hook, cta, platforms, format}
```

### Costo en Sparks
- **20 Sparks** por generación de ideas (requiere que exista un análisis previo de contenido)

---

## Resumen de Implementación

| Funcionalidad          | Costo Sparks | Almacenamiento              | Nuevo endpoint                        | Dependencias                    |
|------------------------|--------------|-----------------------------|---------------------------------------|---------------------------------|
| A — Análisis Contenido | 30 ⚡         | `competitor_content_analysis` | `POST /competitors/content/:id`      | Microservice Python (scrape posts) |
| B — Histórico Semanal  | Gratis       | `competitor_snapshots`        | `GET /competitors/history/:id`       | Cron job, scraper básico        |
| C — Roba Ideas         | 20 ⚡         | `idea_bank` (existente)       | `POST /competitors/steal-ideas/:id`  | Funcionalidad A completada      |

### Orden de implementación recomendado
1. **B primero** — No depende de nada nuevo, añade valor inmediato sin costo para el usuario
2. **A segundo** — Es el núcleo del análisis profundo, habilita la funcionalidad C
3. **C tercero** — Cierra el ciclo: ver competencia → entender qué funciona → crear contenido

### Tablas de BD a crear
```sql
-- Ejecutar en orden en Supabase SQL Editor
-- 1. competitor_snapshots (para funcionalidad B)
-- 2. competitor_content_analysis (para funcionalidad A)
-- (idea_bank ya existe para funcionalidad C)
```

### Estimación de esfuerzo
| Funcionalidad | Backend | Frontend | Microservice Python | Total |
|---------------|---------|----------|---------------------|-------|
| B — Histórico | 3h      | 2h       | 0h                  | ~5h   |
| A — Contenido | 4h      | 3h       | 3h                  | ~10h  |
| C — Ideas     | 2h      | 2h       | 0h                  | ~4h   |
| **Total**     | **9h**  | **7h**   | **3h**              | **~19h** |
