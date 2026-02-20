import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BancoCentralService } from '../banco-central.service';
import { CalculateMonthlyAvgDto, CalculateMonthlyAvgResponseDto } from '../dtos/calculate-monthly-avg.dto';
import { ExchangeRateResponseDto, GetExchangeRatesDto, GetLatestExchangeRatesDto, MonthlyAvgResponseDto } from '../dtos/get-exchange-rates.dto';
import { SyncExchangeRatesDto, SyncExchangeRatesResponseDto } from '../dtos/sync-exchange-rates.dto';
import { ExchangeRateMonthlyAvgEntity } from '../entities/exchange-rate-monthly-avg.entity';
import { ExchangeRateEntity } from '../entities/exchange-rate.entity';
import { IndicadorEconomico } from '../interfaces/banco-central.interface';

interface CurrencyMapping {
	code: IndicadorEconomico;
	fromCurrency: string;
	toCurrency: string;
	name: string;
}

@Injectable()
export class ExchangeRatesService {
	private readonly logger = new Logger(ExchangeRatesService.name);

	private readonly currencyMappings: CurrencyMapping[] = [
		{
			code: IndicadorEconomico.DOLAR_OBSERVADO,
			fromCurrency: 'USD',
			toCurrency: 'CLP',
			name: 'Dólar Observado',
		},
		{
			code: IndicadorEconomico.DOLAR_PESO_ARGENTINO,
			fromCurrency: 'USD',
			toCurrency: 'ARS',
			name: 'Dólar Peso Argentino',
		},
		{
			code: IndicadorEconomico.DOLAR_PESO_COLOMBIANO,
			fromCurrency: 'USD',
			toCurrency: 'COP',
			name: 'Dólar Peso Colombiano',
		},
		{
			code: IndicadorEconomico.DOLAR_PESO_MEXICANO,
			fromCurrency: 'USD',
			toCurrency: 'MXN',
			name: 'Dólar Peso Mexicano',
		},
		{
			code: IndicadorEconomico.DOLAR_PESO_URUGUAYO,
			fromCurrency: 'USD',
			toCurrency: 'UYU',
			name: 'Dólar Peso Uruguayo',
		},
		{
			code: IndicadorEconomico.DOLAR_REAL_BRASILENO,
			fromCurrency: 'USD',
			toCurrency: 'BRL',
			name: 'Dólar Real Brasileño',
		},
		{
			code: IndicadorEconomico.DOLAR_SOL_PERUANO,
			fromCurrency: 'USD',
			toCurrency: 'PEN',
			name: 'Dólar Sol Peruano',
		},
		{
			code: IndicadorEconomico.EURO,
			fromCurrency: 'EUR',
			toCurrency: 'USD',
			name: 'Euro',
		},
		{
			code: IndicadorEconomico.UF,
			fromCurrency: 'CLF',
			toCurrency: 'CLP',
			name: 'Unidad de Fomento',
		},
	];

	constructor(
		@InjectRepository(ExchangeRateEntity)
		private readonly exchangeRateRepository: Repository<ExchangeRateEntity>,
		@InjectRepository(ExchangeRateMonthlyAvgEntity)
		private readonly monthlyAvgRepository: Repository<ExchangeRateMonthlyAvgEntity>,
		private readonly bancoCentralService: BancoCentralService
	) {}

	private dateToString(date: Date | string): string {
		if (typeof date === 'string') {
			return date.split('T')[0];
		}
		return new Date(date).toISOString().split('T')[0];
	}

	async syncExchangeRates(dto: SyncExchangeRatesDto): Promise<SyncExchangeRatesResponseDto> {
		try {
			this.logger.log(`Iniciando sincronización de tipos de cambio desde ${dto.startDate} hasta ${dto.endDate}`);

			const stats = {
				totalProcessed: 0,
				inserted: 0,
				updated: 0,
				errors: 0,
				indirectConversions: 0,
			};

			const mappingsToSync = dto.currencyPairs
				? this.currencyMappings.filter((m) => dto.currencyPairs.includes(`${m.fromCurrency}/${m.toCurrency}`))
				: this.currencyMappings;

			for (const mapping of mappingsToSync) {
				try {
					this.logger.log(`Sincronizando ${mapping.name} (${mapping.fromCurrency}/${mapping.toCurrency})`);

					const response = await this.bancoCentralService.getSeries({
						timeseries: mapping.code,
						firstdate: dto.startDate,
						lastdate: dto.endDate,
					});

					for (const obs of response.Series.Obs) {
						try {
							const rateDate = this.parseDate(obs.indexDateString);
							const rate = parseFloat(obs.value);

							if (isNaN(rate) || rate <= 0) {
								this.logger.debug(
									`Valor inválido para ${mapping.fromCurrency}/${mapping.toCurrency} en ${obs.indexDateString}: ${obs.value} (probablemente fin de semana o festivo)`
								);
								stats.errors++;
								continue;
							}

							const exchangeRate = this.exchangeRateRepository.create({
								rate_date: rateDate,
								from_currency: mapping.fromCurrency,
								to_currency: mapping.toCurrency,
								rate,
								source_type: 'BANCOCENTRAL',
								api_source: 'Banco Central de Chile',
								is_indirect_conversion: false,
								conversion_chain: null,
							});

							const existing = await this.exchangeRateRepository.findOne({
								where: {
									rate_date: rateDate,
									from_currency: mapping.fromCurrency,
									to_currency: mapping.toCurrency,
								},
							});

							if (existing) {
								await this.exchangeRateRepository.update(
									{
										rate_date: rateDate,
										from_currency: mapping.fromCurrency,
										to_currency: mapping.toCurrency,
									},
									exchangeRate
								);
								stats.updated++;
							} else {
								await this.exchangeRateRepository.save(exchangeRate);
								stats.inserted++;
							}

							stats.totalProcessed++;
						} catch (error) {
							this.logger.error(`Error procesando observación: ${error.message}`);
							stats.errors++;
						}
					}

					this.logger.log(`Completado ${mapping.name}: ${response.Series.Obs.length} observaciones procesadas`);
				} catch (error) {
					this.logger.error(`Error sincronizando ${mapping.name}: ${error.message}`);
					stats.errors++;
				}
			}

			const indirectStats = await this.calculateIndirectConversions(dto.startDate, dto.endDate);
			stats.indirectConversions = indirectStats.inserted + indirectStats.updated;

			const monthlyStats = await this.calculateMonthlyAveragesForPeriod(dto.startDate, dto.endDate);

			this.logger.log(
				`Sincronización completada: ${stats.totalProcessed} procesados, ${stats.inserted} insertados, ${stats.updated} actualizados, ${stats.errors} errores, ${stats.indirectConversions} conversiones indirectas`
			);

			return {
				success: true,
				message: 'Sincronización completada exitosamente',
				stats,
				monthlyAveragesCalculated: monthlyStats,
			};
		} catch (error) {
			this.logger.error(`Error en sincronización de tipos de cambio: ${error.message}`, error.stack);
			throw error;
		}
	}

	private async calculateIndirectConversions(startDate: string, endDate: string): Promise<{ inserted: number; updated: number }> {
		try {
			this.logger.log('Calculando conversiones indirectas CLF→CLP→USD');

			const stats = { inserted: 0, updated: 0 };

			const clfClpRates = await this.exchangeRateRepository.find({
				where: {
					from_currency: 'CLF',
					to_currency: 'CLP',
				},
				order: { rate_date: 'ASC' },
			});

			for (const clfClp of clfClpRates) {
				const rateDateStr = this.dateToString(clfClp.rate_date);

				if (rateDateStr < startDate || rateDateStr > endDate) {
					continue;
				}

				const clpUsd = await this.exchangeRateRepository.findOne({
					where: {
						rate_date: clfClp.rate_date,
						from_currency: 'USD',
						to_currency: 'CLP',
					},
				});

				if (!clpUsd) {
					continue;
				}

				const clfUsdRate = Number(clfClp.rate) / Number(clpUsd.rate);

				const indirectRate = this.exchangeRateRepository.create({
					rate_date: clfClp.rate_date,
					from_currency: 'CLF',
					to_currency: 'USD',
					rate: clfUsdRate,
					source_type: 'BANCOCENTRAL',
					api_source: 'Banco Central de Chile (calculado)',
					is_indirect_conversion: true,
					conversion_chain: {
						path: 'CLF→CLP→USD',
						rates: {
							'CLF/CLP': Number(clfClp.rate),
							'USD/CLP': Number(clpUsd.rate),
						},
					},
				});

				const existing = await this.exchangeRateRepository.findOne({
					where: {
						rate_date: clfClp.rate_date,
						from_currency: 'CLF',
						to_currency: 'USD',
					},
				});

				if (existing) {
					await this.exchangeRateRepository.update(
						{
							rate_date: clfClp.rate_date,
							from_currency: 'CLF',
							to_currency: 'USD',
						},
						indirectRate
					);
					stats.updated++;
				} else {
					await this.exchangeRateRepository.save(indirectRate);
					stats.inserted++;
				}
			}

			this.logger.log(`Conversiones indirectas completadas: ${stats.inserted} insertadas, ${stats.updated} actualizadas`);

			return stats;
		} catch (error) {
			this.logger.error(`Error calculando conversiones indirectas: ${error.message}`, error.stack);
			throw error;
		}
	}

	async calculateMonthlyAverages(dto: CalculateMonthlyAvgDto): Promise<CalculateMonthlyAvgResponseDto> {
		try {
			this.logger.log('Calculando promedios mensuales de tipos de cambio');

			const stats = {
				periodsProcessed: 0,
				currencyPairsProcessed: 0,
				recordsCreated: 0,
				recordsUpdated: 0,
			};

			const query = this.exchangeRateRepository
				.createQueryBuilder('er')
				.select('er.from_currency', 'from_currency')
				.addSelect('er.to_currency', 'to_currency')
				.distinct(true);

			if (dto.year) {
				query.andWhere('EXTRACT(YEAR FROM er.rate_date) = :year', { year: dto.year });
			}

			if (dto.month) {
				query.andWhere('EXTRACT(MONTH FROM er.rate_date) = :month', { month: dto.month });
			}

			const currencyPairs = await query.getRawMany();

			for (const pair of currencyPairs) {
				const periodsQuery = this.exchangeRateRepository
					.createQueryBuilder('er')
					.select('EXTRACT(YEAR FROM er.rate_date)', 'year')
					.addSelect('EXTRACT(MONTH FROM er.rate_date)', 'month')
					.where('er.from_currency = :fromCurrency', { fromCurrency: pair.from_currency })
					.andWhere('er.to_currency = :toCurrency', { toCurrency: pair.to_currency })
					.groupBy('year, month')
					.orderBy('year', 'DESC')
					.addOrderBy('month', 'DESC');

				if (dto.year) {
					periodsQuery.andWhere('EXTRACT(YEAR FROM er.rate_date) = :year', { year: dto.year });
				}

				if (dto.month) {
					periodsQuery.andWhere('EXTRACT(MONTH FROM er.rate_date) = :month', { month: dto.month });
				}

				const periods = await periodsQuery.getRawMany();

				for (const period of periods) {
					const avgQuery = this.exchangeRateRepository
						.createQueryBuilder('er')
						.select('AVG(er.rate)', 'avg_rate')
						.addSelect('MIN(er.rate)', 'min_rate')
						.addSelect('MAX(er.rate)', 'max_rate')
						.addSelect('COUNT(*)', 'data_points')
						.where('er.from_currency = :fromCurrency', { fromCurrency: pair.from_currency })
						.andWhere('er.to_currency = :toCurrency', { toCurrency: pair.to_currency })
						.andWhere('er.source_type = :sourceType', { sourceType: 'BANCOCENTRAL' })
						.andWhere('EXTRACT(YEAR FROM er.rate_date) = :year', { year: period.year })
						.andWhere('EXTRACT(MONTH FROM er.rate_date) = :month', { month: period.month });

					const result = await avgQuery.getRawOne();

					if (result && result.data_points > 0) {
						const monthlyAvg = this.monthlyAvgRepository.create({
							from_currency: pair.from_currency,
							to_currency: pair.to_currency,
							year: parseInt(period.year),
							month: parseInt(period.month),
							avg_rate: parseFloat(result.avg_rate),
							min_rate: parseFloat(result.min_rate),
							max_rate: parseFloat(result.max_rate),
							data_points: parseInt(result.data_points),
							calculated_at: new Date(),
						});

						const existing = await this.monthlyAvgRepository.findOne({
							where: {
								from_currency: pair.from_currency,
								to_currency: pair.to_currency,
								year: parseInt(period.year),
								month: parseInt(period.month),
							},
						});

						if (existing) {
							await this.monthlyAvgRepository.update({ id: existing.id }, monthlyAvg);
							stats.recordsUpdated++;
						} else {
							await this.monthlyAvgRepository.save(monthlyAvg);
							stats.recordsCreated++;
						}

						stats.periodsProcessed++;
					}
				}

				stats.currencyPairsProcessed++;
			}

			this.logger.log(
				`Promedios mensuales calculados: ${stats.periodsProcessed} períodos, ${stats.currencyPairsProcessed} pares de monedas, ${stats.recordsCreated} creados, ${stats.recordsUpdated} actualizados`
			);

			return {
				success: true,
				message: 'Promedios mensuales calculados exitosamente',
				stats,
			};
		} catch (error) {
			this.logger.error(`Error calculando promedios mensuales: ${error.message}`, error.stack);
			throw error;
		}
	}

	private async calculateMonthlyAveragesForPeriod(startDate: string, endDate: string): Promise<{ periods: number; currencyPairs: number }> {
		try {
			const start = new Date(startDate);
			const end = new Date(endDate);

			const years = new Set<number>();
			const months = new Set<string>();

			for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
				years.add(d.getFullYear());
				months.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
			}

			let totalPeriods = 0;
			let totalPairs = 0;

			for (const year of Array.from(years)) {
				for (let month = 1; month <= 12; month++) {
					const periodKey = `${year}-${month}`;
					if (!months.has(periodKey)) continue;

					const result = await this.calculateMonthlyAverages({ year, month });
					totalPeriods += result.stats.periodsProcessed;
					totalPairs = Math.max(totalPairs, result.stats.currencyPairsProcessed);
				}
			}

			return { periods: totalPeriods, currencyPairs: totalPairs };
		} catch (error) {
			this.logger.error(`Error calculando promedios para período: ${error.message}`, error.stack);
			return { periods: 0, currencyPairs: 0 };
		}
	}

	async getExchangeRates(dto: GetExchangeRatesDto): Promise<ExchangeRateResponseDto[]> {
		try {
			const query = this.exchangeRateRepository.createQueryBuilder('er');

			if (dto.fromCurrency) {
				query.andWhere('er.from_currency = :fromCurrency', { fromCurrency: dto.fromCurrency });
			}

			if (dto.toCurrency) {
				query.andWhere('er.to_currency = :toCurrency', { toCurrency: dto.toCurrency });
			}

			if (dto.startDate) {
				query.andWhere('er.rate_date >= :startDate', { startDate: dto.startDate });
			}

			if (dto.endDate) {
				query.andWhere('er.rate_date <= :endDate', { endDate: dto.endDate });
			}

			query.orderBy('er.rate_date', 'DESC').limit(dto.limit || 100);

			const rates = await query.getMany();

			return rates.map((rate) => ({
				rate_date: rate.rate_date,
				from_currency: rate.from_currency,
				to_currency: rate.to_currency,
				rate: Number(rate.rate),
				source_type: rate.source_type,
				api_source: rate.api_source,
				is_indirect_conversion: rate.is_indirect_conversion,
				conversion_chain: rate.conversion_chain,
			}));
		} catch (error) {
			this.logger.error(`Error obteniendo tipos de cambio: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getLatestExchangeRates(dto: GetLatestExchangeRatesDto): Promise<ExchangeRateResponseDto[]> {
		try {
			let query = `
				SELECT DISTINCT ON (from_currency, to_currency)
					rate_date, from_currency, to_currency, rate, source_type, 
					api_source, is_indirect_conversion, conversion_chain
				FROM exchange_rates
			`;

			const conditions: string[] = [];
			const params: any[] = [];

			if (dto.fromCurrency) {
				conditions.push(`from_currency = $${params.length + 1}`);
				params.push(dto.fromCurrency);
			}

			if (dto.toCurrency) {
				conditions.push(`to_currency = $${params.length + 1}`);
				params.push(dto.toCurrency);
			}

			if (conditions.length > 0) {
				query += ` WHERE ${conditions.join(' AND ')}`;
			}

			query += ` ORDER BY from_currency, to_currency, rate_date DESC`;

			const rates = await this.exchangeRateRepository.query(query, params);

			return rates.map((rate) => ({
				rate_date: new Date(rate.rate_date),
				from_currency: rate.from_currency,
				to_currency: rate.to_currency,
				rate: parseFloat(rate.rate),
				source_type: rate.source_type,
				api_source: rate.api_source,
				is_indirect_conversion: rate.is_indirect_conversion,
				conversion_chain: rate.conversion_chain,
			}));
		} catch (error) {
			this.logger.error(`Error obteniendo últimos tipos de cambio: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getMonthlyAverages(year?: number, month?: number): Promise<MonthlyAvgResponseDto[]> {
		try {
			const query = this.monthlyAvgRepository.createQueryBuilder('ma');

			if (year) {
				query.andWhere('ma.year = :year', { year });
			}

			if (month) {
				query.andWhere('ma.month = :month', { month });
			}

			query.orderBy('ma.year', 'DESC').addOrderBy('ma.month', 'DESC');

			const averages = await query.getMany();

			return averages.map((avg) => ({
				from_currency: avg.from_currency,
				to_currency: avg.to_currency,
				year: avg.year,
				month: avg.month,
				avg_rate: Number(avg.avg_rate),
				min_rate: Number(avg.min_rate),
				max_rate: Number(avg.max_rate),
				data_points: avg.data_points,
				calculated_at: avg.calculated_at,
			}));
		} catch (error) {
			this.logger.error(`Error obteniendo promedios mensuales: ${error.message}`, error.stack);
			throw error;
		}
	}

	async syncHistoricalRates(): Promise<SyncExchangeRatesResponseDto> {
		const startDate = '2025-01-01';
		const today = new Date().toISOString().split('T')[0];

		return this.syncExchangeRates({
			startDate,
			endDate: today,
		});
	}

	async getExchangeRateWithFallback(
		fromCurrency: string,
		toCurrency: string,
		date: string | Date
	): Promise<ExchangeRateResponseDto & { is_fallback: boolean }> {
		try {
			const targetDate = typeof date === 'string' ? date : this.dateToString(date);

			const exactRate = await this.exchangeRateRepository.findOne({
				where: {
					from_currency: fromCurrency,
					to_currency: toCurrency,
					rate_date: new Date(targetDate) as any,
				},
			});

			if (exactRate) {
				return {
					rate_date: exactRate.rate_date,
					from_currency: exactRate.from_currency,
					to_currency: exactRate.to_currency,
					rate: Number(exactRate.rate),
					source_type: exactRate.source_type,
					api_source: exactRate.api_source,
					is_indirect_conversion: exactRate.is_indirect_conversion,
					conversion_chain: exactRate.conversion_chain,
					is_fallback: false,
				};
			}

			this.logger.debug(
				`No se encontró tipo de cambio para ${fromCurrency}/${toCurrency} en ${targetDate}, buscando último día hábil anterior`
			);

			const fallbackRate = await this.exchangeRateRepository
				.createQueryBuilder('er')
				.where('er.from_currency = :fromCurrency', { fromCurrency })
				.andWhere('er.to_currency = :toCurrency', { toCurrency })
				.andWhere('er.rate_date < :targetDate', { targetDate })
				.orderBy('er.rate_date', 'DESC')
				.limit(1)
				.getOne();

			if (!fallbackRate) {
				throw new Error(`No se encontró tipo de cambio para ${fromCurrency}/${toCurrency} en o antes de ${targetDate}`);
			}

			this.logger.debug(
				`Usando tipo de cambio de ${this.dateToString(fallbackRate.rate_date)} para ${fromCurrency}/${toCurrency} (solicitado: ${targetDate})`
			);

			return {
				rate_date: fallbackRate.rate_date,
				from_currency: fallbackRate.from_currency,
				to_currency: fallbackRate.to_currency,
				rate: Number(fallbackRate.rate),
				source_type: fallbackRate.source_type,
				api_source: fallbackRate.api_source,
				is_indirect_conversion: fallbackRate.is_indirect_conversion,
				conversion_chain: fallbackRate.conversion_chain,
				is_fallback: true,
			};
		} catch (error) {
			this.logger.error(`Error obteniendo tipo de cambio con fallback: ${error.message}`, error.stack);
			throw error;
		}
	}

	private parseDate(dateString: string): Date {
		const [day, month, year] = dateString.split('-');
		return new Date(`${year}-${month}-${day}`);
	}
}
