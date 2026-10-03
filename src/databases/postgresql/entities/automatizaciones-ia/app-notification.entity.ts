import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { AppNotificationRecipient } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification-recipient.entity';
import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

export type AppNotificationSeverity = 'info' | 'warning' | 'error';
export type AppNotificationStatus = 'open' | 'resolved';

@Check('app_notifications_severity_check', `((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text])))`)
@Check('app_notifications_status_check', `((status = ANY (ARRAY['open'::text, 'resolved'::text])))`)
@Index('app_notifications_open_deduplication_key_idx', ['holding_id', 'deduplication_key'], {
	unique: true,
	where: `((status = 'open'::text) AND (deduplication_key IS NOT NULL))`,
})
@Index('app_notifications_holding_resource_created_idx', { synchronize: false })
@Index('app_notifications_holding_status_created_idx', { synchronize: false })
@Index('app_notifications_holding_company_idx', ['holding_id', 'company_id'])
@Entity('app_notifications')
export class AppNotification {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'app_notifications_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	source!: string;

	@Column({ type: 'text' })
	type!: string;

	@Column({ type: 'text', default: 'error' })
	severity!: AppNotificationSeverity;

	@Column({ type: 'text' })
	title!: string;

	@Column({ type: 'text' })
	message!: string;

	@Column({ type: 'text', nullable: true })
	recommendation?: string | null;

	@Column({ type: 'text', nullable: true })
	action_type?: string | null;

	// `default: {}` es la única forma que TypeORM reconoce como igual a `'{}'::jsonb`;
	// con `default: () => "'{}'::jsonb"` compara los textos y siempre difiere.
	@Column({ type: 'jsonb', default: {} })
	action_payload!: Record<string, unknown>;

	@Column({ type: 'jsonb', default: {} })
	metadata!: Record<string, unknown>;

	@Column({ type: 'text', nullable: true })
	deduplication_key?: string | null;

	@Column({ type: 'text', nullable: true })
	resource_type?: string | null;

	@Column({ type: 'uuid', nullable: true })
	resource_id?: string | null;

	/** Compañía de la alerta (factura, contrato; N4 `1790900000000-NotificationsPhase2`). NULL = sin compañía: la ve todo destinatario. */
	@Column({ type: 'uuid', nullable: true, comment: 'Compañía de la alerta (factura, contrato). NULL = sin compañía: la ve todo destinatario' })
	company_id?: string | null;

	@Column({ type: 'text', default: 'open' })
	status!: AppNotificationStatus;

	@Column({ type: 'timestamp with time zone', nullable: true })
	resolved_at?: Date | null;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	updated_at!: Date;

	@OneToMany(() => AppNotificationRecipient, (recipient) => recipient.notification)
	recipients!: AppNotificationRecipient[];

	@ManyToOne(() => Company, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'app_notifications_company_id_fkey' })
	company?: Company | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'app_notifications_holding_id_fkey' })
	holding?: CompanyHolding;
}
