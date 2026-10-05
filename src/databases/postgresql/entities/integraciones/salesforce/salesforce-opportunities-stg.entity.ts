import { Check, Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Unique('salesforce_opportunities_stg_unique', ['holding_id', 'salesforce_id'])
@Check(
	'salesforce_opportunities_stg_status_check',
	`(((processing_status IS NULL) OR (processing_status = ANY (ARRAY['create'::text, 'update'::text, 'processed'::text, 'error'::text]))))`
)
@Index('idx_salesforce_opportunities_stg_account', ['holding_id', 'salesforce_account_id'])
@Index('idx_salesforce_opportunities_stg_holding_status', ['holding_id', 'processing_status'])
@Entity('salesforce_opportunities_stg')
export class SalesforceOpportunitiesStg {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_opportunities_stg_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	salesforce_id!: string;

	@Column({ type: 'text', nullable: true })
	salesforce_name?: string | null;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id?: string | null;

	@Column({ type: 'jsonb' })
	raw_data!: Record<string, any>;

	@Column({ type: 'text', nullable: true, default: 'create' })
	processing_status?: string | null;

	@Column({ type: 'text', nullable: true })
	source_hash?: string | null;

	@Column({ type: 'text', nullable: true })
	error_message?: string | null;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string | null;

	@Column({ type: 'uuid', nullable: true })
	batch_id?: string | null;

	@Column({ type: 'uuid', nullable: true })
	sync_session_id?: string | null;

	@Column({ type: 'timestamptz', nullable: true })
	processed_at?: Date | null;

	@Column({ type: 'timestamptz', nullable: true })
	last_integrated_at?: Date | null;

	/**
	 * Cotizaciones protegidas (`1791100000000-CrmQuoteSnapshot`): lo que llegó del CRM la última vez que la oportunidad se importó a
	 * Sapira (encabezado mapeado + ítems, `utils/crm-quote-snapshot.ts`). Un cambio real es lo que llega ahora distinto de esto.
	 */
	@Column({
		type: 'jsonb',
		nullable: true,
		comment: 'Lo que llegó del CRM en la última importación a Sapira (encabezado mapeado + ítems). Base para detectar cambios reales del CRM',
	})
	last_imported_snapshot?: Record<string, any> | null;

	@Column({
		type: 'timestamptz',
		nullable: true,
		comment: 'Cuándo se guardó last_imported_snapshot al crear o actualizar la cotización (NULL: base tomada al traer, sin importar)',
	})
	last_imported_at?: Date | null;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at!: Date;
}
