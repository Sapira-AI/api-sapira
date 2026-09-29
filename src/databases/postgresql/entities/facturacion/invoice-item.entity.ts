import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ContractItem } from '@/databases/postgresql/entities/contratos/contract-item.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';
import { InvoiceItemsLegacyMatch } from '@/databases/postgresql/entities/legacy/invoice-items-legacy-match.entity';
import { InvoiceItemsLegacy } from '@/databases/postgresql/entities/legacy/invoice-items-legacy.entity';
import { SubscriptionItem } from '@/databases/postgresql/entities/suscripciones/subscription-item.entity';

/** Pricing v2: origen de la cantidad de una línea. */
export const INVOICE_ITEM_QUANTITY_SOURCES = ['fixed', 'consumption', 'estimated', 'pending'] as const;
export type InvoiceItemQuantitySource = (typeof INVOICE_ITEM_QUANTITY_SOURCES)[number];

/** Pricing v2: sublínea del desglose guardado en `pricing_breakdown` (misma forma que `PricedLine.breakdown`). */
export interface PricingBreakdownRow {
	kind: 'free' | 'tier' | 'package' | 'seat' | 'discount' | 'minimum' | 'cap';
	tier_index?: number;
	from?: number;
	to?: number | null;
	quantity: number;
	unit_amount?: number;
	flat_amount?: number;
	amount: number;
	label: string;
}

@Check('invoice_items_discount_pct_check', `(((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric)))`)
// Pricing v2 (migración 1790630000000): una línea por consumo puede quedar en 0 (consumo 0 = "sin consumo", spec §2.3), así
// que el CHECK pasa de `> 0` a `>= 0`.
@Check('invoice_items_quantity_check', `((quantity >= (0)::numeric))`)
@Check(
	'invoice_items_quantity_source_check',
	`(("quantity_source" IS NULL) OR ("quantity_source" = ANY (ARRAY['fixed'::text, 'consumption'::text, 'estimated'::text, 'pending'::text])))`
)
@Index('idx_invoice_items_billing_period', ['billing_period_start', 'billing_period_end'])
@Index('idx_invoice_items_contract_id', ['contract_id'])
@Index('idx_invoice_items_contract_item_id', ['contract_item_id'])
@Index('idx_invoice_items_invoice_id', ['invoice_id'])
@Index('idx_invoice_items_issue_date', ['issue_date'])
@Index('idx_invoice_items_product_id', ['product_id'])
@Index('idx_invoice_items_status', ['status'])
@Index('idx_invoice_items_subscription_item_id', ['subscription_item_id'], { where: `(subscription_item_id IS NOT NULL)` })
@Index('idx_invoice_items_custom_fields', { synchronize: false })
@Entity('invoice_items')
export class InvoiceItem {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_items_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	invoice_id: string;

	// Anomalía de producción: un INSERT que omita la columna genera un UUID aleatorio
	// que siempre viola la FK. Se replica tal cual.
	@Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
	holding_id: string;

	@Column({ type: 'text' })
	description: string;

	@Column({ type: 'numeric', precision: 18, scale: 4 })
	quantity: number;

	@Column({ type: 'text', nullable: true, default: 'UND' })
	unit_of_measure?: string;

	@Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, default: 0 })
	discount_pct?: number;

	@Column({ type: 'text', nullable: true, default: '19' })
	tax_code?: string;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	contract_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	@Column({ type: 'uuid', nullable: true })
	product_id?: string;

	@Column({ type: 'text', nullable: true })
	status?: string;

	@Column({ type: 'date', nullable: true })
	issue_date?: Date;

	@Column({ type: 'uuid', nullable: true, comment: 'Referencia a la línea legacy original' })
	legacy_item_id?: string;

	@Column({ type: 'uuid', nullable: true, comment: 'Referencia al match que generó esta línea' })
	legacy_match_id?: string;

	@Column({ type: 'jsonb', nullable: true, default: () => "'{}'", comment: 'Campos personalizados definidos por el usuario en formato JSONB' })
	custom_fields?: object;

	/** Pricing v2 (`docs/v2-rediseno/spec-pricing-v2.md` §2.4): sublíneas del desglose tal como las produjo el motor. */
	@Column({
		type: 'jsonb',
		nullable: true,
		comment:
			'Pricing v2: sublíneas del desglose {kind: free|tier|package|seat|discount|minimum|cap, quantity, amount, label…} tal como las produjo el motor; la línea sigue siendo una',
	})
	pricing_breakdown?: PricingBreakdownRow[] | null;

	/** Pricing v2: de dónde salió la cantidad de la línea; `pending` = línea medida sin consumo informado. */
	@Column({
		type: 'text',
		nullable: true,
		comment: 'Pricing v2: fixed | consumption | estimated | pending (pending = línea metered sin consumo informado)',
	})
	quantity_source?: InvoiceItemQuantitySource | null;

	@Column({ type: 'text', nullable: true })
	invoice_currency?: string;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	unit_price_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	subtotal_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	tax_amount_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	total_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	fx_contract_to_invoice?: number;

	@Column({ type: 'text', nullable: true })
	fx_rate_source?: string;

	@Column({ type: 'date', nullable: true })
	fx_rate_date?: Date;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	unit_price_contract_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	subtotal_contract_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	tax_amount_contract_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	total_contract_currency?: number;

	@Column({ type: 'text', nullable: true })
	contract_currency?: string;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de inicio del periodo de servicio que cubre esta línea de factura.' })
	billing_period_start?: Date;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de fin del periodo de servicio que cubre esta línea de factura.' })
	billing_period_end?: Date;

	@Column({ type: 'uuid', nullable: true, comment: 'FK a subscription_items. Usado para items de invoices de suscripciones externas.' })
	subscription_item_id?: string;

	@Column({
		type: 'integer',
		nullable: true,
		comment:
			'ID del impuesto de Odoo (account.tax) que se aplicará a esta línea de factura. Se asigna automáticamente desde la compañía emisora al enviar a Odoo.',
	})
	odoo_tax_id?: number;

	// Las cuatro FKs que faltaban quedaron declaradas al promover sus espejos (E4, lotes 1 y 2).
	//
	// ⚠️ `holding_id` tiene DOS FKs en producción sobre la misma columna, con ON DELETE distinto:
	// `fk_invoice_items_holding_id` es CASCADE y `invoice_items_holding_id_fkey` es NO ACTION.
	// El NO ACTION no protege nada porque el CASCADE se evalúa igual. Se replican ambas.
	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_invoice_items_contract' })
	contract?: Contract;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_invoice_items_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_holding_id_fkey' })
	holding2?: CompanyHolding;

	@ManyToOne(() => Product, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'product_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_invoice_items_product' })
	product?: Product;

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_invoice_id_fkey' })
	invoice?: Invoice;

	@ManyToOne(() => ContractItem, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'contract_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_contract_item_id_fkey' })
	contract_item?: ContractItem;

	@ManyToOne(() => InvoiceItemsLegacy, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'legacy_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_item_id_fkey' })
	legacy_item?: InvoiceItemsLegacy;

	@ManyToOne(() => InvoiceItemsLegacyMatch, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'legacy_match_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_match_id_fkey' })
	legacy_match?: InvoiceItemsLegacyMatch;

	@ManyToOne(() => SubscriptionItem)
	@JoinColumn({ name: 'subscription_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_subscription_item_id_fkey' })
	subscription_item?: SubscriptionItem;
}
