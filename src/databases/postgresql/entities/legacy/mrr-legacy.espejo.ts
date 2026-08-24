import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { Client } from '@/databases/postgresql/entities/client.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';
import { User } from '@/modules/users/entities/user.entity';

import { InvoiceItemsLegacy } from './invoice-items-legacy.espejo';
import { InvoicesLegacy } from './invoices-legacy.espejo';

/**
 * Espejo de `public.mrr_legacy` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 11810 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Registro rápido de MRR histórico desde facturas legacy sin reconciliación completa. Una fila = 1 producto + 1 mes. Permite valores negativos para notas de crédito y ajustes.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_calculate_mrr_legacy_fields · BEFORE INSERT OR UPDATE OF subtotal_contract_currency, term, is_recurring FOR EACH ROW → calculate_mrr_legacy_fields(); trg_calculate_mrr_legacy_system_currency · BEFORE INSERT OR UPDATE OF contract_currency, mrr_legacy, period_month FOR EACH ROW → calculate_mrr_legacy_system_currency(); trg_mrr_legacy_updated_at · BEFORE UPDATE FOR EACH ROW → set_updated_at(); trigger_update_invoice_legacy_status_on_mrr · AFTER INSERT FOR EACH ROW → update_invoice_legacy_status_on_mrr_creation().
 * Policies (4): Users can delete mrr_legacy from their holding (DELETE, public); Users can insert mrr_legacy in their holding (INSERT, public); Users can update mrr_legacy in their holding (UPDATE, public); Users can view mrr_legacy from their holding (SELECT, public).
 */
@Entity('mrr_legacy')
@Unique('mrr_legacy_invoice_item_legacy_id_split_index_period_month_key', ['invoice_item_legacy_id', 'split_index', 'period_month'])
@Check('mrr_legacy_fx_valid', '(fx_contract_to_invoice > (0)::numeric) OR (subtotal_contract_currency = (0)::numeric)')
@Check('mrr_legacy_momentum_check', "(momentum IS NULL) OR (momentum = 'EOP'::text)")
@Check('mrr_legacy_period_month_check', "date_trunc('month'::text, (period_month)::timestamp with time zone) = period_month")
@Check('mrr_legacy_split_index_check', 'split_index > 0')
@Check('mrr_legacy_term_check', 'term > 0')
@Index('idx_mrr_legacy_batch_id', ['batch_id'])
@Index('idx_mrr_legacy_client', ['client_id'])
@Index('idx_mrr_legacy_company', ['company_id'])
@Index('idx_mrr_legacy_holding', ['holding_id'])
@Index('idx_mrr_legacy_invoice', ['invoice_legacy_id'])
@Index('idx_mrr_legacy_invoice_created', ['invoice_legacy_id', 'created_at'])
@Index('idx_mrr_legacy_invoice_item', ['invoice_item_legacy_id'])
@Index('idx_mrr_legacy_migrated', ['migrated_to_contract_id'], { where: 'migrated_to_contract_id IS NOT NULL' })
@Index('idx_mrr_legacy_not_migrated', ['client_id', 'invoice_legacy_id', 'created_at'], { where: 'migrated_to_contract_id IS NULL' })
@Index('idx_mrr_legacy_period', ['period_month'])
@Index('idx_mrr_legacy_product', ['product_name'])
@Index('idx_mrr_legacy_recurring', ['is_recurring'], { where: 'is_recurring = true' })
@Index('idx_mrr_legacy_skip_activation', ['skip_activation'], { where: 'skip_activation = true' })
export class MrrLegacy {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'mrr_legacy_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_legacy_id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_item_legacy_id: string;

	/** Índice de división cuando una línea de factura se asigna a múltiples productos/monedas */
	@Column({ type: 'integer', nullable: false, default: 1 })
	split_index: number;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false })
	client_tax_id: string;

	@Column({ type: 'text', nullable: false })
	legal_client_name: string;

	@Column({ type: 'text', nullable: false })
	invoice_number: string;

	@Column({ type: 'date', nullable: false })
	issue_date: Date;

	@Column({ type: 'text', nullable: false })
	invoice_currency: string;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	amount_invoice_currency: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	total_invoice_currency: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	vat?: number;

	@Column({ type: 'text', nullable: false })
	status: string;

	@Column({ type: 'text', nullable: false })
	description: string;

	@Column({ type: 'text', nullable: false })
	currency: string;

	@Column({ type: 'numeric', precision: 15, scale: 4, nullable: true })
	quantity?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	unit_price?: number;

	@Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
	discount_pct?: number;

	/** Subtotal original del invoice_item_legacy (sin dividir) */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	subtotal: number;

	/** Monto asignado a este split en moneda de factura */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	allocated_invoice_currency: number;

	@Column({ type: 'uuid', nullable: false })
	client_id: string;

	@Column({ type: 'text', nullable: false })
	contract_currency: string;

	/** Monto en moneda de contrato ingresado por usuario */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	subtotal_contract_currency: number;

	@Column({ type: 'text', nullable: false })
	product_name: string;

	/** Cantidad de períodos del contrato (para calcular MRR) */
	@Column({ type: 'integer', nullable: false })
	term: number;

	/** Período mensual (YYYY-MM-01). Una fila por mes. */
	@Column({ type: 'date', nullable: false })
	period_month: Date;

	@Column({ type: 'boolean', nullable: false, default: true })
	is_recurring: boolean;

	/** FX calculado entre subtotal_contract_currency y allocated_invoice_currency */
	@Column({ type: 'numeric', precision: 12, scale: 6, nullable: false })
	fx_contract_to_invoice: number;

	@Column({ type: 'numeric', precision: 12, scale: 6, nullable: true })
	fx_contract_to_system?: number;

	/** MRR calculado: subtotal_contract_currency / term (solo si is_recurring) */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	mrr_legacy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	mrr_legacy_system_currency?: number;

	/** Siempre EOP para registros recurrentes, NULL para no recurrentes */
	@Column({ type: 'text', nullable: true })
	momentum?: string;

	/** Usuario que creó el registro de MRR legacy */
	@Column({ type: 'uuid', nullable: true, default: () => 'auth.uid()' })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	/** Contrato creado desde este registro legacy */
	@Column({ type: 'uuid', nullable: true })
	migrated_to_contract_id?: string;

	/** Fecha de migración a contrato activo */
	@Column({ type: 'timestamp with time zone', nullable: true })
	migrated_at?: Date;

	/** Usuario que realizó la migración */
	@Column({ type: 'uuid', nullable: true })
	migrated_by?: string;

	/** UUID que agrupa registros de MRR Legacy creados en el mismo lote, independientemente de la fecha de creación. Permite agregar facturas a grupos existentes. */
	@Column({ type: 'uuid', nullable: false })
	batch_id: string;

	/** When true, this record should not be activated (e.g., churn, duplicate, error) */
	@Column({ type: 'boolean', nullable: false, default: false })
	skip_activation: boolean;

	/** Reason why activation was skipped (e.g., Churn, Duplicado, Error de importación) */
	@Column({ type: 'text', nullable: true })
	skip_activation_reason?: string;

	/** Timestamp when skip_activation was set to true */
	@Column({ type: 'timestamp with time zone', nullable: true })
	skip_activation_at?: Date;

	/** User who marked this record as skip_activation */
	@Column({ type: 'uuid', nullable: true })
	skip_activation_by?: string;

	@ManyToOne(() => InvoiceItemsLegacy, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_item_legacy_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_invoice_item_legacy_id_fkey' })
	invoiceItemLegacy?: InvoiceItemsLegacy;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Client)
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_client_id_fkey' })
	client?: Client; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'migrated_to_contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_migrated_to_contract_id_fkey' })
	migratedToContract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'migrated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_migrated_by_fkey' })
	migratedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => InvoicesLegacy, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_legacy_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_legacy_invoice_legacy_id_fkey' })
	invoiceLegacy?: InvoicesLegacy;
}
