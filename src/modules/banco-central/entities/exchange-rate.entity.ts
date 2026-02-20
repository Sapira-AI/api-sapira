import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('exchange_rates')
@Index(['rate_date', 'from_currency', 'to_currency'], { unique: true })
export class ExchangeRateEntity {
	@PrimaryColumn({ type: 'date' })
	rate_date: Date;

	@PrimaryColumn({ type: 'varchar', length: 3 })
	from_currency: string;

	@PrimaryColumn({ type: 'varchar', length: 3 })
	to_currency: string;

	@Column({ type: 'numeric', precision: 20, scale: 8 })
	rate: number;

	@Column({ type: 'varchar', length: 50, default: 'BANCOCENTRAL' })
	source_type: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	api_source?: string;

	@Column({ type: 'boolean', default: false })
	is_indirect_conversion: boolean;

	@Column({ type: 'jsonb', nullable: true })
	conversion_chain?: Record<string, any>;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at: Date;
}
