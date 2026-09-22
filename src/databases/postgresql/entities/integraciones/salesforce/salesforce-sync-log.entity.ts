import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.salesforce_sync_logs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Registro de sincronizaciones automáticas de Salesforce
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): Users can view sync logs from their holding (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_salesforce_sync_logs_created_at ON public.salesforce_sync_logs USING btree (created_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_salesforce_sync_logs_sync_date ON public.salesforce_sync_logs USING btree (sync_date DESC)
 */
@Entity({ name: 'salesforce_sync_logs', comment: 'Registro de sincronizaciones automáticas de Salesforce' })
@Index('idx_salesforce_sync_logs_holding_id', ['holding_id'])
export class SalesforceSyncLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_sync_logs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	/** Fecha de los datos sincronizados (no la fecha de ejecución) */
	@Column({ type: 'date', comment: 'Fecha de los datos sincronizados (no la fecha de ejecución)', nullable: false, default: () => 'CURRENT_DATE' })
	sync_date: Date;

	/** Número de oportunidades encontradas en la sincronización */
	@Column({ type: 'integer', comment: 'Número de oportunidades encontradas en la sincronización', nullable: true, default: 0 })
	opportunities_count?: number;

	@Column({ type: 'integer', nullable: true, default: 0 })
	accounts_count?: number;

	@Column({ type: 'boolean', nullable: true, default: false })
	success?: boolean;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	/** Tiempo de ejecución en milisegundos */
	@Column({ type: 'integer', comment: 'Tiempo de ejecución en milisegundos', nullable: true })
	execution_time_ms?: number;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_sync_logs_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
