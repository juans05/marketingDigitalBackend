# Vidalis.AI - Documentación Técnica y Estado del Proyecto
**Fecha:** 28 de Marzo, 2026
**Ubicación:** `/Backend`
**Objetivo:** Checkpoint técnico para auditoría por IA externa.

## 1. Arquitectura y Stack Tecnológico
- **Core:** Node.js + Express.
- **Base de Datos:** PostgreSQL (vía Supabase) con **Prisma ORM**.
- **Almacenamiento de Media:** Cloudinary (Integración con firmas seguras).
- **Procesamiento de IA:** Flujos de trabajo en **n8n** que procesan videos y devuelven scores/copys vía Webhooks.
- **Distribución Social:** Integración con **Ayrshare** y modo directo Meta Graph API.

## 2. Alcance del Backend
El backend de Vidalis gestiona el ciclo de vida completo de la creación de contenido AI:
1. **Gestión Multitenant:** Agencias que administran múltiples artistas.
2. **Pipeline de Video:** Recepción de archivos, subida a Cloudinary y disparo de análisis en n8n.
3. **Persistencia de Inteligencia:** Almacenamiento de Viral Scores, Hook Suggestions y Copys generados por IA.
4. **Programación y Despliegue:** Sistema de agendamiento para publicar contenido en TikTok, Instagram y YouTube.

## 3. Mapa de Endpoints (API `/api/vidalis`)

### Autenticación y Perfiles
- `POST /login`: Validación de credenciales.
- `POST /agencies`: Creación de nuevas agencias (Admin).
- `POST /artists`: Registro de artistas bajo una agencia.
- `GET /artists/:agencyId`: Listado de artistas por agencia.
- `DELETE /artists/:artistId`: Eliminación de perfiles.

### Gestión de Contenido (Videos)
- `POST /upload`: Procesa el video inicial y dispara el flujo de n8n.
- `GET /gallery/:artistId`: Obtiene el catálogo de videos y estados de IA de un artista.
- `PATCH /video/:videoId`: Actualización de metadatos (copys, hashtags) del video.
- `POST /publish-now/:videoId`: Dispara la publicación inmediata a las redes seleccionadas.
- `GET /clips/:parentId`: Recupera clips "hijos" generados de un video largo.

### Integración n8n (Webhooks)
- `POST/PATCH /n8n-callback/:videoId`: Endpoint crítico donde n8n inyecta los resultados del análisis de IA (Viral Score, Copys).

### Analítica y Social
- `GET /analytics/:videoId`: Recupera métricas de impacto tras 4h/24h de publicado.
- `GET /stats/:agencyId`: Concentrador de KPIs para el Dashboard (Seguidores, crecimiento).
- `GET /connect-social/:artistId`: Inicia flujo de conexión con redes sociales.
- `GET /social-status/:artistId`: Verifica qué redes están vinculadas.

## 4. Estado Actual de la Implementación
- **Side Drawer:** El backend soporta la actualización de copys y programación vía `PATCH /video/:videoId`.
- **Métricas:** El endpoint `/stats/:agencyId` ha sido optimizado para devolver datos de crecimiento diario.
- **Estabilidad:** Se han corregido errores de inconsistencia en la base de datos tras las refactorizaciones de diseño.

## 5. Variables de Entorno Requeridas (.env)
- `DATABASE_URL`: Conexión Prisma/Supabase.
- `CLOUDINARY_URL / CLOUDINARY_API_KEY`: Gestión de media.
- `AYRSHARE_API_KEY`: API de publicación.
- `N8N_WEBHOOK_URL`: Destino de los análisis de IA.
