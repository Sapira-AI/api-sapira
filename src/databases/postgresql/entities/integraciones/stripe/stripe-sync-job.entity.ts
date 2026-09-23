import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Index('idx_stripe_sync_jobs_holding_id', ['holding_id'])
@Index('idx_stripe_sync_jobs_status', ['status'])
@Index('idx_stripe_sync_jobs_created_at', { synchronize: false })
@Entity({ name: 'stripe_sync_jobs', comment: 'Tabla para trackear el progreso de jobs de sincronización de Stripe a Sapira' })
export class StripeSyncJob {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false, default: 'running', comment: 'Estado del job: running, completed, failed' })
	status: string;

	@Column({ type: 'jsonb', nullable: true, comment: 'Progreso actual del job con contadores por entidad' })
	progress: any;

	@Column({ type: 'jsonb', nullable: true, comment: 'Estadísticas finales del job' })
	stats: any;

	@Column({ type: 'jsonb', nullable: true, comment: 'Array de errores encontrados durante la sincronización' })
	errors: any;

	@Column({ type: 'text', nullable: true })
	error_message: string;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	completed_at: Date;
}
