import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('stripe_connections_mode_check', `((mode = ANY (ARRAY['test'::text, 'live'::text])))`)
@Index('idx_stripe_connections_holding_id', ['holding_id'])
@Index('idx_stripe_connections_is_active', ['is_active'])
@Index('idx_stripe_connections_user_id', ['user_id'])
@Entity({ name: 'stripe_connections', comment: 'Almacena las credenciales de conexión a Stripe por holding' })
export class StripeConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	user_id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', comment: 'Secret Key de Stripe (debe estar encriptada en producción)' })
	secret_key: string;

	@Column({ type: 'text', nullable: true })
	publishable_key?: string;

	@Column({ type: 'text', default: 'test', comment: 'Modo de operación: test o live' })
	mode: string; // 'test' o 'live'

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_sync_at?: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;
}
