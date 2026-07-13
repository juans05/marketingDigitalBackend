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
| `plan_sparks_balance` | numeric | Sparks del plan (100 Mini / 300 Creator / 800 Pro / 2500 Agency). Se **resetea** (no se acumula) en cada recarga mensual. |
| `bonus_sparks_balance` | numeric | Bono de bienvenida (100, una sola vez) + compras + cargas manuales del admin. **Se acumula**, nunca se resetea automáticamente. |

`agencies.sparks_balance` (columna existente) pasa a ser una **columna generada** (`GENERATED ALWAYS AS (plan_sparks_balance + bonus_sparks_balance) STORED`, o mantenida por trigger si Supabase/Postgres lo requiere así) — todo el código que hoy lee `sparks_balance` sigue funcionando sin cambios; solo la lógica de deducción/recarga toca las dos columnas nuevas directamente.

### Estados de `payment_status`

- **`active`**: Mini siempre. Plan pago con `plan_expires_at` en el futuro. Acceso completo.
- **`pending_payment`**: se registró eligiendo un plan pago pero el admin todavía no confirmó el pago y activó la cuenta. Acceso bloqueado a todas las funciones (login sí funciona).
- **`grace_period`**: plan pago vencido, dentro de la ventana de 1 día de gracia. Acceso completo todavía (para que no se corte de golpe), pero se muestra aviso urgente.
- **`suspended`**: pasó el día de gracia sin renovar, o el admin lo dio de baja manualmente. Acceso bloqueado a todas las funciones (login sí funciona).

### Orden de deducción de Sparks

Al gastar Sparks en cualquier acción: **primero `bonus_sparks_balance`, y cuando eso llega a 0, recién ahí se empieza a descontar de `plan_sparks_balance`.** Esto reemplaza la lógica actual de `deductSparks()`/RPC `deduct_sparks`, que hoy solo restan de una columna única — se extiende a un descuento atómico en dos pasos sobre las dos columnas nuevas.

## Flujo de registro

El formulario de registro ahora pide elegir un plan (Mini/Creator/Pro/Agency) antes de crear la cuenta.

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

- **Selector de plan en el registro**: las 4 opciones (Mini/Creator/Pro/Agency), mismo copy que la página de precios.
- **Banner de aviso**: en el dashboard, si `payment_status !== 'active'`, se muestra un banner:
  - `pending_payment`: "Elegiste el plan X — completá el pago para activarlo" + datos de contacto.
  - `grace_period`: "Tu plan vence hoy/mañana, renovalo para no perder acceso".
  - `suspended`: "Tu cuenta está suspendida por falta de pago".
  - Texto siempre estático/interpolado como texto plano de React (nunca `dangerouslySetInnerHTML`) — sin riesgo de inyección, ninguno de estos valores viene de input libre de otro usuario.
- **Panel admin**: pantalla nueva, solo accesible con `account_type==='admin'`, con la tabla de clientes y las 3 acciones (activar/renovar, suspender, cargar Sparks).

## Testing

- Unit: deducción de Sparks en el orden correcto (bono/comprado primero, plan después), incluyendo el caso borde de gastar más de lo que hay en `bonus_sparks_balance` y que continúe descontando de `plan_sparks_balance` en la misma operación atómica.
- Unit: el job diario — vencimiento → grace → suspended en los pasos correctos, recarga mensual resetea (no acumula) `plan_sparks_balance`, corre incluso si la cuenta está suspendida.
- Integration: `activate-plan` cubre tanto "activar pendiente" como "renovar vencido" con el mismo resultado final.
- Integration: middleware `requireActivePlan` bloquea correctamente en `pending_payment`/`suspended` y deja pasar en `active`/`grace_period`.
