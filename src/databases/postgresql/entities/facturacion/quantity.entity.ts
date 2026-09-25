import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

import { ContractItem } from '../contratos/contract-item.entity';

/**
 * Entity de `public.quantities` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 252 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Overrides de precio unitario y cantidad por período mensual para contract_items variables. Permite cambios mensuales en precio/cantidad sin alterar el contrato base.
 * Referenciada por FK desde 1 tabla(s): sapira_quantity_imports.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_quantities_set_holding · BEFORE INSERT FOR EACH ROW → quantities_set_holding_from_contract_item(); trg_restore_invoice_items_on_quantity_delete · AFTER DELETE FOR EACH ROW → restore_invoice_items_amounts_on_quantity_delete(); trg_restore_rsm_on_quantity_delete · AFTER DELETE FOR EACH ROW → restore_rsm_on_quantity_delete(); trg_rsm_on_quantity_change · AFTER INSERT OR UPDATE FOR EACH ROW → trigger_rsm_on_quantity_change(); trg_sync_invoice_items_from_quantities · AFTER INSERT OR UPDATE FOR EACH ROW → sync_invoice_items_amounts_from_quantities(); trg_validate_quantity_invoice_status · BEFORE INSERT OR DELETE OR UPDATE FOR EACH ROW → validate_invoice_status_for_quantity_change().
 * Policies (4): quantities_delete (DELETE, public); quantities_insert (INSERT, public); quantities_select (SELECT, public); quantities_update (UPDATE, public).
 */
@Entity({
	name: 'quantities',
	comment:
		'Overrides de precio unitario y cantidad por período mensual para contract_items variables. Permite cambios mensuales en precio/cantidad sin alterar el contrato base.',
})
@Unique('quantities_unique_item_period', ['contract_item_id', 'period'])
@Check('quantities_period_check', "period = (date_trunc('month'::text, (period)::timestamp with time zone))::date")
@Check('quantities_quantity_check', '(quantity IS NULL) OR (quantity >= (0)::numeric)')
@Check('quantities_unit_price_check', '(unit_price IS NULL) OR (unit_price >= (0)::numeric)')
@Index('quantities_contract_item_idx', ['contract_item_id'])
@Index('quantities_holding_idx', ['holding_id'])
@Index('quantities_period_idx', ['period'])
export class Quantity {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'quantities_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_item_id: string;

	/** Holding propietario. Se auto-setea via trigger si es NULL en insert. */
	@Column({ type: 'uuid', comment: 'Holding propietario. Se auto-setea via trigger si es NULL en insert.', nullable: false })
	holding_id: string;

	/** Primer día del mes (YYYY-MM-01). Representa el mes completo. CHECK garantiza normalización. */
	@Column({ type: 'date', comment: 'Primer día del mes (YYYY-MM-01). Representa el mes completo. CHECK garantiza normalización.', nullable: false })
	period: Date;

	/** Override de precio unitario para este período. NULL = usar contract_items.unit_price */
	@Column({
		type: 'numeric',
		precision: 18,
		scale: 6,
		comment: 'Override de precio unitario para este período. NULL = usar contract_items.unit_price',
		nullable: true,
	})
	unit_price?: number;

	@Column({ type: 'varchar', length: 32, nullable: true })
	unit_of_measure?: string;

	/** Override de cantidad para este período. NULL = usar contract_items.quantity. Permite 0 para suspensiones. */
	@Column({
		type: 'numeric',
		precision: 18,
		scale: 6,
		comment: 'Override de cantidad para este período. NULL = usar contract_items.quantity. Permite 0 para suspensiones.',
		nullable: true,
	})
	quantity?: number;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	/** FK directo al contrato. Derivado de contract_items.contract_id. Permite joins y triggers RSM sin pasar por contract_items. */
	@Column({
		type: 'uuid',
		comment: 'FK directo al contrato. Derivado de contract_items.contract_id. Permite joins y triggers RSM sin pasar por contract_items.',
		nullable: true,
	})
	contract_id?: string;

	/** Override del monto reconocido del período en moneda de contrato. Reemplaza el cálculo base (final_price / term_months) en recognized_period_contract_ccy para este mes únicamente. NULL = usar cálculo base del contrato. */
	@Column({
		type: 'numeric',
		precision: 15,
		scale: 2,
		comment:
			'Override del monto reconocido del período en moneda de contrato. Reemplaza el cálculo base (final_price / term_months) en recognized_period_contract_ccy para este mes únicamente. NULL = usar cálculo base del contrato.',
		nullable: true,
	})
	amount?: number;

	/** ID de la Opportunity en Salesforce asociada a este registro de quantities. */
	@Column({ type: 'text', comment: 'ID de la Opportunity en Salesforce asociada a este registro de quantities.', nullable: true })
	salesforce_opportunity_id?: string;

	/** ID del Line Item en Salesforce asociado a este registro de quantities. */
	@Column({ type: 'text', comment: 'ID del Line Item en Salesforce asociado a este registro de quantities.', nullable: true })
	salesforce_line_item_id?: string;

	/**
	 * Cuenta contable proveniente del DWH (campo account_name en finance.sapira).
	 *  Texto libre, se almacena tal como llega del DWH sin mapeo adicional.
	 */
	@Column({
		type: 'text',
		comment:
			'Cuenta contable proveniente del DWH (campo account_name en finance.sapira).\n Texto libre, se almacena tal como llega del DWH sin mapeo adicional.',
		nullable: true,
	})
	account?: string;

	@ManyToOne(() => Contract)
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quantities_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => ContractItem, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quantities_contract_item_id_fkey' })
	contractItem?: ContractItem; // de otro módulo

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'quantities_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quantities_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
