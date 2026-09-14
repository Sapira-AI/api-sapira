import { Column, Entity, Index, Unique } from 'typeorm';

import { BaseEntity } from '@/databases/postgresql/entities/base.entity';

@Index('idx_indicadores_economicos_codigo', ['codigo'])
@Index('idx_indicadores_economicos_fecha', ['fecha'])
@Entity('indicadores_economicos')
@Unique('uq_indicadores_economicos_codigo_fecha', ['codigo', 'fecha'])
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

	@Column({ type: 'varchar', length: 20, nullable: true, default: 'OK' })
	status_code: string;
}
