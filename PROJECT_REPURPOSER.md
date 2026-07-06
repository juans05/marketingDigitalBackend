# Proyecto: Vidalis + Repurposer Platform

**Versión:** 1.0  
**Fecha:** 2026-07-05  
**Estado:** Planificación

---

## 📋 Resumen Ejecutivo

Crear **dos plataformas SaaS independientes** con dominios separados que comparten un **backend API común**:

1. **vidalis.com** - Gestión completa de marketing digital en redes sociales (para agencias y teams)
2. **repurposer.com** - Conversión automática de videos largos en clips virales cortos (para content creators)

**Arquitectura:** 
- **Frontends:** Dos aplicaciones React completamente independientes, desplegadas en dominios diferentes
- **Backend:** Un único servidor API que ambas frontends consultan
- **Usuarios:** Pueden tener cuenta en una, otra, o ambas plataformas

**Objetivo:** Capturar dos segmentos de mercado distintos (agencias + content creators) con un backend escalable y reutilizable.

---

## 🎯 Descripción de Productos

### **Vidalis** (Producto Existente - Enhancement)
- **Target:** Agencias, gestores de redes sociales, equipos de marketing
- **Funcionalidad:**
  - Dashboard centralizado para múltiples redes
  - Creación manual de contenido
  - Calendario de publicación
  - Analytics e insights
  - Gestión de cuentas sociales
  - Integración con Repurposer (nuevo)

### **Repurposer** (Producto Nuevo)
- **Target:** Podcasters, content creators, conferenciantes, streamers
- **Funcionalidad:**
  - Upload de videos largos (30min - 2h)
  - Análisis automático con IA (Claude) para detectar los mejores capítulos/segmentos del video
  - Generación de 3-10 clips virales a partir de esos segmentos
  - Score de cada clip usando los endpoints de Vidalis (viral-score / visual-score)
  - Ranking: identificar y destacar cuál clip tiene el mejor score (recomendado)
  - Optimización automática por red social
  - Subtítulos automáticos
  - Publicación automática
  - Analytics de performance por clip
  - Preview antes de publicar

---

## 🏗️ Arquitectura Técnica

### **Stack General**
```
Frontend:     React/Next.js + TailwindCSS
Backend:      Node.js/Express o Python/FastAPI
Database:     PostgreSQL
Queue:        Bull (Redis) o RabbitMQ
Storage:      AWS S3
Video Proc:   FFmpeg (Docker container)
AI:           Claude API (Anthropic)
Auth:         JWT + OAuth2
Deployment:   Docker + Kubernetes (opcional)
```

### **Servicios del Backend Compartido**

```
/core
├── /auth
│   ├── User registration/login
│   ├── OAuth social media
│   └── JWT token management
│
├── /videos
│   ├── Upload handler
│   ├── Storage management
│   ├── Metadata extraction
│   └── Streaming URLs
│
├── /content
│   ├── Content creation
│   ├── Content management
│   ├── Versioning
│   └── Templates
│
├── /social-apis
│   ├── TikTok API integration
│   ├── Instagram Graph API
│   ├── YouTube Data API
│   ├── Twitter/X API
│   ├── Credential management
│   └── Rate limiting
│
├── /publishing
│   ├── Publishing queue
│   ├── Scheduling
│   ├── Retry logic
│   └── Status tracking
│
└── /analytics
    ├── Metrics aggregation
    ├── Performance tracking
    ├── A/B testing data
    └── Reporting

/services
├── /ai-analysis
│   ├── Video understanding (nuevo, para segment detection)
│   ├── Segment detection (nuevo)
│   ├── Viral score calculation → REUTILIZA endpoints existentes de Vidalis
│   │   (POST /vidalis/viral-score → analyzeViralPotential, y
│   │    POST /vidalis/visual-score → scoreVisualVirality en aiService.js)
│   │   No se construye un scorer nuevo; cada clip generado se scorea
│   │   llamando a estos endpoints ya en producción.
│   └── Prompt engineering (solo para segment detection, no para score)
│
├── /video-processing
│   ├── FFmpeg wrapper
│   ├── Clip extraction
│   ├── Format conversion
│   ├── Watermarking
│   ├── Subtitle burn-in
│   └── Quality optimization
│
└── /queue
    ├── Job processing
    ├── Worker management
    ├── Error handling
    └── Monitoring
```

### **Diagrama de Flujo**

```
┌──────────────────────────────────────────────────────────────────────┐
│                   BACKEND COMPARTIDO (Core API)                      │
│     - Auth | Videos | Content | Social APIs | Queue | Analytics     │
└────────────────────────┬──────────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    ┌────▼────────────┐  │  ┌────────────▼─────────┐
    │  vidalis.com    │  │  │  repurposer.com      │
    │  (React App)    │  │  │  (React App)         │
    │                 │  │  │                      │
    │ • Dashboard     │  │  │ • Upload             │
    │ • Calendario    │  │  │ • AI Analysis        │
    │ • Scheduling    │  │  │ • Clip Gallery       │
    │ • Analytics     │  │  │ • Platform Selector  │
    │ • Settings      │  │  │ • Publishing         │
    │ • Team Mgmt     │  │  │ • Performance        │
    └────────────────┘  │  └─────────────────────┘
                        │
            Mismo Backend API (shared)
            Token JWT incluye 'product' scope
```

**Arquitectura Clave:**
- **Dos frontends en dominios separados** → `vidalis.com` y `repurposer.com`
- **Dos repositorios de código diferentes** (codebase React independiente cada uno)
- **Un solo backend API** (mismo servidor, mismo dominio API)
- **Logins separados** (usuarios pueden tener cuenta en uno, otro, o ambos)
- **Base de datos unificada** (usuarios, videos, clips, credenciales sociales)

---

## 📊 Modelos de Datos Clave

### **User**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "string",
  "plan": "free|pro|enterprise",
  "subscription": {
    "status": "active|trial|cancelled",
    "startDate": "date",
    "renewalDate": "date"
  },
  "socialAccounts": ["array"],
  "createdAt": "timestamp",
  "updatedAt": "timestamp"
}
```

### **Video**
```json
{
  "id": "uuid",
  "userId": "uuid",
  "originalFile": "s3://bucket/...",
  "title": "string",
  "description": "string",
  "duration": "seconds",
  "status": "uploaded|processing|ready|failed",
  "metadata": {
    "resolution": "1080p",
    "fps": 30,
    "codec": "h264"
  },
  "createdAt": "timestamp"
}
```

### **Clip**
```json
{
  "id": "uuid",
  "videoId": "uuid",
  "startTime": "seconds",
  "endTime": "seconds",
  "duration": "seconds",
  "viralScore": 0-100,
  "platforms": ["tiktok", "instagram", "youtube"],
  "status": "generated|published|scheduled",
  "publishedUrls": {
    "tiktok": "url",
    "instagram": "url"
  },
  "metrics": {
    "views": 0,
    "likes": 0,
    "shares": 0
  }
}
```

### **PublishingJob**
```json
{
  "id": "uuid",
  "contentId": "uuid",
  "platforms": ["array"],
  "scheduledTime": "timestamp",
  "status": "pending|processing|published|failed",
  "results": [
    {
      "platform": "tiktok",
      "status": "published",
      "url": "https://...",
      "timestamp": "timestamp"
    }
  ]
}
```

---

## 🚀 Roadmap de Implementación

### **Fase 1: MVP Backend (Semanas 1-4)**

**Sprint 1.1 - Setup & Auth (Semana 1)**
- [ ] Infraestructura base (Docker, DB, Redis)
- [ ] Auth system (JWT, OAuth)
- [ ] User management
- [ ] Social media credential storage

**Sprint 1.2 - Video Pipeline (Semana 2)**
- [ ] S3 integration
- [ ] Video upload handler
- [ ] Metadata extraction
- [ ] FFmpeg wrapper

**Sprint 1.3 - AI Integration (Semana 3)**
- [ ] Claude API integration (solo para segment detection, no para score)
- [ ] Video analysis pipeline
- [ ] Segment detection
- [ ] Integrar cálculo de viral score llamando a los endpoints existentes de Vidalis (`/vidalis/viral-score`, `/vidalis/visual-score`) — no reimplementar el scoring

**Sprint 1.4 - Social APIs (Semana 4)**
- [ ] TikTok API setup
- [ ] Instagram Graph API
- [ ] YouTube Data API
- [ ] Rate limiting & queuing

### **Fase 2: Repurposer Frontend (Semanas 5-7)**

**Sprint 2.1 - Core UI (Semana 5)**
- [ ] Upload component
- [ ] Progress tracking
- [ ] Video preview
- [ ] Clip gallery

**Sprint 2.2 - AI Features (Semana 6)**
- [ ] Analysis display
- [ ] Viral score visualization
- [ ] Clip preview player
- [ ] Platform selector

**Sprint 2.3 - Publishing (Semana 7)**
- [ ] Publish workflow
- [ ] Scheduling UI
- [ ] Confirmation & review
- [ ] Success messaging

### **Fase 3: Cross-Product Features (Semanas 8-9)**

**Sprint 3.1 - Unified Analytics**
- [ ] Backend: Aggregated metrics endpoint
- [ ] Dashboard que muestre clips de Repurposer
- [ ] Cross-platform reporting

**Sprint 3.2 - Marketing & Onboarding**
- [ ] Links cruzados (Vidalis → Repurposer, vice versa)
- [ ] Unified auth (mismo usuario en ambas apps)
- [ ] Dashboard mostrando stats de ambos productos

### **Fase 4: Launch & Optimization (Semana 10+)**

**Sprint 4.1 - Testing & QA**
- [ ] End-to-end testing
- [ ] Performance optimization
- [ ] Security audit
- [ ] Load testing

**Sprint 4.2 - Launch**
- [ ] Beta program
- [ ] Production deployment
- [ ] Monitoring setup
- [ ] Documentation

---

## 📋 Requerimientos Funcionales

### **Vidalis (Enhancement)**

**RF-V1:** Dashboard unificado
- Ver todas las redes en una pantalla
- KPIs en tiempo real
- Calendario visual

**RF-V2:** Gestor de contenido
- CRUD de contenido
- Plantillas reutilizables
- Programación de publicaciones

**RF-V3:** Extensibilidad
- API abierta para integraciones futuras
- Cross-product analytics (ver clips de Repurposer en dashboard)
- Link a Repurposer en documentación

**RF-V4:** Analytics avanzado
- Métricas por red
- Comparativas de performance
- Reportes exportables

### **Repurposer**

**RF-R1:** Upload & Analysis
- Drag & drop upload
- Validación de formato
- Análisis automático con Claude para detectar los mejores capítulos/segmentos del video (segment detection)
- Progress feedback en tiempo real

**RF-R2:** Clip Generation & Scoring
- Generar un clip por cada segmento/capítulo detectado
- Viral score por clip (vía endpoints existentes de Vidalis, no un scorer nuevo)
- Ranking de clips por score y destacar cuál es el mejor (recomendado para publicar)
- Vista previa interactiva
- Editar clips (trim, texto, efectos)

**RF-R3:** Platform Optimization
- Formato automático por red
- Subtítulos auto-generated
- Watermark customizable
- Aspect ratio conversion

**RF-R4:** Publishing
- Seleccionar plataformas
- Scheduling
- Guardar como borrador
- Publicar inmediatamente

**RF-R5:** Analytics Dashboard
- Views, likes, shares por clip
- Best performing clips
- Audience demographics
- Trend analysis

---

## 🔧 Requerimientos Técnicos

**RT-1: Performance**
- Video upload: < 5s para 100MB
- AI analysis: < 2min para video de 1h
- Clip generation: < 30s por clip
- API response time: < 200ms

**RT-2: Scalability**
- Soportar 10K+ usuarios concurrentes
- Procesar 100+ videos/día
- Handle 1000+ clip generations/día
- Multi-region deployment ready

**RT-3: Seguridad**
- OAuth2 para social media
- Encrypted social credentials
- Rate limiting por user/API
- GDPR compliant
- No público sin autenticación

**RT-4: Reliability**
- 99.9% uptime SLA
- Automatic retry en fallos
- Dead letter queue para fallos
- Monitoring & alerting
- Disaster recovery plan

**RT-5: Compatibility**
- Soportar videos hasta 4K
- Múltiples formatos (MP4, MOV, WebM)
- Múltiples codecs (H264, H265, VP9)

---

## 💰 Modelo de Precios

### **Vidalis Pricing**
```
Free:        $0/mes
  - 1 cuenta social
  - 10 posts/mes
  - Analytics básico

Pro:         $29/mes
  - 5 cuentas
  - 100 posts/mes
  - Analytics avanzado
  - Calendarios compartidos
  - + Repurposer (1 video/mes)

Enterprise:  $99/mes
  - Unlimited cuentas
  - Unlimited posts
  - White label
  - + Repurposer ilimitado
  - Soporte prioritario
```

### **Repurposer Pricing**
```
Free:        $0/mes
  - 1 video/mes
  - Máx 5 clips
  - Max 10 min video

Starter:     $19/mes
  - 5 videos/mes
  - Máx 10 clips por video
  - Max 30 min video
  - 3 plataformas

Pro:         $49/mes
  - 20 videos/mes
  - Ilimitado clips
  - Max 2h video
  - Todas las plataformas
  - Advanced analytics

Team:        $99/mes
  - 50 videos/mes
  - 5 usuarios
  - Custom branding
  - Priority processing
```

---

## 👥 Equipo Necesario

```
Backend (2-3 devs)
├── 1x Tech Lead (Node.js/Python)
├── 1x Video Processing Specialist
└── 1x DevOps/Infrastructure

Frontend (2 devs)
├── 1x React Senior
└── 1x UI/UX Engineer

AI/ML (1 dev)
└── 1x Claude Integration Specialist

Product/Design (1-2)
├── 1x Product Manager
└── 1x Product Designer

DevOps (1 dev)
└── 1x Infrastructure/Monitoring
```

---

## 📈 Métricas de Éxito

**Técnicas:**
- Uptime: > 99.9%
- Video processing time: < 2min para 1h video
- API latency: p95 < 200ms
- Deploy frequency: 1-2x per week

**Producto:**
- MVP launched en 10 semanas
- Beta users: 100+ en semana 10
- Retention rate: > 60% after 30 days

**Negocio:**
- 1K+ users en 3 meses (post-launch)
- $10K+ MRR en 6 meses
- 80%+ NPS score
- < 5% churn rate

---

## 🔐 Consideraciones Críticas

**Derechos de Autor:**
- Watermark automático en clips
- Metadata de atribución
- User accepts terms antes de publicar

**Compliance:**
- GDPR ready
- Datos de usuario encriptados
- Social media credentials seguros
- Privacy policy clara

**Performance:**
- Video processing en background
- Caché agresivo de clips
- CDN para video delivery
- Database indexes optimizados

**Monetización:**
- Free tier para adquisición
- Clear upgrade path
- Usage-based billing option
- Enterprise contracts

---

## 📚 Documentación Necesaria

- [ ] API documentation (Swagger/OpenAPI)
- [ ] Architecture decision records (ADRs)
- [ ] Database schema documentation
- [ ] Deployment runbooks
- [ ] Monitoring & alerting setup
- [ ] User onboarding guides
- [ ] Admin documentation

---

## 🎬 Próximos Pasos

1. **Aprobación de arquitectura** - Review con equipo técnico
2. **Diseño de UI/UX** - Usar Stitch para prototipos
3. **Setup de infraestructura** - Proveedores (AWS, etc)
4. **Sprint planning** - Detallar Sprint 1.1
5. **Asignación de recursos** - Confirmar equipo

---

**Documento creado:** 2026-07-05  
**Próxima revisión:** 2026-07-15
