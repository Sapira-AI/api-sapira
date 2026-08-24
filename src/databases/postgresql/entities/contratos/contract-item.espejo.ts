import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Product } from '@/modules/odoo/entities/products.entity';
import { QuoteItem } from '@/modules/salesforce/entities/quote-item.entity';

/**
 * Espejo de `public.contract_items` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1087 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 5 tabla(s): contract_amendment_items, invoice_items, invoice_items_legacy_match, quantities, revenue_schedule_monthly.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_00_period_guard_contract_items · BEFORE INSERT OR DELETE OR UPDATE FOR EACH ROW → trg_period_guard_contract_items(); trg_audit_contract_item_changes · AFTER INSERT OR DELETE OR UPDATE FOR EACH ROW → trg_audit_contract_item_changes(); trg_calculate_contract_categoria · BEFORE INSERT FOR EACH ROW → trg_set_contract_item_categoria(); trg_contract_items_calculate_pricing · BEFORE INSERT OR UPDATE OF unit_price, quantity, billing_frequency, is_recurring, final_price, term_months, discount_type, discount_value, annual_unit_price, price_entry_mode FOR EACH ROW → auto_calculate_pricing_fields(); trg_inherit_auto_renew_from_quote_item · BEFORE INSERT FOR EACH ROW → inherit_auto_renew_from_quote_item(); trg_rsm_on_contract_item_change · AFTER INSERT OR UPDATE FOR EACH ROW → trigger_rsm_on_contract_item_change(); trg_set_contract_item_end_date · BEFORE INSERT OR UPDATE OF start_date, term_months FOR EACH ROW → set_contract_item_end_date(); trg_z_fix_renewal_annual · BEFORE INSERT FOR EACH ROW → fix_renewal_annual_fields() [WHEN ((new.categoria = 'RENEWAL'::text) AND (new.renews_item_id IS NOT NULL))]; trg_zzz_pending_renewal_on_item_change · AFTER INSERT OR UPDATE FOR EACH ROW → trigger_pending_renewal_on_item_change(); trigger_update_contract_term · AFTER INSERT OR DELETE OR UPDATE FOR EACH ROW → update_contract_term(); validate_contract_item_currency_trigger · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_contract_item_currency_consistency().
 * Policies (5): Users can delete contract items from their holding (DELETE, public); Users can insert contract items for their holding (INSERT, public); Users can update contract items from their holding (UPDATE, public); Users can view contract items from their holding (SELECT, public); holding_access_contract_items (ALL, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_contract_items_custom_fields ON public.contract_items USING gin (custom_fields)
 */
@Entity('contract_items')
@Check('chk_contract_items_price_entry_mode', "price_entry_mode = ANY (ARRAY['monthly'::text, 'annual'::text])")
@Check(
	'contract_items_billing_frequency_check',
	"billing_frequency = ANY (ARRAY['Mensual'::text, 'Anual'::text, 'Semestral'::text, 'Trimestral'::text, 'Bianual'::text])"
)
@Check('contract_items_billing_method_check', "billing_method = ANY (ARRAY['Anticipado'::text, 'Vencido'::text])")
@Check(
	'contract_items_categoria_check',
	"(categoria IS NULL) OR (categoria = ANY (ARRAY['NEW'::text, 'REACTIVATION'::text, 'UPSELL'::text, 'CROSS-SELL'::text, 'DOWNSELL'::text, 'CHURN'::text, 'RENEWAL'::text]))"
)
@Check('contract_items_discount_type_check', "discount_type = ANY (ARRAY['Monto fijo'::text, 'Porcentaje'::text])")
@Index('idx_contract_items_auto_renew_end_date', ['auto_renew', 'end_date'], { where: 'auto_renew = true' })
@Index('idx_contract_items_categoria', ['categoria'])
@Index('idx_contract_items_churn_date', ['churn_date'], { where: 'churn_date IS NOT NULL' })
@Index('idx_contract_items_contract_end_date', ['contract_id', 'end_date'])
@Index('idx_contract_items_holding_id', ['holding_id'])
@Index('idx_contract_items_monthly_price', ['monthly_price'], { where: '(monthly_price IS NOT NULL) AND (is_recurring = true)' })
@Index('idx_contract_items_quote_item_id', ['quote_item_id'])
@Index('idx_contract_items_quote_item_number', ['quote_item_number'], { where: 'quote_item_number IS NOT NULL' })
@Index('idx_contract_items_recurring_dates', ['is_recurring', 'start_date', 'end_date'], { where: 'is_recurring = true' })
@Index('idx_contract_items_related', ['related_item_id'], { where: 'related_item_id IS NOT NULL' })
export class ContractItem {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_items_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	@Column({ type: 'uuid', nullable: true })
	product_id?: string;

	@Column({ type: 'text', nullable: false })
	product_name: string;

	@Column({ type: 'integer', nullable: true })
	term_months?: number;

	@Column({ type: 'text', nullable: true })
	currency?: string;

	@Column({ type: 'numeric', nullable: true })
	price?: number;

	@Column({ type: 'text', nullable: true })
	discount_type?: string;

	@Column({ type: 'numeric', nullable: true })
	discount_value?: number;

	@Column({ type: 'numeric', nullable: true })
	final_price?: number;

	@Column({ type: 'text', nullable: true })
	billing_method?: string;

	@Column({ type: 'text', nullable: true })
	billing_frequency?: string;

	/** Fecha de inicio para la prestación del servicio/producto y devengo de ingresos */
	@Column({ type: 'date', nullable: true })
	start_date?: Date;

	@Column({ type: 'uuid', nullable: true })
	quote_item_id?: string;

	@Column({ type: 'uuid', nullable: false, default: () => 'gen_random_uuid()' })
	holding_id: string;

	@Column({ type: 'date', nullable: true })
	end_date?: Date;

	@Column({ type: 'uuid', nullable: true })
	renews_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	renewed_by_item_id?: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	is_recurring: boolean;

	/** Categoría del item: NEW (logo nuevo), REACTIVATION (cliente vuelve), UPSELL (expansión), DOWNSELL (contracción), CHURN (cancelación), RENEWAL (renovación), RECURRENT (legacy/base) */
	@Column({ type: 'text', nullable: true })
	categoria?: string;

	/** Referencia al item original (para items negativos de DOWNSELL/CHURN) */
	@Column({ type: 'uuid', nullable: true })
	related_item_id?: string;

	/** Categorización libre del item (ej: Licencias, Servicios, Hardware) */
	@Column({ type: 'varchar', length: 64, nullable: true })
	item_type?: string;

	/** Unidad de medida del producto/servicio (UND, PERIODOS, etc.) */
	@Column({ type: 'varchar', length: 32, nullable: true })
	unit_of_measure?: string;

	/** Precio unitario base (opcional). Si existe, price = unit_price × quantity × term_months */
	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	unit_price?: number;

	/** Cantidad del producto/servicio en el contrato */
	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	quantity?: number;

	/** Código de cuenta contable (texto libre, opcional) */
	@Column({ type: 'varchar', length: 128, nullable: true })
	account?: string;

	/** Campos personalizados definidos por el usuario en formato JSONB */
	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	custom_fields?: any;

	/** Fecha efectiva de churn para este item. Si existe, tiene prioridad sobre end_date para cálculos. */
	@Column({ type: 'date', nullable: true })
	churn_date?: Date;

	/** Monto mensual que se pierde por el churn. Calculado como final_price / term_months. */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	churn_monthly_amount?: number;

	/** Precio mensual del item (final_price para recurrentes). INCLUYE descuentos aplicados. Usado para cálculo de MRR. */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	monthly_price?: number;

	/** Precio por periodo de facturación. Para recurrentes: monthly_price × frequency_multiplier. Para one-times: (final_price/term_months) × frequency_multiplier. Usado para validar invoice_items. */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	billing_period_price?: number;

	/** Indica si este item debe renovarse automáticamente al vencer */
	@Column({ type: 'boolean', nullable: false, default: false })
	auto_renew: boolean;

	/** Término en meses para la renovación automática. Si es NULL, usa el mismo term_months del item original */
	@Column({ type: 'integer', nullable: true })
	auto_renew_term_months?: number;

	/** Timestamp de cuándo se ejecutó la última renovación automática */
	@Column({ type: 'timestamp with time zone', nullable: true })
	auto_renewed_at?: Date;

	/**
	 * Número de línea de cotización (quote_items.quote_item_number). En el DWH se
	 *  conoce como salesforce_quote_lineitem_id. Permite resolver contract_item_id
	 *  desde quantities cuando el DWH no provee el ID de Sapira directamente.
	 */
	@Column({ type: 'text', nullable: true })
	quote_item_number?: string;

	/** Precio unitario anual. Fuente de verdad cuando price_entry_mode = annual. Derivado (unit_price * 12) cuando mode = monthly. */
	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	annual_unit_price?: number;

	/** Subtotal anual = annual_unit_price * quantity. Usado para totales anuales sin redondeo. */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	annual_price?: number;

	/** Indica cual campo es fuente de verdad: monthly (unit_price) o annual (annual_unit_price). Default: monthly. */
	@Column({ type: 'text', nullable: true, default: 'monthly' })
	price_entry_mode?: string;

	/** Fecha de booking del item. Desde cuando el CMRR se registra en RSM. Si NULL, usa start_date. */
	@Column({ type: 'date', nullable: true })
	booking_date?: Date;

	/** Precio unitario efectivo ANTES de la renovación (mismo price_entry_mode y escala que unit_price). Solo poblado en items con categoria=RENEWAL cuando la renovación cambió el precio. Usado por apply_renewal_price_split() al final de revenue_schedule_rebuild_contract_ccy para emitir filas RSM RENEWAL (precio base) + UPSELL/DOWNSELL (delta) en el mes efectivo, solo en columnas *_contract_ccy. revenue_schedule_apply_fx_for_contract completa system/company. */
	@Column({ type: 'numeric', nullable: true })
	renewal_base_unit_price?: number;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_items_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => ContractItem)
	@JoinColumn({ name: 'renewed_by_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_items_renewed_by_item_id_fkey' })
	renewedByItem?: ContractItem;

	@ManyToOne(() => ContractItem)
	@JoinColumn({ name: 'renews_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_items_renews_item_id_fkey' })
	renewsItem?: ContractItem;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_items_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => Product)
	@JoinColumn({ name: 'product_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_items_product_id_fkey' })
	product?: Product; // entity existente (no se duplica)

	@ManyToOne(() => QuoteItem)
	@JoinColumn({ name: 'quote_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_items_quote_item_id_fkey' })
	quoteItem?: QuoteItem; // entity existente (no se duplica)

	@ManyToOne(() => ContractItem, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'related_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_items_related_item_id_fkey' })
	relatedItem?: ContractItem;
}
