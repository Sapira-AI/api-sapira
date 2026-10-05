# Cambio: CORS sale de `CORS_ORIGINS`, y se retira el comodín de Vercel

> **Rama:** `leon` · 05-10-2026 · Leon + Claude
> Archivos: `src/core/config/cors-origins.ts`, `src/main.ts`,
> `src/modules/invoices/invoice-scheduler.gateway.ts`, `.env.example`.

## Lo que había

`CORS_ORIGINS` **existía en `.env` y ningún archivo del código la leía**. Tampoco estaba en
`.env.example`, así que un entorno nuevo nacía sin ella. La política de CORS salía en realidad de
`FRONT_BASE_URL`, que hacía tres trabajos a la vez:

| Consumidor | Para qué usaba `FRONT_BASE_URL` |
|---|---|
| `main.ts` (HTTP) y `notifications.gateway.ts` | Orígenes de CORS, vía `getCorsOrigins()` |
| `invoice-scheduler.gateway.ts` | Orígenes de CORS, **con el parseo reimplementado inline** |
| `recaptcha.service.ts:171` | Hostnames desde los que se acepta un captcha |

Como el gateway del scheduler tenía su propia copia del parseo y no incluía el regex de Vercel,
**había tres políticas de CORS distintas en vigor** en el mismo proceso.

## El agujero

```ts
return [/\.vercel\.app$/, ...getFrontendOrigins(frontBaseUrl)];
```

Ese regex, junto a `credentials: true` en `main.ts`, permitía que **cualquier** página alojada en
`*.vercel.app` —de cualquier persona, no solo de Sapira— hiciera peticiones con credenciales a la API.
Bastaba desplegar algo en Vercel. Estaba ahí para que los preview deploys del front pudieran hablar con
la API, pero el precio era habilitar a todo el dominio.

## Lo que hay ahora

- **CORS sale de `CORS_ORIGINS`, declarada origen por origen.** Sin comodines ni regex: estas peticiones
  viajan con credenciales, así que cada una se nombra.
- **Se retiró `/\.vercel\.app$/`** (decisión de Leon, 05-10). Un preview deploy que necesite hablar con
  esta API se agrega a `CORS_ORIGINS` del entorno que corresponda.
- **`FRONT_BASE_URL` queda con un solo propósito**: la URL de los fronts, que es lo que consume
  `recaptcha.service.ts`. No se tocó su comportamiento.
- **Una sola política**: `invoice-scheduler.gateway.ts` ya usa `getCorsOrigins()` en vez de su copia del
  parseo, así que HTTP y los dos gateways comparten la lista. Era el objetivo original del helper.
- `getCorsOrigins()` devuelve `string[]`: al no haber regex, el tipo `(string | RegExp)[]` sobraba.

### Compatibilidad: la caída a `FRONT_BASE_URL`

Si `CORS_ORIGINS` no está definida (o viene vacía), CORS **cae a `FRONT_BASE_URL`** y `main.ts` avisa al
arrancar:

```
CORS_ORIGINS no está definida: CORS cae a FRONT_BASE_URL (…). Declarala en este entorno.
```

Es una red de seguridad para no dejar la API sin CORS en un despliegue que todavía no tiene la variable,
no el camino esperado. `corsOriginsFaltante()` es lo que delata la caída.

## ⚠️ Acción de despliegue

**QA y producción tienen que declarar `CORS_ORIGINS`.** Mientras no la tengan, CORS sigue funcionando por
la caída a `FRONT_BASE_URL` —no se rompe nada—, pero el log lo va a avisar en cada arranque, y lo que
antes entraba por el comodín de Vercel ya no entra. Si algún preview deploy dependía de eso, su URL va
en la variable.

En local no hay nada que hacer: `.env` ya tiene `CORS_ORIGINS=http://localhost:8080,http://localhost:8081`.

## Tests

`src/core/config/cors-origins.spec.ts` pasó de 3 a **9 tests**. Los nuevos que importan:

- **La regresión del comodín**: que la lista no devuelva ningún `RegExp` ni nada que contenga
  `vercel.app`. Es el test que habría impedido el agujero.
- Que un preview de Vercel entre **solo** si está declarado en `CORS_ORIGINS`.
- Que `CORS_ORIGINS` gane sobre `FRONT_BASE_URL` cuando las dos están definidas.
- Los tres casos de la caída por compatibilidad, incluido `corsOriginsFaltante`.

`yarn jest` → 214 suites, 3307 tests en verde. `yarn build` limpio.
