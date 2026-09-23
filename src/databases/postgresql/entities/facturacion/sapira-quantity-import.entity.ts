import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ContractItem } from '@/databases/postgresql/entities/contratos/contract-item.entity';
import { Quantity } from '@/databases/postgresql/entities/facturacion/quantity.entity';

/**
 * Estados posibles de una fila importada desde el DWH hacia `quantities`.
 *
 * `unmapped` y `blocked` son los dos estados que se resuelven solos con el tiempo
 * (cuando se puebla `contract_items.quote_item_number`, o cuando se anula la factura
 * del período), por eso existe el endpoint de reproceso.
 */
export const QUANTITY_IMPORT_STATUSES = [
	'pending',
	'integrated',
	'no_quantity_data',
	'unmapped',
	'not_variable',
	'currency_mismatch',
	'blocked',
	'ambiguous',
	'conflict',
	'changed_in_source',
] as const;

export type QuantityImportStatus = (typeof QUANTITY_IMPORT_STATUSES)[number];

export type QuantityImportResolutionSource = 'sapira_ids' | 'salesforce_ids';

/**
 * Tabla intermedia del canal automático `datawarehouse-a2e2.finance.sapira_base` → `public.quantities`.
 *
 * NO es un espejo de una tabla preexistente: es una tabla propia de api-sapira, por eso el
 * archivo termina en `.entity.ts` y se autoregistra por el glob de `database.module.ts`.
 *
 * Guarda TODA fila que llega del DWH junto con el resultado de su mapeo, de modo que se pueda
 * auditar por qué una fila no se integró y reprocesarla sin volver a consultar BigQuery.
 * Clave natural: (holding_id, sf_id, billing_date, product, coalesce(quote_line_id, '')).
 *
 * Cumple los dos roles del canal DWH con una sola consulta a BigQuery por holding:
 *  1. Cola de integración hacia `quantities` (vía `integration_status`).
 *  2. Detección de cambios en el origen (vía `source_hash`), que antes hacía `sapira_base_records`.
 *     Por eso guarda también campos que no se integran (`country`, `entity_name`, `tin`) y las filas
 *     sin datos de cantidad, que quedan en `no_quantity_data` solo para vigilarlas.
 *
 * A diferencia de la tabla que reemplazó, los numéricos se castean: el `source_hash` se calcula
 * sobre los valores parseados, así que `0.050` y `0.05` no generan un diff falso.
 */
@Index('sapira_quantity_imports_source_key', { synchronize: false })
@Entity({
	name: 'sapira_quantity_imports',
	comment:
		'Tabla intermedia del canal automático DWH → quantities. Registra cada fila de finance.sapira_base con el resultado de su mapeo (integration_status) para auditoría y reproceso sin re-consultar BigQuery.',
})
@Index('sapira_quantity_imports_status_idx', ['holding_id', 'integration_status'])
@Index('sapira_quantity_imports_period_idx', ['period'])
@Index('sapira_quantity_imports_item_idx', ['resolved_contract_item_id'])
@Index('sapira_quantity_imports_quantity_idx', ['quantity_id'])
@Check(
	'sapira_quantity_imports_status_check',
	`"integration_status" = ANY (ARRAY['pending'::text, 'integrated'::text, 'no_quantity_data'::text, 'unmapped'::text, 'not_variable'::text, 'currency_mismatch'::text, 'blocked'::text, 'ambiguous'::text, 'conflict'::text, 'changed_in_source'::text])`
)
@Check(
	'sapira_quantity_imports_resolution_source_check',
	`"resolution_source" IS NULL OR "resolution_source" = ANY (ARRAY['sapira_ids'::text, 'salesforce_ids'::text])`
)
@Check('sapira_quantity_imports_period_check', `"period" = (date_trunc('month'::text, ("period")::timestamp with time zone))::date`)
export class SapiraQuantityImport {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_sapira_quantity_imports' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	// Clave natural del origen
	@Column({ type: 'text' })
	sf_id: string;

	@Column({ type: 'date' })
	billing_date: string;

	@Column({ type: 'text' })
	product: string;

	// Payload del DWH: normalizado (parseado / truncado) pero sin interpretar.
	// A diferencia de sapira_base_records, acá los numéricos sí se castean porque
	// esta tabla alimenta directamente a quantities, que es numérica.

	/** `billing_date` truncado al primer día del mes (YYYY-MM-01). */
	@Column({ type: 'date' })
	period: string;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	quantity?: string | null;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	unit_price?: string | null;

	/** `unit` del DWH, truncado a 32 caracteres (límite de `quantities.unit_of_measure`). */
	@Column({ type: 'varchar', length: 32, nullable: true })
	unit_of_measure?: string | null;

	@Column({ type: 'text', nullable: true })
	account?: string | null;

	/** Moneda del DWH. `quantities` no tiene columna de moneda: se usa solo como guard. */
	@Column({ type: 'text', nullable: true })
	currency?: string | null;

	/** Derivado en el origen (quantity × unit_price). No se propaga a `quantities.amount`. */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	gross_local_amount?: string | null;

	@Column({ type: 'text', nullable: true })
	business_name?: string | null;

	// Campos que no se integran a quantities: existen solo para la detección de cambios
	// en el origen (rol heredado de sapira_base_records).

	@Column({ type: 'text', nullable: true })
	entity_name?: string | null;

	@Column({ type: 'text', nullable: true })
	tin?: string | null;

	@Column({ type: 'text', nullable: true })
	country?: string | null;

	/** Campo `status` del DWH (ej. 'RECURRENTE'). No indica variabilidad. */
	@Column({ type: 'text', nullable: true })
	dwh_status?: string | null;

	// Los cuatro IDs de mapeo, tal como llegan del DWH
	@Column({ type: 'text', nullable: true })
	sapira_contract_id?: string | null;

	@Column({ type: 'text', nullable: true })
	sapira_contract_item_id?: string | null;

	@Column({ type: 'text', nullable: true })
	quote_line_id?: string | null;

	@Column({ type: 'text', nullable: true })
	opportunity_id?: string | null;

	// Resultado del mapeo (lo escribe la fase 2)
	@Column({ type: 'uuid', nullable: true })
	resolved_contract_item_id?: string | null;

	@Column({ type: 'uuid', nullable: true })
	resolved_contract_id?: string | null;

	@Column({
		type: 'text',
		nullable: true,
		comment:
			'Cómo se resolvió contract_item_id: sapira_ids (IDs Sapira del DWH) o salesforce_ids (quote_line_id → contract_items.quote_item_number).',
	})
	resolution_source?: QuantityImportResolutionSource | null;

	@Column({
		type: 'text',
		default: 'pending',
		comment:
			'pending | integrated | no_quantity_data | unmapped | not_variable | currency_mismatch | blocked | ambiguous | conflict | changed_in_source',
	})
	integration_status: QuantityImportStatus;

	/** Motivo legible del estado; para `blocked` guarda el mensaje de Postgres. */
	@Column({ type: 'text', nullable: true })
	integration_reason?: string | null;

	/** FK a la fila de `quantities` creada. Vínculo de trazabilidad DWH ↔ quantities. */
	@Column({
		type: 'uuid',
		nullable: true,
		comment: 'FK a la fila de quantities creada por esta importación. Es el vínculo de trazabilidad DWH ↔ quantities.',
	})
	quantity_id?: string | null;

	/** SHA-256 del payload comparable: detecta cambios del DWH entre corridas. */
	@Column({ type: 'text' })
	source_hash: string;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	synced_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	integrated_at?: Date | null;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'sapira_quantity_imports_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => ContractItem, { onDelete: 'SET NULL' })
	@JoinColumn({
		name: 'resolved_contract_item_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'sapira_quantity_imports_contract_item_id_fkey',
	})
	resolved_contract_item?: ContractItem;

	@ManyToOne(() => Quantity, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'quantity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'sapira_quantity_imports_quantity_id_fkey' })
	// `quantity` ya es una columna de la tabla, así que la relación lleva sufijo.
	quantity_ref?: Quantity;
}
