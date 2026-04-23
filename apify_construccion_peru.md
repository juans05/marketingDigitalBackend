# Proyecto: Mapa de Oportunidades Inmobiliarias — Perú
> Plataforma de inteligencia inmobiliaria usando Apify + scraping de fuentes públicas peruanas

---

## Concepto

Plataforma SaaS que consolida en un mapa interactivo los terrenos e inmuebles en subasta, remate judicial, venta del Estado y precio de mercado libre en Perú, permitiendo a inversores y constructoras identificar oportunidades antes que su competencia.

---

## Modelo de Negocio

### Planes sugeridos
| Plan | Precio/mes | Incluye |
|------|-----------|---------|
| Básico | S/. 150 | Alertas + búsqueda en mapa |
| Pro | S/. 350 | Historial + análisis de competidores + score de oportunidad |
| Empresa | S/. 800 | API access + múltiples usuarios |

### Proyección conservadora
| Clientes | Plan promedio | Mensual |
|----------|--------------|---------|
| 20 | S/. 150 | S/. 3,000 |
| 50 | S/. 150 | S/. 7,500 |
| 20 | S/. 350 | S/. 7,000 |

Con 50–70 clientes mixtos: **S/. 10,000–15,000/mes** con costos operativos bajos.

### Ruta de lanzamiento
```
Semana 1-2   → Reportes bajo demanda (validar que alguien paga)
Mes 1-2      → SaaS básico de alertas SAT + REMAJU (MVP)
Mes 3-6      → Agregar precios Urbania + dashboard + mapa
Mes 6+       → Escalar con API para integraciones B2B
```

---

## Fuentes de Datos Verificadas

### 1. SAT Lima — Remates por Deuda Tributaria
- **URL:** https://www.sat.gob.pe/websitev8/modulos/remates/RematesInmuebles.asp
- **Estado:** SCRAPING VIABLE ✅
- **Sin login requerido**
- **Datos disponibles:**
  - Dirección del inmueble
  - Tipo: departamento / local / stand / oficina
  - Precio base de remate (soles)
  - Fecha y hora del remate
  - Expediente de cobranza
  - Distrito / zona
  - Foto del inmueble (cuando disponible)
- **Cobertura:** Solo Lima Metropolitana
- **Frecuencia:** Publicaciones periódicas (múltiples al año)

---

### 2. REMAJU — Poder Judicial (Remates Judiciales)
- **URL:** https://remaju.pj.gob.pe/remaju/
- **Estado:** SCRAPING VIABLE ✅
- **Sin login requerido**
- **Datos disponibles:**
  - Dirección del inmueble
  - Precio base (valorización judicial)
  - Número de expediente judicial
  - Juzgado a cargo
  - Fecha del remate (proceso de 24 horas online)
  - Descripción del bien (área, características)
  - Estado del proceso
- **Cobertura:** Nacional (todo Perú)
- **Característica:** Subastas 100% virtuales, corren 24 horas

---

### 3. SBN — Superintendencia Nacional de Bienes Estatales
- **URL subastas:** https://web.sbn.gob.pe/subastas
- **URL datos abiertos:** https://www.datosabiertos.gob.pe/group/superintendencia-nacional-de-bienes-estatales-sbn
- **URL visor geográfico (PPE):** https://catastro.sbn.gob.pe/scl/
- **Estado:** SCRAPING VIABLE ✅ (además tiene datos abiertos)
- **Datos disponibles:**
  - Dirección y ubicación
  - Área en m²
  - Tipo de bien (terreno / edificio / predio)
  - Precio de venta o base de subasta
  - Coordenadas geográficas (visor PPE las tiene)
  - Código de predio
  - Región / provincia / distrito
- **Ventaja:** Es información 100% pública del Estado, sin restricciones legales

---

### 4. Urbania / Adondevivir — Mercado Libre (Precios de Referencia)
- **URL:** https://urbania.pe / https://adondevivir.com
- **URL índice histórico:** https://urbania.pe/indice_m2/
- **Estado:** SCRAPING POSIBLE con limitaciones ⚠️
- **Datos disponibles:**
  - Precio actual de publicación
  - Precio histórico (historial desde abril 2017, actualizado mensualmente)
  - Área en m²
  - Precio por m²
  - Días en publicación
  - Distrito y coordenadas aproximadas
  - Descripción del vendedor
  - Fotos
  - Contacto del anunciante
- **Limitaciones:**
  - No tienen API oficial → scraping directo
  - Pueden bloquear IPs con alto volumen → usar proxies rotantes
  - TOS posiblemente lo restringe (riesgo legal bajo pero existe)
- **Volumen:** 6,958+ terrenos listados en Perú, 4,883 solo en Lima

---

### 5. SUNARP — Propietario del Predio
- **URL:** https://www2.sunarp.gob.pe/consulta-propiedad/
- **Estado:** NO AUTOMATIZABLE MASIVAMENTE ❌
- **Restricciones:**
  - CAPTCHA activo en formulario
  - Límite de 5 consultas por día por usuario
  - No tiene API pública
- **Alternativa viable:** Mostrar botón "Ver en SUNARP" con link directo a la partida registral para que el usuario consulte manualmente
- **Alternativa avanzada:** Convenio institucional con SUNARP (existe para municipalidades — requiere trámite formal)

---

## Datos que se Pueden Presentar en el Mapa

### Por cada inmueble / terreno
| Campo | Fuente | Disponible |
|-------|--------|-----------|
| Dirección | SAT / REMAJU / SBN / Urbania | ✅ |
| Distrito / región | Todas | ✅ |
| Coordenadas lat/lng | SBN directo, resto via geocoding | ✅ |
| Precio base o de oferta | Todas | ✅ |
| Precio por m² | Urbania / calculado | ✅ |
| Área en m² | Todas | ✅ |
| Tipo de inmueble | Todas | ✅ |
| Estado (remate / subasta / venta libre) | Todas | ✅ |
| Fecha del remate | SAT / REMAJU | ✅ |
| Expediente / referencia | SAT / REMAJU / SBN | ✅ |
| Variación de precio | Urbania (historial) | ✅ |
| Días en publicación | Urbania | ✅ |
| Nombre del propietario | SUNARP | ❌ masivo |

---

## Métricas Derivadas (Valor Diferencial)

Calculadas cruzando fuentes, no disponibles en ningún portal actual:

```
📉 % de descuento vs precio de mercado
   → Precio remate SAT vs precio Urbania en ese distrito

⏱️ Días en publicación
   → Terrenos +90 días = señal de vendedor urgido

📊 Precio/m² por distrito
   → Mapa de calor de precios en Lima

🔴 Score de oportunidad (0-100)
   → Combinación: precio bajo + remate judicial + días en mercado + descuento
```

---

## Ejemplo de Ficha en el Mapa

Al hacer clic en un pin:

```
┌──────────────────────────────────────────┐
│ 📍 Jr. Los Pinos 145, Breña, Lima        │
│                                          │
│ FUENTE: SAT Lima — Remate Tributario     │
│ Fecha remate: 15 Mayo 2026               │
│                                          │
│ Precio base remate:    S/. 180,000       │
│ Precio mercado zona:   S/. 260,000       │
│ Descuento estimado:    🔴 -31%           │
│                                          │
│ Área: 120 m²                             │
│ Precio/m²: S/. 1,500                    │
│ Expediente: SAT-2024-003821              │
│                                          │
│ [Ver publicación oficial] [Ver en SUNARP]│
└──────────────────────────────────────────┘
```

### Colores de pines por categoría
```
🔴 Remate judicial (REMAJU)
🟠 Remate tributario (SAT Lima)
🔵 Subasta Estado (SBN)
🟡 Precio bajando en mercado libre (Urbania)
🟢 Terreno del Estado disponible (SBN)
```

---

## Stack Técnico Recomendado

```
Apify Actors (scrapers)
    ↓
Webhook POST
    ↓
Backend Node.js + PostgreSQL (Railway o similar)
    ↓
Google Maps Geocoding API (dirección → lat/lng)
    ↓
API REST
    ↓
Frontend Next.js + Mapbox GL o Leaflet
    ↓
Sistema de alertas (email / WhatsApp)
```

### Tabla principal en BD
```sql
CREATE TABLE predios (
  id            SERIAL PRIMARY KEY,
  fuente        VARCHAR(20),   -- 'SAT' | 'REMAJU' | 'SBN' | 'URBANIA'
  estado        VARCHAR(30),   -- 'remate' | 'subasta' | 'venta_libre'
  direccion     TEXT,
  distrito      VARCHAR(100),
  lat           DECIMAL(9,6),
  lng           DECIMAL(9,6),
  area_m2       DECIMAL(10,2),
  precio        DECIMAL(14,2),
  precio_m2     DECIMAL(10,2),
  precio_mercado DECIMAL(14,2),
  descuento_pct DECIMAL(5,2),
  fecha_remate  DATE,
  expediente    VARCHAR(100),
  url_fuente    TEXT,
  dias_publicado INTEGER,
  score_oportunidad INTEGER,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

---

## Actores de Apify a Desarrollar

| Actor | Fuente | Frecuencia sugerida |
|-------|--------|-------------------|
| `sat-lima-remates` | sat.gob.pe | Diaria |
| `remaju-poder-judicial` | remaju.pj.gob.pe | Diaria |
| `sbn-subastas` | web.sbn.gob.pe/subastas | 2x semana |
| `urbania-terrenos` | urbania.pe | Diaria |
| `adondevivir-terrenos` | adondevivir.com | Diaria |

---

## Lo que NO es Posible (por ahora)

```
❌ Nombre del propietario masivo (SUNARP bloqueado)
❌ Historial de compraventas
❌ Si tiene hipoteca o embargo (requiere SUNARP)
❌ Precio de transacción real (solo precio de oferta)
```

---

## Clientes Objetivo

- Constructoras medianas buscando terrenos para proyectos
- Inversores inmobiliarios independientes
- Consultoras de ingeniería y arquitectura
- Empresas proveedoras de materiales que prospectan proyectos
- Estudios de abogados especializados en contrataciones

---

## Fuentes de Referencia

- [SAT Lima — Remates](https://www.sat.gob.pe/websitev8/modulos/remates/RematesInmuebles.asp)
- [REMAJU — Poder Judicial](https://remaju.pj.gob.pe/remaju/)
- [SBN — Subastas](https://web.sbn.gob.pe/subastas)
- [SBN — Datos Abiertos](https://www.datosabiertos.gob.pe/group/superintendencia-nacional-de-bienes-estatales-sbn)
- [SBN — Visor PPE](https://catastro.sbn.gob.pe/scl/)
- [Urbania — Índice M2](https://urbania.pe/indice_m2/)
- [SUNARP — Consulta Propiedad](https://www2.sunarp.gob.pe/consulta-propiedad/)
