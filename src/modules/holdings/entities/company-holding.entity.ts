import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { UserHolding } from './user-holding.entity';

@Entity('company_holdings')
export class CompanyHolding {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', nullable: true })
	website?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	logo_url?: string;

	@CreateDateColumn({ type: 'timestamp', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'boolean', nullable: true, default: false })
	manual_status_change_enabled?: boolean;

	@OneToMany(() => UserHolding, (userHolding) => userHolding.holding)
	userHoldings: UserHolding[];
}
