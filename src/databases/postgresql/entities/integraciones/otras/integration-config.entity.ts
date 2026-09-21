import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.integration_configs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_integration_configs (DELETE, authenticated); tenant_isolation_insert_integration_configs (INSERT, authenticated); tenant_isolation_select_integration_configs (SELECT, authenticated); tenant_isolation_update_integration_configs (UPDATE, authenticated).
 */
@Entity('integration_configs')
@Check('integration_configs_status_check', "status = ANY (ARRAY['Connected'::text, 'Disconnected'::text, 'Error'::text])")
@Index('idx_integration_configs_holding_id', ['holding_id'])
export class IntegrationConfig {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'integration_configs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'text', nullable: true })
	service_name?: string;

	@Column({ type: 'text', nullable: true, default: 'Disconnected' })
	status?: string;

	@Column({ type: 'timestamp without time zone', nullable: true })
	last_sync_at?: Date;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_integration_configs_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'integration_configs_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}
