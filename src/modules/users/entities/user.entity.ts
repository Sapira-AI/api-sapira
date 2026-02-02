import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('users')
export class User {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'text', nullable: false, unique: true })
	email: string;

	@Column({ type: 'uuid', nullable: true })
	role_id?: string;

	@Column({ type: 'text', nullable: true, default: 'Pendiente' })
	status?: string;

	@Column({ type: 'timestamp', nullable: true })
	last_access?: Date;

	@Column({ type: 'text', nullable: true })
	auth_provider?: string;

	@Column({ type: 'uuid', nullable: true })
	auth_id?: string;

	@CreateDateColumn({ type: 'timestamp', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_super_admin?: boolean;
}
