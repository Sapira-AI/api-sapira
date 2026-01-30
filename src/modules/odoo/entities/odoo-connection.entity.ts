import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('odoo_connections')
export class OdooConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	user_id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', nullable: false })
	url: string;

	@Column({ type: 'text', nullable: false })
	api_key: string;

	@Column({ type: 'text', nullable: false })
	database_name: string;

	@Column({ type: 'text', nullable: true })
	subscription_code?: string;

	@Column({ type: 'text', nullable: true })
	username?: string;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_sync_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;
}
