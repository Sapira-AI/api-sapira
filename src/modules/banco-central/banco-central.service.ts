import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GetSeriesDto } from './dtos/get-series.dto';
import { SyncIndicatorsDto } from './dtos/sync-indicators.dto';
import { IndicadorEconomicoEntity } from './entities/indicador-economico.entity';
import { BancoCentralResponse, IndicadorEconomico, IndicadorEconomicoData } from './interfaces/banco-central.interface';

@Injectable()
export class BancoCentralService {
	private readonly logger = new Logger(BancoCentralService.name);
	private readonly baseUrl = 'https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx';
	private readonly user: string;
	private readonly pass: string;

	constructor(
		@InjectRepository(IndicadorEconomicoEntity)
		private readonly indicadorRepository: Repository<IndicadorEconomicoEntity>,
		private readonly configService: ConfigService
	) {
		this.user = this.configService.get<string>('BANCO_CENTRAL_USER');
		this.pass = this.configService.get<string>('BANCO_CENTRAL_PASS');

		if (!this.user || !this.pass) {
			this.logger.warn('Credenciales del Banco Central no configuradas');
		}
	}

	async getSeries(dto: GetSeriesDto): Promise<BancoCentralResponse> {
		try {
			this.logger.log(`Consultando serie ${dto.timeseries} del Banco Central`);

			const params = new URLSearchParams({
				user: this.user,
				pass: this.pass,
				function: 'GetSeries',
				timeseries: dto.timeseries,
			});

			if (dto.firstdate) {
				params.append('firstdate', dto.firstdate);
			}

			if (dto.lastdate) {
				params.append('lastdate', dto.lastdate);
			}

			const url = `${this.baseUrl}?${params.toString()}`;

			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`Error HTTP: ${response.status} ${response.statusText}`);
			}

			const data: BancoCentralResponse = await response.json();

			if (data.Codigo !== 0) {
				throw new Error(`Error del Banco Central: ${data.Descripcion}`);
			}

			this.logger.log(`Serie ${dto.timeseries} obtenida exitosamente con ${data.Series.Obs.length} observaciones`);

			return data;
		} catch (error) {
			this.logger.error(`Error al consultar serie del Banco Central: ${error.message}`, error.stack);
			throw error;
		}
	}

	async syncIndicators(dto: SyncIndicatorsDto): Promise<{ synced: number; errors: number }> {
		try {
			this.logger.log('Iniciando sincronización de indicadores económicos');

			const firstdate = dto.firstdate || this.getDateDaysAgo(30);
			const lastdate = dto.lastdate || this.getTodayDate();

			const indicadores = [
				IndicadorEconomico.UF,
				IndicadorEconomico.DOLAR_OBSERVADO,
				IndicadorEconomico.DOLAR_PESO_COLOMBIANO,
				IndicadorEconomico.DOLAR_PESO_MEXICANO,
				IndicadorEconomico.DOLAR_REAL_BRASILENO,
				IndicadorEconomico.DOLAR_SOL_PERUANO,
				IndicadorEconomico.EURO,
				IndicadorEconomico.IPC,
				IndicadorEconomico.TPM,
			];

			let synced = 0;
			let errors = 0;

			for (const indicador of indicadores) {
				try {
					const response = await this.getSeries({
						timeseries: indicador,
						firstdate,
						lastdate,
					});

					const saved = await this.saveIndicatorData(response);
					synced += saved;
					this.logger.log(`Sincronizados ${saved} registros para ${indicador}`);
				} catch (error) {
					errors++;
					this.logger.error(`Error sincronizando ${indicador}: ${error.message}`);
				}
			}

			this.logger.log(`Sincronización completada: ${synced} registros sincronizados, ${errors} errores`);

			return { synced, errors };
		} catch (error) {
			this.logger.error(`Error en sincronización de indicadores: ${error.message}`, error.stack);
			throw error;
		}
	}

	private async saveIndicatorData(response: BancoCentralResponse): Promise<number> {
		try {
			const { Series } = response;
			let saved = 0;

			for (const obs of Series.Obs) {
				try {
					const fecha = this.parseDate(obs.indexDateString);
					const valor = parseFloat(obs.value);

					if (isNaN(valor)) {
						this.logger.warn(`Valor inválido para fecha ${obs.indexDateString}: ${obs.value}`);
						continue;
					}

					const indicador = this.indicadorRepository.create({
						codigo: Series.seriesId,
						nombre: Series.descripEsp,
						fecha,
						valor,
						status_code: obs.statusCode,
					});

					await this.indicadorRepository.save(indicador);
					saved++;
				} catch (error) {
					if (error.code === '23505') {
						this.logger.debug(`Registro duplicado para ${Series.seriesId} en fecha ${obs.indexDateString}`);
					} else {
						this.logger.error(`Error guardando observación: ${error.message}`);
					}
				}
			}

			return saved;
		} catch (error) {
			this.logger.error(`Error guardando datos del indicador: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getIndicatorHistory(codigo: string, fechaInicio?: string, fechaFin?: string): Promise<IndicadorEconomicoData[]> {
		try {
			const query = this.indicadorRepository.createQueryBuilder('indicador').where('indicador.codigo = :codigo', { codigo });

			if (fechaInicio) {
				query.andWhere('indicador.fecha >= :fechaInicio', { fechaInicio });
			}

			if (fechaFin) {
				query.andWhere('indicador.fecha <= :fechaFin', { fechaFin });
			}

			query.orderBy('indicador.fecha', 'DESC');

			const indicadores = await query.getMany();

			return indicadores.map((ind) => ({
				codigo: ind.codigo,
				nombre: ind.nombre,
				fecha: ind.fecha,
				valor: Number(ind.valor),
				unidad: ind.unidad,
			}));
		} catch (error) {
			this.logger.error(`Error obteniendo historial de indicador: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getLatestIndicators(): Promise<IndicadorEconomicoData[]> {
		try {
			const query = `
				SELECT DISTINCT ON (codigo) 
					codigo, nombre, fecha, valor, unidad
				FROM indicadores_economicos
				ORDER BY codigo, fecha DESC
			`;

			const indicadores = await this.indicadorRepository.query(query);

			return indicadores.map((ind) => ({
				codigo: ind.codigo,
				nombre: ind.nombre,
				fecha: new Date(ind.fecha),
				valor: parseFloat(ind.valor),
				unidad: ind.unidad,
			}));
		} catch (error) {
			this.logger.error(`Error obteniendo últimos indicadores: ${error.message}`, error.stack);
			throw error;
		}
	}

	private parseDate(dateString: string): Date {
		const [day, month, year] = dateString.split('-');
		return new Date(`${year}-${month}-${day}`);
	}

	private getDateDaysAgo(days: number): string {
		const date = new Date();
		date.setDate(date.getDate() - days);
		return date.toISOString().split('T')[0];
	}

	private getTodayDate(): string {
		return new Date().toISOString().split('T')[0];
	}
}
