---
title: Gestión manual de suscripciones, Sparks recurrentes y panel admin — Design
date: 2026-07-13
author: Claude Code
status: approved-pending-implementation
---

# Gestión manual de suscripciones (sin Stripe), recarga mensual de Sparks y panel admin

## Problema

Vidalis no tiene forma de cobrar automáticamente (sin cuenta de Stripe todavía). El flujo real hoy es: el cliente paga por WhatsApp y el dueño edita `plan_type`/`sparks_balance` directo en la tabla de Supabase. Esto no escala y no hay:
- Registro de cuándo vence cada cliente pago, ni corte automático si no paga.
- Recarga mensual de Sparks (hoy los Sparks son un balance único que solo crece por compra/cupón, sin ciclo mensual).
- Ninguna pantalla para ver todos los clientes de un vistazo, ni para activarlos/suspenderlos sin tocar Supabase a mano.
- Selección de plan al registrarse (hoy todos arrancan en `'Mini'` por default de forma implícita).

## Alcance

Reemplaza el trabajo manual en Supabase por un panel admin + un job diario, usando el sistema de Sparks que ya existe (`agencies.sparks_balance`, `deductSparks()`, RPC `deduct_sparks`, `purchaseSparks`, `redeemCoupon`) — se extiende, no se reemplaza.

**Fuera de alcance explícito:** integración de pagos real (Stripe u otro proveedor) — se deja para una fase futura, separada. Este sistema es 100% de activación/gestión manual por el dueño de la plataforma.

## Modelo de datos

Nuevos campos en `agencies` (además de los existentes `plan_type`, `sparks_balance`):

| Campo | Tipo | Descripción |
|---|---|---|
| `payment_status` | text | `'active'` \| `'pending_payment'` \| `'grace_period'` \| `'suspended'` |
| `plan_expires_at` | timestamptz, nullable | Fecha de vencimiento. `NULL` para Mini (nunca vence). Se define siempre a `now() + 30 días` al activar/renovar un plan pago. |
| `next_sparks_recharge_at` | timestamptz | Próxima recarga mensual de Sparks. Aplica a **todos** los planes, incluido Mini. |
| `plan_sparks_balance` | numeric | Sparks del plan (60 Starter / 100 Mini / 300 Creator / 800 Pro / 2500 Agency). Se **resetea** (no se acumula) en cada recarga mensual. |
| `bonus_sparks_balance` | numeric | Bono de bienvenida (100, una sola vez) + compras + cargas manuales del admin. **Se acumula**, nunca se resetea automáticamente. |

`agencies.sparks_balance` (columna existente) pasa a ser una **columna generada** (`GENERATED ALWAYS AS (plan_sparks_balance + bonus_sparks_balance) STORED`, o mantenida por trigger si Supabase/Postgres lo requiere así) — todo el código que hoy lee `sparks_balance` sigue funcionando sin cambios; solo la lógica de deducción/recarga toca las dos columnas nuevas directamente.

### Estados de `payment_status`

- **`active`**: Mini siempre. Plan pago con `plan_expires_at` en el futuro. Acceso completo.
- **`pending_payment`**: se registró eligiendo un plan pago pero el admin todavía no confirmó el pago y activó la cuenta. Acceso bloqueado a todas las funciones (login sí funciona).
- **`grace_period`**: plan pago vencido, dentro de la ventana de 1 día de gracia. Acceso completo todavía (para que no se corte de golpe), pero se muestra aviso urgente.
- **`suspended`**: pasó el día de gracia sin renovar, o el admin lo dio de baja manualmente. Acceso bloqueado a todas las funciones (login sí funciona).

### Orden de deducción de Sparks

Al gastar Sparks en cualquier acción: **primero `bonus_sparks_balance`, y cuando eso llega a 0, recién ahí se empieza a descontar de `plan_sparks_balance`.** Esto reemplaza la lógica actual de `deductSparks()`/RPC `deduct_sparks`, que hoy solo restan de una columna única — se extiende a un descuento atómico en dos pasos sobre las dos columnas nuevas.

## País, moneda e instrucciones de pago

El país se detecta automáticamente por **geolocalización de IP** al momento del registro, usando `geoip-lite` (base de datos MaxMind GeoLite2 empaquetada localmente — sin llamadas a APIs externas, sin costo por request, sin dependencia de un servicio de terceros que pueda caerse). El backend lee la IP real del request (respetando `X-Forwarded-For` si hay proxy/load balancer delante, patrón ya usado en el proyecto para rate limiting — ver `app.js`) y resuelve el país con `geoip.lookup(ip)`.

El país detectado se **pre-carga en el formulario de registro como un campo editable** (no un dropdown en blanco) — si la IP no resuelve (red local, IP no encontrada en la base) o el usuario está con VPN y el país real es otro, puede corregirlo antes de confirmar el registro. Esto evita el caso de alguien de España registrándose desde una VPN de EE.UU. y quedando mal facturado sin poder corregirlo. Se guarda en `agencies.country`.

Si la detección por IP falla completamente (IP no resuelta) y el usuario no corrige el campo, cae al bucket `DEFAULT` de instrucciones de pago (ver abajo) — nunca bloquea el registro por no poder geolocalizar.

La moneda e instrucciones de pago **NO van hardcodeadas en el backend** — se editan desde el panel admin, sin deploy. Tabla nueva:

```sql
CREATE TABLE payment_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL UNIQUE, -- 'ES', 'PE', 'DEFAULT' (fallback para cualquier país sin regla propia)
  currency TEXT NOT NULL,            -- 'EUR', 'USD', etc.
  instructions TEXT NOT NULL,        -- texto libre: cuenta, alias, CCI, Yape/Plin, PayPal/Wise, lo que corresponda
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Precargada con 3 filas iniciales (`ES`, `PE`, `DEFAULT`) con texto placeholder — el admin las completa/edita desde el panel apenas esté implementado, no hace falta pasar los datos reales ahora.

**Endpoints nuevos** (mismo gate `account_type === 'admin'`):
- `GET /api/vidalis/admin/payment-instructions` — lista las 3 (o más) filas.
- `PUT /api/vidalis/admin/payment-instructions/:countryCode` — edita moneda/texto de una fila.

**Resolución para un país sin fila propia**: se usa la fila `DEFAULT`. `agencies.country` guarda el código de país tal cual (ISO 2 letras, ej. `'AR'`, `'MX'`); la búsqueda de instrucciones hace `payment_instructions` por `country_code = agencies.country`, y si no hay match, cae a `DEFAULT`.

El banner de `pending_payment`/`grace_period`/`suspended` muestra las instrucciones correspondientes al país guardado en la cuenta (resuelto como arriba).

**Panel admin — sección nueva**: "Instrucciones de pago", tabla editable con las filas por país (agregar/editar moneda + texto), además de la tabla de clientes ya descrita.

## Plan Starter (prueba gratis + precio promocional)

Tier nuevo por debajo de Mini: **3 videos/mes**, distribución a **2 redes sociales** (`instagram` + `tiktok`, mismo set que Mini — ver `PLAN_CONFIG` en `vidalisService.js`).

- **Precio y trial**: **15 días gratis** al elegir el plan. Si al día 15 sigue activo, se cobra USD 5 (cubre el resto del primer mes). Desde el segundo ciclo de facturación, USD 15/mes (renovación regular). Tres tramos de precio en total: gratis (15 días) → USD 5 (una vez) → USD 15/mes en adelante.
  - Esto requiere un estado adicional al modelo de `payment_status` de arriba: un plan con trial activo no es `active` (no pagó nada todavía) ni `pending_payment` (no bloquea funciones, el usuario ya tiene acceso completo durante el trial) — se necesita `trial_period` con `trial_ends_at = now() + 15 días`. El job diario (ver abajo) debe chequear `trial_period` igual que chequea vencimientos: si `trial_ends_at` ya pasó y no se registró el pago de USD 5, pasa a `pending_payment` (bloquea acceso hasta que el admin confirme el cobro).
  - `plan_expires_at` para Starter se fija a `trial_ends_at + 30 días` recién cuando se confirma el pago de los USD 5 (no al elegir el plan) — desde ahí sigue el ciclo normal de 30 días como cualquier otro plan pago.
- **Sparks del plan**: 60/mes. Cálculo: cada video sube con `registerVideo` (10 Sparks, incluye el procesamiento IA y la distribución a las plataformas activas) + un análisis de contenido `analyze_content` (10 Sparks) = 20 Sparks/video × 3 videos = 60 Sparks/mes. Los Sparks del plan se otorgan completos desde el día 1 del trial (no prorrateados), para que el usuario pueda probar la funcionalidad real durante los 15 días gratis.

## Precios y promoción de lanzamiento

No había precio base definido para Mini/Artista/Estrella/Agencia Pro en ningún repo — se usan los siguientes como **placeholder editable**, ajustar cuando haya precio real de negocio:

| Plan | Precio base | Promo lanzamiento (-10%) | Anual (11×, 1 mes gratis) |
|---|---|---|---|
| Starter | 15 días gratis → USD 5 (una vez) → USD 15/mes después | *(ya es promo, no se le aplica el -10% adicional)* | USD 165/año (15×11, ~USD 13.75/mes efectivo) |
| Mini | USD 19/mes | USD 17.10/mes | USD 188.10/año (17.10×11) |
| Artista (Creator) | USD 39/mes | USD 35.10/mes | USD 386.10/año |
| Estrella (Pro) | USD 79/mes | USD 71.10/mes | USD 782.10/año |
| Agencia Pro | USD 199/mes | USD 179.10/mes | USD 1,970.10/año |

El -10% de lanzamiento aplica solo a Mini/Artista/Estrella/Agencia Pro (Starter ya nace con precio promocional propio, no se acumulan los dos descuentos).

**Toggle mensual/anual**: selector estilo switch (no checkbox plano) en la página de precios, junto a cada plan o global arriba de las tarjetas. Anual = 11 meses de precio por 12 (1 mes gratis), se cobra el total anual de una vez. El switch debe mostrar el ahorro ("2 meses gratis" no aplica acá, es 1 mes — usar copy "1 mes gratis" o "-8% extra"). Ver mockup en `docs/pricing-toggle-mock.html`.

## Flujo de registro

El formulario de registro ahora pide elegir un plan (Mini/Creator/Pro/Agency) antes de crear la cuenta. El país llega pre-cargado por geolocalización de IP (ver sección anterior), editable por el usuario.

- **Elige Mini**: `plan_type='Mini'`, `payment_status='active'`, `plan_expires_at=NULL`, `plan_sparks_balance=100`, `bonus_sparks_balance=100` (bono de bienvenida), `next_sparks_recharge_at = now() + 30d`. Acceso inmediato completo.
- **Elige un plan pago**: `plan_type=<elegido>`, `payment_status='pending_payment'`, `plan_expires_at=NULL`, `plan_sparks_balance=0`, `bonus_sparks_balance=100` (el bono de bienvenida se otorga siempre, elija lo que elija — así puede ver un poco de valor mientras espera, pero no puede usar nada real porque el middleware de acceso bloquea por `payment_status`, no por balance), `next_sparks_recharge_at=NULL`. Sin acceso a funciones hasta que el admin lo active — queda visible en el panel admin como "pendiente de activación" para que el dueño sepa a quién facturarle.

## Job diario

Un archivo nuevo en `src/jobs/` (mismo patrón que `syncZernioAnalytics.js`/`dailyIdeas.js`), corrido una vez al día, que recorre todas las agencias y hace dos chequeos independientes por agencia:

1. **Vencimiento de plan pago**: si `plan_type` no es Mini, `payment_status === 'active'`, y `plan_expires_at` ya pasó → `payment_status = 'grace_period'`. Si ya estaba en `'grace_period'` y pasó 1 día más desde `plan_expires_at` → `payment_status = 'suspended'`.
2. **Recarga de Sparks**: si `next_sparks_recharge_at` ya pasó (para cualquier plan, incluido Mini) → `plan_sparks_balance` se resetea al monto de su plan actual, `next_sparks_recharge_at += 30 días`. Este chequeo corre **incluso si la cuenta está `suspended`** (así, si el cliente vuelve a pagar, ya tiene sus Sparks del mes listos en vez de esperar al próximo ciclo).

## Endpoints nuevos (todos gateados por `account_type === 'admin'`, reusando el rol que ya existe)

- `GET /api/vidalis/admin/agencies` — lista todas las agencias: nombre, email, `plan_type`, `payment_status`, `plan_expires_at`, `plan_sparks_balance`, `bonus_sparks_balance`. Búsqueda por nombre/email, filtro por `payment_status` (para ver rápido quién está `pending_payment`).
- `POST /api/vidalis/admin/agencies/:agencyId/activate-plan` — body `{ plan_type }`. Setea `plan_type`, `payment_status='active'`, `plan_expires_at = now()+30d` (`NULL` si `plan_type==='Mini'`), `plan_sparks_balance` al monto del plan, `next_sparks_recharge_at = now()+30d`. Es la acción que reemplaza tanto "activar cuenta nueva pendiente" como "renovar cuenta vencida" — mismo endpoint para los dos casos.
- `POST /api/vidalis/admin/agencies/:agencyId/suspend` — setea `payment_status='suspended'` manualmente, sin esperar al job.
- `POST /api/vidalis/admin/agencies/:agencyId/sparks` — body `{ amount }`. Suma a `bonus_sparks_balance` (cargas manuales fuera de ciclo, no toca `plan_sparks_balance`).

## Enforcement de acceso

Middleware nuevo `requireActivePlan` (junto a `authenticateToken`/`authorizeAgency`/`authorizeArtist` en `authMiddleware.js`), aplicado a las rutas que consumen Sparks o son funciones pagas (no a `login`/`getMe`/`refine-copy` de perfil/`config`) — bloquea con `402 Payment Required` y un código de error claro (`ACCOUNT_PENDING_PAYMENT` / `ACCOUNT_SUSPENDED`) cuando `payment_status` es `'pending_payment'` o `'suspended'`. `'active'` y `'grace_period'` pasan sin restricción.

## Frontend

- **Selector de plan en el registro**: las 5 opciones (Starter/Mini/Creator/Pro/Agency), mismo copy que la página de precios.
- **Banner de aviso**: en el dashboard, si `payment_status !== 'active'`, se muestra un banner:
  - `pending_payment`: "Elegiste el plan X — completá el pago para activarlo" + las instrucciones de pago resueltas por país (`payment_instructions`, con fallback a `DEFAULT`).
  - `grace_period`: "Tu plan vence hoy/mañana, renovalo para no perder acceso" + mismas instrucciones de pago.
  - `suspended`: "Tu cuenta está suspendida por falta de pago" + mismas instrucciones de pago.
  - Texto siempre renderizado como texto plano de React (nunca `dangerouslySetInnerHTML`), incluido el campo `instructions` editable por el admin — sin riesgo de inyección aunque ese campo sea texto libre.
- **Panel admin**: pantalla nueva, solo accesible con `account_type==='admin'`, con dos secciones: la tabla de clientes (con las 3 acciones: activar/renovar, suspender, cargar Sparks) y la tabla editable de instrucciones de pago por país.

## Testing

- Unit: deducción de Sparks en el orden correcto (bono/comprado primero, plan después), incluyendo el caso borde de gastar más de lo que hay en `bonus_sparks_balance` y que continúe descontando de `plan_sparks_balance` en la misma operación atómica.
- Unit: el job diario — vencimiento → grace → suspended en los pasos correctos, recarga mensual resetea (no acumula) `plan_sparks_balance`, corre incluso si la cuenta está suspendida.
- Integration: `activate-plan` cubre tanto "activar pendiente" como "renovar vencido" con el mismo resultado final.
- Integration: middleware `requireActivePlan` bloquea correctamente en `pending_payment`/`suspended` y deja pasar en `active`/`grace_period`.
- Unit: resolución de instrucciones de pago — país con fila propia usa esa fila, país sin fila cae a `DEFAULT`.
- Unit: geolocalización de IP — IP válida resuelve el país correcto, IP no resoluble (o loopback/local) cae a `null`/sin pre-carga sin romper el registro, respeta `X-Forwarded-For` cuando está presente.
