import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { CompanyHolding } from './company-holding.entity';

@Entity('user_holdings')
export class UserHolding {
	@PrimaryColumn({ type: 'uuid' })
	user_id: string;

	@PrimaryColumn({ type: 'uuid' })
	holding_id: string;

	@CreateDateColumn({ type: 'timestamp', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'boolean', default: false })
	selected: boolean;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@ManyToOne(() => CompanyHolding, (holding) => holding.userHoldings)
	@JoinColumn({ name: 'holding_id' })
	holding: CompanyHolding;
}
