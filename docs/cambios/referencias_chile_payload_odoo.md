# Regla de referencias por pais en payload Odoo

## Cambio aplicado

En el scheduler de facturas se ajusto el armado del payload hacia Odoo para separar el tratamiento de referencias segun el pais de la compania.

## Regla de negocio

- Chile: si la factura trae referencias, cada referencia debe incluir `reference_date` para poblar el campo `date` requerido por `l10n_cl.account.invoice.reference`.
- Chile: las referencias se envian en `l10n_cl_reference_ids`.
- Uruguay y otros paises: las referencias no se envian en `l10n_cl_reference_ids`; se usa el `document_number` de la primera referencia para poblar el campo `ref` de Odoo.

## Impacto operativo

- Se evita que facturas de Uruguay intenten crear registros del modulo chileno en Odoo.
- Se conserva una referencia visible en Odoo para Uruguay y otros paises mediante el campo `ref`.
- Las facturas de Chile con referencias incompletas ahora se frenan en validacion backend antes de llamar a Odoo.
