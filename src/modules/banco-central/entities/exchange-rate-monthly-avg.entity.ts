import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('exchange_rates_monthly_avg')
@Index(['from_currency', 'to_currency', 'year', 'month'], { unique: true })
export class ExchangeRateMonthlyAvgEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'varchar', length: 3 })
	from_currency: string;

	@Column({ type: 'varchar', length: 3 })
	to_currency: string;

	@Column({ type: 'integer' })
	year: number;

	@Column({ type: 'integer' })
	month: number;

	@Column({ type: 'numeric', precision: 20, scale: 8 })
	avg_rate: number;

	@Column({ type: 'numeric', precision: 20, scale: 8 })
	min_rate: number;

	@Column({ type: 'numeric', precision: 20, scale: 8 })
	max_rate: number;

	@Column({ type: 'integer' })
	data_points: number;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	calculated_at: Date;
}
