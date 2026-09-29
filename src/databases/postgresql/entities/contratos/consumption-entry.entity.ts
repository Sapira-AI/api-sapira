import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { ContractItem } from '@/databases/postgresql/entities/contratos/contract-item.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

/** Origen de la fila de consumo. */
export const CONSUMPTION_SOURCES = ['manual', 'csv', 'dwh', 'api'] as const;
export type ConsumptionSource = (typeof CONSUMPTION_SOURCES)[number];

/**
 * `consumption_entries` — el consumo de un ítem en un período de servicio (Pricing v2,
 * `docs/v2-rediseno/spec-pricing-v2.md` §2.3). Reemplaza a `quantities` para los contratos v2; una fila vigente por ítem
 * y período (UNIQUE), cada corrección sube `revision` y deja su rastro en `consumption_entry_revisions`.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790630000000-CreatePricingV2`. RLS por
 * holding con `rls/holding_access_consumption_entries.sql`.
 */
@Entity({
	name: 'consumption_entries',
	comment:
		'Consumo vigente de un ítem por período de servicio (reemplaza quantities en Contratos v2); las correcciones quedan en consumption_entry_revisions',
})
@Unique('consumption_entries_contract_item_id_period_start_key', ['contract_item_id', 'period_start'])
@Index('idx_consumption_entries_idempotency', ['holding_id', 'idempotency_key'], { unique: true, where: 'idempotency_key IS NOT NULL' })
@Index('idx_consumption_entries_contract_period', ['contract_id', 'period_start'])
@Index('idx_consumption_entries_holding_id', ['holding_id'])
@Index('idx_consumption_entries_invoice_id', ['invoice_id'], { where: 'invoice_id IS NOT NULL' })
@Check('consumption_entries_quantity_check', `"quantity" >= 0`)
@Check('consumption_entries_period_check', `"period_end" >= "period_start"`)
@Check('consumption_entries_source_check', `"source" = ANY (ARRAY['manual'::text, 'csv'::text, 'dwh'::text, 'api'::text])`)
export class ConsumptionEntry {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'consumption_entries_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	contract_id: string;

	@Column({ type: 'uuid' })
	contract_item_id: string;

	@Column({ type: 'date', comment: 'Inicio del período de servicio de la línea que alimenta (= invoice_items.billing_period_start)' })
	period_start: Date;

	@Column({ type: 'date', comment: 'Fin del período de servicio de la línea (= invoice_items.billing_period_end)' })
	period_end: Date;

	@Column({ type: 'numeric', precision: 18, scale: 6, comment: '0 = sin consumo: la línea queda en 0 (nunca cobra la cantidad base)' })
	quantity: number;

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 2,
		nullable: true,
		comment: 'Monto final informado por el cliente; si viene, la línea usa este monto y quantity queda informativa',
	})
	amount_override?: number | null;

	@Column({ type: 'boolean', default: true, comment: 'El descuento del ítem se aplica sobre el consumo (S7-9)' })
	apply_item_discount: boolean;

	@Column({ type: 'text', nullable: true, comment: 'Cuenta del período si difiere de la del ítem' })
	account?: string | null;

	@Column({ type: 'boolean', default: false, comment: 'true = fila estimada al cierre; se reemplaza al llegar el real' })
	is_estimated: boolean;

	@Column({ type: 'text', default: 'manual', comment: 'manual, csv, dwh o api' })
	source: ConsumptionSource;

	@Column({ type: 'text', nullable: true, comment: 'El DWH y la API reenvían sin duplicar (único por holding)' })
	idempotency_key?: string | null;

	@Column({ type: 'integer', default: 1, comment: 'Sube en cada corrección' })
	revision: number;

	@Column({ type: 'text', nullable: true, comment: 'Motivo obligatorio desde la revisión 2' })
	correction_reason?: string | null;

	@Column({ type: 'text', nullable: true })
	notes?: string | null;

	@Column({
		type: 'uuid',
		nullable: true,
		comment:
			'Factura que lleva este consumo: la Por Emitir recalculada, la complementaria (consumo adicional) o la reemitida (spec §4.4). NULL si el período solo tenía facturas anuladas',
	})
	invoice_id?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@Column({ type: 'uuid', nullable: true })
	updated_by?: string | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entries_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entries_contract_id_fkey' })
	contract?: Contract;

	@ManyToOne(() => ContractItem, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entries_contract_item_id_fkey' })
	contractItem?: ContractItem;

	@ManyToOne(() => Invoice, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entries_invoice_id_fkey' })
	invoice?: Invoice;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entries_created_by_fkey' })
	createdBy?: User;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entries_updated_by_fkey' })
	updatedBy?: User;
}
