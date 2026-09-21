import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elimina las dos vistas de `public` sin uso: `invoices_with_net_amounts` e
 * `invoice_items_consolidated` (REGISTRO-DB-COMO-CODIGO punto 7).
 *
 * Eran los prototipos de presentación del ejercicio de NC/devengo: montos netos
 * NC-aware por factura y líneas particionadas por origen (`main`/`credit_note`).
 * La lógica reutilizable quedó en las funciones vivas del corpus —
 * `get_invoice_net_amount()` (la primera vista la invoca) y
 * `get_invoice_items_with_credits()` — y las vistas quedaron huérfanas.
 *
 * Evidencia de no-uso, verificada en vivo el 2026-09-21 antes de escribir esto:
 *  - 0 referencias en el código de los tres repos (`sapira-ai`, `front-sapira`,
 *    `api-sapira`) — solo las mencionaba la documentación del corpus como deuda.
 *  - 0 funciones de `public` las referencian (`pg_get_functiondef ~* nombre`).
 *  - 0 filas del catálogo semántico del copiloto (`analytics.semantic_catalog`)
 *    las mencionan, así que el copiloto tampoco las consulta.
 *  - Ninguna vista/regla depende de ellas; sin datos propios que exportar.
 *
 * `DROP VIEW` sin `CASCADE` a propósito: si algo dependiera de ellas, queremos
 * que falle visible en vez de arrastrarlo.
 *
 * El `down()` es honesto de verdad: una vista es solo su definición, así que
 * recrearla la deja exactamente como estaba (definiciones verbatim de
 * `pg_get_viewdef` de producción, 2026-09-21).
 */
export class DropVistasSinUso1789100000000 implements MigrationInterface {
	name = 'DropVistasSinUso1789100000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP VIEW IF EXISTS public.invoices_with_net_amounts`);
		await queryRunner.query(`DROP VIEW IF EXISTS public.invoice_items_consolidated`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`CREATE VIEW public.invoices_with_net_amounts AS
 SELECT i.id,
    i.contract_id,
    i.invoice_number,
    i.issue_date,
    i.due_date,
    i.status,
    i.invoice_type,
    i.document_type,
    i.related_invoice_id,
    i.invoice_group_id,
    i.amount_invoice_currency AS subtotal_original,
    i.vat AS vat_original,
    i.total_invoice_currency AS total_original,
    i.invoice_currency,
        CASE
            WHEN i.document_type = 'NC'::text THEN NULL::numeric
            ELSE ( SELECT get_invoice_net_amount.subtotal_net
               FROM get_invoice_net_amount(i.id) get_invoice_net_amount(subtotal_net, vat_net, total_net, credit_notes_count))
        END AS subtotal_net,
        CASE
            WHEN i.document_type = 'NC'::text THEN NULL::numeric
            ELSE ( SELECT get_invoice_net_amount.vat_net
               FROM get_invoice_net_amount(i.id) get_invoice_net_amount(subtotal_net, vat_net, total_net, credit_notes_count))
        END AS vat_net,
        CASE
            WHEN i.document_type = 'NC'::text THEN NULL::numeric
            ELSE ( SELECT get_invoice_net_amount.total_net
               FROM get_invoice_net_amount(i.id) get_invoice_net_amount(subtotal_net, vat_net, total_net, credit_notes_count))
        END AS total_net,
        CASE
            WHEN i.document_type = 'NC'::text THEN NULL::integer
            ELSE ( SELECT get_invoice_net_amount.credit_notes_count
               FROM get_invoice_net_amount(i.id) get_invoice_net_amount(subtotal_net, vat_net, total_net, credit_notes_count))
        END AS credit_notes_count,
        CASE
            WHEN i.document_type = 'NC'::text THEN false
            ELSE (EXISTS ( SELECT 1
               FROM invoices nc
              WHERE nc.related_invoice_id = i.id AND nc.document_type = 'NC'::text))
        END AS has_credit_notes,
    i.company_id,
    i.client_id,
    i.client_entity_id,
    i.holding_id,
    i.created_at
   FROM invoices i`);

		await queryRunner.query(`CREATE VIEW public.invoice_items_consolidated AS
 WITH base_items AS (
         SELECT ii.id,
            ii.invoice_id,
            i.invoice_group_id,
            ii.contract_item_id,
            ii.product_id,
            ii.description,
            ii.quantity,
            ii.unit_price_invoice_currency AS unit_price,
            ii.subtotal_invoice_currency AS subtotal,
            ii.tax_amount_invoice_currency AS vat,
            ii.total_invoice_currency AS total,
            ii.contract_currency,
            ii.invoice_currency,
            'main'::text AS item_source,
            i.invoice_type,
            i.related_invoice_id,
            ci.product_name AS contract_product_name,
            ci.categoria AS contract_categoria
           FROM invoice_items ii
             JOIN invoices i ON i.id = ii.invoice_id
             LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
          WHERE i.document_type <> 'NC'::text
        ), credit_note_items AS (
         SELECT ii.id,
            ii.invoice_id,
            i.invoice_group_id,
            ii.contract_item_id,
            ii.product_id,
            ii.description,
            ii.quantity,
            ii.unit_price_invoice_currency AS unit_price,
            ii.subtotal_invoice_currency AS subtotal,
            ii.tax_amount_invoice_currency AS vat,
            ii.total_invoice_currency AS total,
            ii.contract_currency,
            ii.invoice_currency,
            'credit_note'::text AS item_source,
            i.invoice_type,
            i.related_invoice_id,
            ci.product_name AS contract_product_name,
            ci.categoria AS contract_categoria
           FROM invoice_items ii
             JOIN invoices i ON i.id = ii.invoice_id
             LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
          WHERE i.document_type = 'NC'::text
        )
 SELECT base_items.id,
    base_items.invoice_id,
    base_items.invoice_group_id,
    base_items.contract_item_id,
    base_items.product_id,
    base_items.description,
    base_items.quantity,
    base_items.unit_price,
    base_items.subtotal,
    base_items.vat,
    base_items.total,
    base_items.contract_currency,
    base_items.invoice_currency,
    base_items.item_source,
    base_items.invoice_type,
    base_items.related_invoice_id,
    base_items.contract_product_name,
    base_items.contract_categoria
   FROM base_items
UNION ALL
 SELECT credit_note_items.id,
    credit_note_items.invoice_id,
    credit_note_items.invoice_group_id,
    credit_note_items.contract_item_id,
    credit_note_items.product_id,
    credit_note_items.description,
    credit_note_items.quantity,
    credit_note_items.unit_price,
    credit_note_items.subtotal,
    credit_note_items.vat,
    credit_note_items.total,
    credit_note_items.contract_currency,
    credit_note_items.invoice_currency,
    credit_note_items.item_source,
    credit_note_items.invoice_type,
    credit_note_items.related_invoice_id,
    credit_note_items.contract_product_name,
    credit_note_items.contract_categoria
   FROM credit_note_items`);
	}
}
