import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('company_holdings')
@Index('idx_company_holdings_name', ['name'])
@Index('idx_company_holdings_created_at', ['created_at'])
export class CompanyHolding {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'varchar', length: 255 })
	name!: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	tax_id?: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	legal_name?: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	country?: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	currency?: string;

	@Column({ type: 'boolean', default: true })
	is_active?: boolean;

	@Column({ type: 'jsonb', nullable: true })
	settings?: Record<string, any>;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	// Relaciones - Comentadas porque las relaciones están comentadas en IntegrationLog
	// @OneToMany(() => IntegrationLog, (integrationLog) => integrationLog.holding)
	// integration_logs?: IntegrationLog[];
}
