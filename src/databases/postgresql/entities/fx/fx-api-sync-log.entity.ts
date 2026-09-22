import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.fx_api_sync_log` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 3 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Log de sincronizaciones de tipos de cambio desde APIs externas
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): tenant_isolation_insert_fx_api_sync_log (INSERT, public); tenant_isolation_select_fx_api_sync_log (SELECT, public).
 */
@Entity({ name: 'fx_api_sync_log', comment: 'Log de sincronizaciones de tipos de cambio desde APIs externas' })
@Check('fx_api_sync_log_status_check', "status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text, 'pending'::text])")
export class FxApiSyncLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'fx_api_sync_log_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'date', nullable: false })
	sync_date: Date;

	@Column({ type: 'text', nullable: false })
	api_source: string;

	@Column({ type: 'text', array: true, nullable: true, default: '{}' })
	currencies_synced?: string[];

	@Column({ type: 'integer', nullable: true, default: 0 })
	records_created?: number;

	@Column({ type: 'integer', nullable: true, default: 0 })
	records_updated?: number;

	@Column({ type: 'text', nullable: false, default: 'pending' })
	status: string;

	@Column({ type: 'jsonb', nullable: true })
	error_details?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fx_api_sync_log_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
