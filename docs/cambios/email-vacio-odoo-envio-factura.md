# Cambio: `false` de Odoo tapaba el error de "cliente sin email" al enviar facturas

> **Archivo:** `src/modules/odoo/odoo-invoices.service.ts` · `sendInvoiceToCustomer()`
> **Spec:** `src/modules/odoo/odoo-invoices.service.spec.ts`
> **Fecha:** 2026-09-09

## Contexto

Odoo, vía XML-RPC, devuelve `false` —no `null` ni `''`— en los campos de texto vacíos. Es una
particularidad del serializador de Odoo, no un caso de borde raro: **todo** `res.partner` sin email
llega como `{ email: false }`.

El código extraía el destinatario así:

```ts
const recipientEmail = partnerData?.[0]?.email?.trim();
```

El encadenamiento opcional (`?.`) solo corta ante `null` y `undefined`. Ante `false` sigue adelante,
evalúa `false.trim` —que es `undefined`— y lo invoca: `TypeError`.

## Impacto observable

La validación de la línea siguiente nunca llegaba a ejecutarse para el caso que existe para cubrir.
El `catch` del método envolvía el `TypeError` y el cliente de la API recibía:

```
Error enviando factura al cliente desde Odoo: partnerData?.[0]?.email?.trim is not a function
```

en lugar del error de dominio previsto:

```
El cliente de la factura FAC-001 no tiene email configurado en Odoo
```

Mismo resultado —el envío falla, que es lo correcto— pero con un mensaje que no le dice a quien
opera qué tiene que arreglar, y que apunta a un fallo del backend en vez de a un dato faltante en la
ficha del cliente en Odoo.

## Corrección

```ts
const rawEmail = partnerData?.[0]?.email;
const recipientEmail = typeof rawEmail === 'string' ? rawEmail.trim() : '';
```

`typeof === 'string'` cubre `false`, `null`, `undefined` y cualquier otro tipo que Odoo devuelva, y
deja `''` para que la validación de dominio de más abajo haga su trabajo.

## Contrato de errores

Sin cambios en la firma ni en el camino feliz. Lo que cambia es **qué mensaje** recibe el consumidor
cuando el cliente no tiene email: pasa del `TypeError` envuelto al error de dominio que ya estaba
escrito. Quien dependa del texto anterior —ningún consumidor conocido lo hace— tiene que ajustarse.

## Cobertura

- `falla el envío si el cliente no tiene email en Odoo` (`email: false`) — ya existía y **estaba en
  rojo**: es la que detectaba este defecto. Ahora pasa.
- `falla el envío si el email del cliente es solo espacios` (`email: '   '`) — agregada. Cubre el
  `.trim()`; pasa con el código viejo y con el nuevo, así que documenta la intención pero no es la
  que guarda esta corrección.
