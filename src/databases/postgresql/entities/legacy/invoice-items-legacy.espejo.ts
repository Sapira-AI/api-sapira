import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

import { InvoicesLegacy } from './invoices-legacy.espejo';

/**
 * Espejo de `public.invoice_items_legacy` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 11722 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Líneas de detalle de facturas legacy
 * Referenciada por FK desde 3 tabla(s): invoice_items, invoice_items_legacy_match, mrr_legacy.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_invoice_items_legacy (DELETE, public); tenant_isolation_insert_invoice_items_legacy (INSERT, public); tenant_isolation_select_invoice_items_legacy (SELECT, public); tenant_isolation_update_invoice_items_legacy (UPDATE, public).
 */
@Entity('invoice_items_legacy')
@Unique('invoice_items_legacy_holding_odoo_line_id_key', ['holding_id', 'odoo_line_id'])
@Index('idx_invoice_items_legacy_currency', ['currency'], { where: 'currency IS NOT NULL' })
@Index('idx_invoice_items_legacy_holding', ['holding_id'])
@Index('idx_invoice_items_legacy_holding_odoo_line', ['holding_id', 'odoo_line_id'])
@Index('idx_invoice_items_legacy_invoice', ['invoices_legacy_id'])
@Index('idx_invoice_items_legacy_item_type', ['item_type'], { where: 'item_type IS NOT NULL' })
@Index('idx_invoice_items_legacy_odoo_line_id', ['odoo_line_id'])
@Index('idx_invoice_items_legacy_product_code', ['product_external_code'], { where: 'product_external_code IS NOT NULL' })
@Index('idx_invoice_items_legacy_unit_of_measure', ['unit_of_measure'], { where: 'unit_of_measure IS NOT NULL' })
export class InvoiceItemsLegacy {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_items_legacy_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoices_legacy_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: true })
	product_external_code?: string;

	@Column({ type: 'text', nullable: false })
	description: string;

	@Column({ type: 'numeric', precision: 15, scale: 4, nullable: false, default: 1 })
	quantity: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	unit_price: number;

	@Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, default: 0 })
	discount_pct?: number;

	@Column({ type: 'text', nullable: true })
	tax_code?: string;

	/** Moneda del item de factura. Puede ser NULL y heredar de la factura padre. */
	@Column({ type: 'text', nullable: true })
	currency?: string;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	subtotal: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	tax_amount?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	total: number;

	@Column({ type: 'text', nullable: true })
	account_code?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	/** Tipo de item normalizado desde contract_item durante reconciliación (fixed, variable, usage-based, etc.) */
	@Column({ type: 'text', nullable: true })
	item_type?: string;

	/** Unidad de medida normalizada desde contract_item durante reconciliación (license, hours, users, etc.) */
	@Column({ type: 'text', nullable: true })
	unit_of_measure?: string;

	/** ID de la línea en Odoo (account.move.line.id). Usado para identificar y evitar duplicados de líneas importadas desde Odoo. */
	@Column({ type: 'text', nullable: true })
	odoo_line_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => InvoicesLegacy, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoices_legacy_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_invoices_legacy_id_fkey' })
	invoicesLegacy?: InvoicesLegacy;
}
