import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

/**
 * Espejo de `public.salesforce_sync_logs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Registro de sincronizaciones automáticas de Salesforce
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): Users can view sync logs from their holding (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_salesforce_sync_logs_created_at ON public.salesforce_sync_logs USING btree (created_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_salesforce_sync_logs_sync_date ON public.salesforce_sync_logs USING btree (sync_date DESC)
 */
@Entity('salesforce_sync_logs')
@Index('idx_salesforce_sync_logs_holding_id', ['holding_id'])
export class SalesforceSyncLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_sync_logs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	/** Fecha de los datos sincronizados (no la fecha de ejecución) */
	@Column({ type: 'date', nullable: false, default: () => 'CURRENT_DATE' })
	sync_date: Date;

	/** Número de oportunidades encontradas en la sincronización */
	@Column({ type: 'integer', nullable: true, default: 0 })
	opportunities_count?: number;

	@Column({ type: 'integer', nullable: true, default: 0 })
	accounts_count?: number;

	@Column({ type: 'boolean', nullable: true, default: false })
	success?: boolean;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	/** Tiempo de ejecución en milisegundos */
	@Column({ type: 'integer', nullable: true })
	execution_time_ms?: number;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_sync_logs_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
