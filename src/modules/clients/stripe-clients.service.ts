import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Client } from '@/databases/postgresql/entities/client.entity';
import { BigQueryService } from '@/modules/bigquery/bigquery.service';

@Injectable()
export class StripeClientsService {
	private readonly logger = new Logger(StripeClientsService.name);

	constructor(
		@InjectRepository(Client)
		private readonly clientRepository: Repository<Client>,
		private readonly bigQueryService: BigQueryService
	) {}

	async syncStripeCustomerIds(): Promise<{
		success: boolean;
		message: string;
		stats: {
			totalFromBigQuery: number;
			clientsUpdated: number;
			clientsNotFound: number;
			errors: number;
		};
	}> {
		this.logger.log('Iniciando sincronización de stripe_customer_id desde BigQuery...');

		try {
			const result = await this.bigQueryService.executeQuery({
				query: 'SELECT * FROM `datawarehouse-a2e2.finance.sapira_stripe`',
				params: {},
			});

			const stats = {
				totalFromBigQuery: result.rows.length,
				clientsUpdated: 0,
				clientsNotFound: 0,
				errors: 0,
			};

			this.logger.log(`Registros obtenidos de BigQuery: ${result.rows.length}`);

			for (const row of result.rows) {
				try {
					const salesforceAccountId = row.salesforce_account_id;
					const stripeCustomerId = row.stripe_customer_id;

					if (!salesforceAccountId || !stripeCustomerId) {
						continue;
					}

					const client = await this.clientRepository.findOne({
						where: { salesforce_account_id: salesforceAccountId },
					});

					if (!client) {
						stats.clientsNotFound++;
						continue;
					}

					client.stripe_customer_id = stripeCustomerId;
					await this.clientRepository.save(client);
					stats.clientsUpdated++;
				} catch (error) {
					this.logger.error(`Error procesando registro: ${error.message}`);
					stats.errors++;
				}
			}

			this.logger.log(
				`Sincronización completada. Actualizados: ${stats.clientsUpdated}, No encontrados: ${stats.clientsNotFound}, Errores: ${stats.errors}`
			);

			return {
				success: true,
				message: 'Sincronización completada exitosamente',
				stats,
			};
		} catch (error) {
			this.logger.error('Error en sincronización de stripe_customer_id:', error);
			throw new BadRequestException(`Error al sincronizar stripe_customer_id: ${error.message}`);
		}
	}
}
