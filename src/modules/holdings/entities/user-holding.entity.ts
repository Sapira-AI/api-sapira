import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import { CompanyHolding } from './company-holding.entity';

@Index('idx_user_holdings_holding_id', ['holding_id'])
@Index('idx_user_holdings_one_selected_per_user', ['user_id'], { unique: true, where: `(selected = true)` })
@Index('idx_user_holdings_selected', ['user_id', 'selected'], { where: `(selected = true)` })
@Index('idx_user_holdings_user_id', ['user_id'])
@Entity('user_holdings')
export class UserHolding {
	@PrimaryColumn({ type: 'uuid' })
	user_id: string;

	@PrimaryColumn({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({
		type: 'boolean',
		default: false,
		comment: 'Indicates if this is the currently selected holding for the user',
	})
	selected: boolean;

	@Column({
		type: 'boolean',
		default: true,
		comment: 'Indicates if the user access to this holding is active',
	})
	is_active: boolean;

	@ManyToOne(() => CompanyHolding, (holding) => holding.userHoldings, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'holding_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'user_holdings_holding_id_fkey',
	})
	holding: CompanyHolding;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_user_holdings_user_id' })
	user?: User;
}
