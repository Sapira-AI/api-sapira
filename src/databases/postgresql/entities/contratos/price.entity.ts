import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { BillableMetric } from '@/databases/postgresql/entities/contratos/billable-metric.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';

/** Quién es dueño del precio: catálogo versionado (etapa 3) o el ítem del contrato (inline, etapa 1). Cotizaciones v2 (Q-A3) suma `quote`. */
export const PRICE_OWNERS = ['catalog', 'contract', 'quote'] as const;
export type PriceOwner = (typeof PRICE_OWNERS)[number];

/** Modelos de precio de la etapa 1 (`percentage` y `matrix` quedan para después). */
export const PRICE_MODELS = ['standard', 'graduated', 'volume', 'package', 'seat'] as const;
export type PriceModel = (typeof PRICE_MODELS)[number];

/** Cantidad fija (la del ítem) o medida (métrica facturable). */
export const PRICE_QUANTITY_TYPES = ['fixed', 'metered'] as const;
export type PriceQuantityType = (typeof PRICE_QUANTITY_TYPES)[number];

export const PRICE_STATUSES = ['draft', 'active', 'archived'] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

/** Cómo se presenta la línea tarifada en la factura (spec §3.8). */
export const INVOICE_LINE_MODES = ['single', 'per_tier'] as const;
export type InvoiceLineMode = (typeof INVOICE_LINE_MODES)[number];

/** Tramo de `graduated`/`volume` tal como se guarda en `prices.tiers` (jsonb). */
export interface PriceTierRow {
	from: number;
	to: number | null;
	per_unit_amount: number;
	flat_amount: number;
}

/**
 * `prices` — el modelo de precio de un ítem (inline, `owner = contract`) o del catálogo versionado (`owner = catalog`, etapa 3)
 * (Pricing v2, `docs/v2-rediseno/spec-pricing-v2.md` §2.2).
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790630000000-CreatePricingV2`. RLS por
 * holding con `rls/holding_access_prices.sql`. Un precio referenciado por ítems no se edita: se crea la versión siguiente
 * (`version + 1`, `supersedes_price_id`) y la anterior queda `archived`.
 */
@Entity({
	name: 'prices',
	comment: 'Modelo de precio (standard, graduated, volume, package, seat) con cantidad fija o medida, tramos, gratis, mínimo y tope',
})
@Index('idx_prices_holding_product_status', ['holding_id', 'product_id', 'status'])
@Index('idx_prices_contract_id', ['contract_id'], { where: `owner = 'contract'` })
@Index('idx_prices_billable_metric_id', ['billable_metric_id'])
// Cotizaciones v2 (migración 1790650000000-QuotesV2): owner `quote`, `quote_id` (FK CASCADE a quotes) e `idx_prices_quote_id`.
@Index('idx_prices_quote_id', ['quote_id'], { where: `owner = 'quote'` })
@Check('prices_owner_check', `"owner" = ANY (ARRAY['catalog'::text, 'contract'::text, 'quote'::text])`)
@Check('prices_model_check', `"model" = ANY (ARRAY['standard'::text, 'graduated'::text, 'volume'::text, 'package'::text, 'seat'::text])`)
@Check('prices_quantity_type_check', `"quantity_type" = ANY (ARRAY['fixed'::text, 'metered'::text])`)
@Check('prices_status_check', `"status" = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])`)
@Check(
	'prices_contract_owner_check',
	`("owner" = 'contract' AND "contract_id" IS NOT NULL AND "quote_id" IS NULL) OR ("owner" = 'catalog' AND "contract_id" IS NULL AND "quote_id" IS NULL) OR ("owner" = 'quote' AND "quote_id" IS NOT NULL AND "contract_id" IS NULL)`
)
@Check('prices_metered_metric_check', `"quantity_type" = 'fixed' OR "billable_metric_id" IS NOT NULL`)
@Check('prices_cap_minimum_check', `"cap_amount" IS NULL OR "minimum_amount" IS NULL OR "cap_amount" >= "minimum_amount"`)
@Check('prices_invoice_line_mode_check', `"invoice_line_mode" = ANY (ARRAY['single'::text, 'per_tier'::text])`)
export class Price {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'prices_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', comment: 'catalog, contract o quote. Etapa 1 escribe contract (precio inline del ítem); Cotizaciones v2 escribe quote' })
	owner: PriceOwner;

	@Column({ type: 'uuid', comment: 'El ítem exige producto (S1-12)' })
	product_id: string;

	@Column({ type: 'uuid', nullable: true, comment: 'NOT NULL si owner = contract, NULL si catalog (CHECK)' })
	contract_id?: string | null;

	@Column({
		type: 'uuid',
		nullable: true,
		comment: 'Cotizaciones v2: NOT NULL si owner = quote (precio inline del ítem de cotización), NULL si no (CHECK)',
	})
	quote_id?: string | null;

	@Column({ type: 'text', comment: 'Etiqueta ("Tramos LatAm — UF"); para contract default = nombre del producto' })
	name: string;

	@Column({ type: 'text', comment: 'Moneda del contrato (S1-2); en catálogo, la del precio' })
	currency: string;

	@Column({ type: 'text', comment: 'standard, graduated, volume, package o seat' })
	model: PriceModel;

	@Column({ type: 'text', comment: 'fixed o metered; metered exige billable_metric_id' })
	quantity_type: PriceQuantityType;

	@Column({ type: 'uuid', nullable: true })
	billable_metric_id?: string | null;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, comment: 'standard y seat: precio por unidad del período (no mensual)' })
	unit_amount?: number | null;

	@Column({ type: 'jsonb', nullable: true, comment: 'graduated/volume: [{from, to, per_unit_amount, flat_amount}]' })
	tiers?: PriceTierRow[] | null;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, comment: 'package: bloque de N unidades' })
	package_size?: number | null;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, comment: 'package: precio del bloque' })
	package_amount?: number | null;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, default: 0, comment: 'seat: asientos mínimos cobrados' })
	seat_minimum_quantity?: number | null;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, default: 0, comment: 'Unidades gratis por período' })
	free_units?: number | null;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, comment: 'Mínimo comprometido por período con true-up; NULL = sin mínimo' })
	minimum_amount?: number | null;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, comment: 'Tope máximo por período; NULL = sin tope' })
	cap_amount?: number | null;

	@Column({
		type: 'text',
		default: 'single',
		comment: 'Presentación en la factura (spec §3.8): single = una línea con el detalle en la glosa; per_tier = una línea por tramo más ajustes',
	})
	invoice_line_mode: InvoiceLineMode;

	@Column({
		type: 'boolean',
		default: false,
		comment: 'graduated/volume: cobrar el cargo fijo del tramo aunque todo el consumo caiga en unidades gratis (spec §3.5, pregunta 5)',
	})
	charge_flat_when_free: boolean;

	@Column({ type: 'text', default: 'active', comment: 'draft, active o archived; contract nace active' })
	status: PriceStatus;

	@Column({ type: 'integer', default: 1, comment: 'Sube con cada supersedes_price_id' })
	version: number;

	@Column({ type: 'uuid', nullable: true, comment: 'Versión anterior' })
	supersedes_price_id?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'En owner = contract, el precio de catálogo del que salió (etapa 3). NULL en precios inline' })
	list_price_id?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Catálogo: nota interna de la versión (qué cambió, para quién aplica)' })
	notes?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@Column({ type: 'uuid', nullable: true })
	updated_by?: string | null;

	@Column({ type: 'timestamp with time zone', nullable: true })
	published_at?: Date | null;

	@Column({ type: 'timestamp with time zone', nullable: true })
	archived_at?: Date | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Product)
	@JoinColumn({ name: 'product_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_product_id_fkey' })
	product?: Product;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_contract_id_fkey' })
	contract?: Contract;

	@ManyToOne(() => Quote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'quote_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_quote_id_fkey' })
	quote?: Quote;

	@ManyToOne(() => BillableMetric)
	@JoinColumn({ name: 'billable_metric_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_billable_metric_id_fkey' })
	billableMetric?: BillableMetric;

	@ManyToOne(() => Price)
	@JoinColumn({ name: 'supersedes_price_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_supersedes_price_id_fkey' })
	supersedes?: Price;

	@ManyToOne(() => Price)
	@JoinColumn({ name: 'list_price_id', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_list_price_id_fkey' })
	listPrice?: Price;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_created_by_fkey' })
	createdBy?: User;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'prices_updated_by_fkey' })
	updatedBy?: User;
}
