import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

/** Estado de la regla: se pausa, nunca se borra. */
export const INVOICE_CONSOLIDATION_RULE_STATUSES = ['active', 'paused'] as const;
export type InvoiceConsolidationRuleStatus = (typeof INVOICE_CONSOLIDATION_RULE_STATUSES)[number];

/**
 * `invoice_consolidation_rules` — unificación recurrente de facturas de una razón social (Razón social 360,
 * `docs/v2-rediseno/spec-unificacion-recurrente.md`): qué contratos se facturan en un solo documento cada mes y cuál es el principal
 * (fecha de emisión y encabezado). Una regla por razón social. El estado por mes no se guarda: se deriva de las Por Emitir y de los
 * eventos `INVOICE_CONSOLIDATED` (metadata `rule_id`).
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1791800000000-CreateInvoiceConsolidationRules`. RLS por
 * holding con `rls/holding_access_invoice_consolidation_rules.sql`.
 */
@Entity({
	name: 'invoice_consolidation_rules',
	comment:
		'Unificación recurrente de facturas de una razón social: contratos que se facturan en un solo documento cada mes y su contrato principal',
})
@Unique('invoice_consolidation_rules_holding_id_client_entity_id_key', ['holding_id', 'client_entity_id'])
@Index('idx_invoice_consolidation_rules_holding_status', ['holding_id', 'status'])
@Check('invoice_consolidation_rules_contract_ids_check', `cardinality("contract_ids") >= 2`)
@Check('invoice_consolidation_rules_status_check', `"status" = ANY (ARRAY['active'::text, 'paused'::text])`)
export class InvoiceConsolidationRule {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_consolidation_rules_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid', comment: 'Razón social receptora de las facturas unificadas' })
	client_entity_id: string;

	@Column({ type: 'uuid', comment: 'Contrato principal: la unificada se emite en la fecha de su factura del mes y lleva su encabezado' })
	main_contract_id: string;

	@Column({ type: 'uuid', array: true, comment: 'Contratos que se unifican (incluye al principal; 2 o más)' })
	contract_ids: string[];

	@Column({ type: 'text', default: 'active', comment: 'active o paused (la regla se pausa, nunca se borra)' })
	status: InvoiceConsolidationRuleStatus;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@Column({ type: 'uuid', nullable: true })
	updated_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_consolidation_rules_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => ClientEntity, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'client_entity_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'invoice_consolidation_rules_client_entity_id_fkey',
	})
	clientEntity?: ClientEntity;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'main_contract_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'invoice_consolidation_rules_main_contract_id_fkey',
	})
	mainContract?: Contract;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_consolidation_rules_created_by_fkey' })
	createdBy?: User;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_consolidation_rules_updated_by_fkey' })
	updatedBy?: User;
}
