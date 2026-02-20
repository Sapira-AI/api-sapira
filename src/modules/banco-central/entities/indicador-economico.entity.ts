import { Column, Entity, Index } from 'typeorm';

import { BaseEntity } from '@/databases/postgresql/entities/base.entity';

@Entity('indicadores_economicos')
@Index(['codigo', 'fecha'], { unique: true })
export class IndicadorEconomicoEntity extends BaseEntity {
	@Column({ type: 'varchar', length: 100 })
	codigo: string;

	@Column({ type: 'varchar', length: 255 })
	nombre: string;

	@Column({ type: 'date' })
	fecha: Date;

	@Column({ type: 'decimal', precision: 18, scale: 6 })
	valor: number;

	@Column({ type: 'varchar', length: 50, nullable: true })
	unidad?: string;

	@Column({ type: 'varchar', length: 20, default: 'OK' })
	status_code: string;
}
