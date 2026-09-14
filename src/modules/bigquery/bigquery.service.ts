import { createHash } from 'crypto';

import { BigQuery } from '@google-cloud/bigquery';
import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, In, IsNull, Repository } from 'typeorm';

import { BigQueryConnection } from '@/databases/postgresql/entities/bigquery-connection.entity';
import {
	QuantityImportResolutionSource,
	QuantityImportStatus,
	SapiraQuantityImport,
} from '@/databases/postgresql/entities/sapira-quantity-import.entity';
import { StripeCustomerBigQuery } from '@/databases/postgresql/entities/stripe-customer-bigquery.entity';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { ListQuantityImportsDto } from './dtos/list-quantity-imports.dto';
import { QueryDto } from './dtos/query.dto';
import { ReplaceQuantityRecordDto } from './dtos/replace-quantity-record.dto';
import { SyncStripeCustomersResponseDto } from './dtos/sync-stripe-customers.dto';
import { BigQueryResult } from './interfaces/bigquery-result.interface';
import { ProjectInfo } from './interfaces/project-info.interface';
import { QuantityRecord } from './interfaces/quantity-record.interface';
import {
	QuantitiesDateRange,
	QuantitiesIngestResult,
	QuantitiesIntegrationResult,
	SapiraQuantitiesSyncResult,
} from './interfaces/sapira-quantities-sync-result.interface';

export const QUANTITIES_DIFF_NOTIFICATION_TYPE = 'bigquery_quantities_diff';
export const QUANTITIES_UNMAPPED_NOTIFICATION_TYPE = 'bigquery_quantities_unmapped';
export const QUANTITIES_BLOCKED_NOTIFICATION_TYPE = 'bigquery_quantities_blocked';
export const QUANTITIES_CURRENCY_MISMATCH_NOTIFICATION_TYPE = 'bigquery_quantities_currency_mismatch';
export const REPLACE_QUANTITY_RECORD_ACTION = 'replace_quantity_record';

/** `quantities.unit_of_measure` es varchar(32); el `unit` del DWH es texto libre. */
const QUANTITY_UNIT_OF_MEASURE_MAX_LENGTH = 32;

/**
 * Marca de trazabilidad en `quantities.notes`. Es el único campo disponible para distinguir
 * una fila del canal automático de un override manual: la tabla no tiene columna de origen y
 * `created_by` queda NULL en ambos casos. La trazabilidad fuerte vive en
 * `sapira_quantity_imports.quantity_id`.
 */
const QUANTITY_IMPORT_NOTES_SOURCE = 'DWH sapira_base';

/**
 * Campos del DWH que entran al `source_hash` y al diff campo a campo.
 *
 * Incluye los que no se integran a `quantities` (`entity_name`, `tin`, `country`) porque esta
 * tabla también cumple el rol de detectar cambios en el origen. El hash se calcula sobre los
 * valores ya parseados, así que `0.050` y `0.05` no producen un diff falso.
 */
const QUANTITY_IMPORT_HASH_FIELDS = [
	'quantity',
	'unit_price',
	'unit_of_measure',
	'account',
	'currency',
	'gross_local_amount',
	'business_name',
	'entity_name',
	'tin',
	'country',
	'dwh_status',
	'sapira_contract_id',
	'sapira_contract_item_id',
	'quote_line_id',
	'opportunity_id',
] as const;

/** Campos que sí se propagan a `quantities`; el resto solo se vigila. */
const QUANTITY_INTEGRATED_FIELDS = ['unit_price', 'quantity', 'unit_of_measure', 'account'] as const;

/**
 * Estados reprocesables por el endpoint de reproceso. `unmapped` y `blocked` se resuelven
 * solos con el tiempo (al poblarse `contract_items.quote_item_number`, o al anularse la
 * factura del período); `not_variable` y `currency_mismatch`, si se corrige el maestro.
 * `ambiguous`, `conflict` y `changed_in_source` requieren intervención humana.
 */
const RETRYABLE_IMPORT_STATUSES: QuantityImportStatus[] = ['unmapped', 'not_variable', 'currency_mismatch', 'blocked'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fila normalizada de finance.sapira_base lista para persistir en la tabla intermedia. */
interface NormalizedQuantityRow {
	sf_id: string;
	billing_date: string;
	product: string;
	period: string;
	quantity: number | null;
	unit_price: number | null;
	unit_of_measure: string | null;
	account: string | null;
	currency: string | null;
	gross_local_amount: number | null;
	business_name: string | null;
	entity_name: string | null;
	tin: string | null;
	country: string | null;
	dwh_status: string | null;
	sapira_contract_id: string | null;
	sapira_contract_item_id: string | null;
	quote_line_id: string | null;
	opportunity_id: string | null;
	source_hash: string;
}

/** Candidato de `contract_items` para resolver el mapeo (una query batcheada por holding). */
interface ContractItemCandidate {
	id: string;
	contract_id: string | null;
	holding_id: string;
	quote_item_number: string | null;
	unit_price: string | null;
	quantity: string | null;
	item_currency: string | null;
	contract_currency: string | null;
	salesforce_opportunity_id: string | null;
}

/** Diferencia campo a campo entre lo ingestado y lo que trae ahora el DWH. */
interface QuantityImportDiff {
	field: string;
	current: string | null;
	incoming: string | null;
}

@Injectable()
export class BigQueryService {
	private readonly logger = new Logger(BigQueryService.name);

	constructor(
		@InjectRepository(StripeCustomerBigQuery)
		private readonly stripeCustomerRepository: Repository<StripeCustomerBigQuery>,
		@InjectRepository(BigQueryConnection)
		private readonly bigQueryConnectionRepository: Repository<BigQueryConnection>,
		@InjectRepository(SapiraQuantityImport)
		private readonly quantityImportRepository: Repository<SapiraQuantityImport>,
		private readonly notificationsService: NotificationsService,
		@InjectDataSource()
		private readonly dataSource: DataSource
	) {}

	private parseCredentials(rawCredentials: string): any {
		let value = rawCredentials.trim();

		if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
			value = value.slice(1, -1);
		}

		let parsed: any = JSON.parse(value);

		// Soportar credenciales doble-serializadas, por ejemplo:
		// "{\"type\":\"service_account\",...}"
		if (typeof parsed === 'string') {
			const inner = parsed.trim();
			parsed = JSON.parse(inner);
		}

		return parsed;
	}

	/**
	 * Resuelve el cliente de BigQuery para el holding indicado o lanza si no
	 * existe una conexión activa configurada en bigquery_connections.
	 */
	private async requireClientForHolding(holdingId: string): Promise<BigQuery> {
		if (!holdingId) {
			throw new BadRequestException('El header x-holding-id es requerido');
		}

		const client = await this.getBigQueryClientForHolding(holdingId);
		if (!client) {
			throw new BadRequestException(`No hay conexión de BigQuery configurada para el holding: ${holdingId}`);
		}

		return client;
	}

	async executeQuery(holdingId: string, dto: QueryDto): Promise<BigQueryResult> {
		const client = await this.requireClientForHolding(holdingId);

		try {
			this.logger.log(`Ejecutando consulta: ${dto.query.substring(0, 100)}...`);

			const options = {
				query: dto.query,
				params: dto.params || {},
				location: 'US',
			};

			const [rows] = await client.query(options);

			this.logger.log(`✓ Consulta ejecutada exitosamente. Filas: ${rows.length}`);

			return {
				rows,
				totalRows: rows.length,
				schema: rows.length > 0 ? Object.keys(rows[0]).map((key) => ({ name: key })) : [],
			};
		} catch (error) {
			this.logger.error('Error ejecutando consulta en BigQuery:', error);
			throw new InternalServerErrorException(`Error al ejecutar consulta: ${error.message}`);
		}
	}

	async getDatasets(holdingId: string): Promise<string[]> {
		const client = await this.requireClientForHolding(holdingId);

		try {
			this.logger.log('Solicitando datasets a BigQuery...');
			const [datasets] = await client.getDatasets();
			const datasetIds = datasets.map((dataset) => dataset.id);

			this.logger.log(`✓ Datasets obtenidos: ${datasetIds.length}`);

			return datasetIds;
		} catch (error) {
			this.logger.error('Error obteniendo datasets:', error);
			this.logger.error('Error mensaje:', error.message);
			this.logger.error('Error stack:', error.stack);
			throw new InternalServerErrorException(`Error al obtener datasets: ${error.message}`);
		}
	}

	async getTables(holdingId: string, datasetId: string): Promise<string[]> {
		const client = await this.requireClientForHolding(holdingId);

		try {
			const dataset = client.dataset(datasetId);
			const [tables] = await dataset.getTables();
			const tableIds = tables.map((table) => table.id);

			this.logger.log(`✓ Tablas obtenidas del dataset ${datasetId}: ${tableIds.length}`);

			return tableIds;
		} catch (error) {
			this.logger.error(`Error obteniendo tablas del dataset ${datasetId}:`, error);
			throw new InternalServerErrorException('Error al obtener tablas');
		}
	}

	async getProjectInfo(holdingId: string): Promise<ProjectInfo> {
		if (!holdingId) {
			throw new BadRequestException('El header x-holding-id es requerido');
		}

		const connection = await this.getConnectionForHolding(holdingId);

		if (!connection) {
			return {
				projectId: 'No configurado',
				clientEmail: 'No configurado',
				isConfigured: false,
			};
		}

		let clientEmail = 'No configurado';
		try {
			clientEmail = this.parseCredentials(connection.credentials).client_email || 'No configurado';
		} catch (error) {
			this.logger.error(`Error leyendo credenciales para holding ${holdingId}:`, error?.message);
		}

		return {
			projectId: connection.project_id || 'No configurado',
			clientEmail,
			isConfigured: true,
		};
	}

	async getConnectionForHolding(holdingId: string): Promise<BigQueryConnection | null> {
		try {
			const connection = await this.bigQueryConnectionRepository.findOne({
				where: {
					holding_id: holdingId,
					is_active: true,
				},
				order: {
					created_at: 'DESC',
				},
			});

			return connection;
		} catch (error) {
			this.logger.error(`Error obteniendo conexión para holding ${holdingId}:`, error);
			return null;
		}
	}

	async getBigQueryClientForHolding(holdingId: string): Promise<BigQuery | null> {
		const connection = await this.getConnectionForHolding(holdingId);

		if (!connection) {
			this.logger.warn(`No hay conexión de BigQuery configurada para holding: ${holdingId}`);
			return null;
		}

		try {
			const credentialsJson = this.parseCredentials(connection.credentials);

			const client = new BigQuery({
				projectId: connection.project_id,
				credentials: {
					client_email: credentialsJson.client_email,
					private_key: credentialsJson.private_key,
				},
			});

			this.logger.log(`✓ Cliente BigQuery inicializado para holding ${holdingId}, proyecto: ${connection.project_id}`);

			return client;
		} catch (error) {
			this.logger.error(`Error inicializando cliente BigQuery para holding ${holdingId}:`, error);
			return null;
		}
	}

	async syncStripeCustomers(holdingId: string): Promise<SyncStripeCustomersResponseDto> {
		const client = await this.getBigQueryClientForHolding(holdingId);

		if (!client) {
			throw new BadRequestException(`No hay conexión de BigQuery configurada para el holding: ${holdingId}`);
		}

		const connection = await this.getConnectionForHolding(holdingId);

		try {
			this.logger.log(`Iniciando sincronización de clientes Stripe para holding: ${holdingId}`);

			const query = 'SELECT * FROM `datawarehouse-a2e2.finance.sapira_stripe`';

			const [rows] = await client.query({
				query,
				location: 'US',
			});

			this.logger.log(`✓ Obtenidos ${rows.length} registros desde BigQuery`);

			let inserted = 0;
			let updated = 0;

			for (const row of rows) {
				const existingRecord = await this.stripeCustomerRepository.findOne({
					where: {
						holding_id: holdingId,
						salesforce_account_id: row.salesforce_account_id,
						stripe_customer_id: row.stripe_customer_id,
					},
				});

				const customerData: Partial<StripeCustomerBigQuery> = {
					holding_id: holdingId,
					salesforce_account_id: row.salesforce_account_id,
					stripe_customer_id: row.stripe_customer_id,
					salesforce_account_country: row.salesforce_account_country,
					client_name: row.client_name,
					salesforce_account_segment: row.salesforce_account_segment,
					salesforce_account_industry: row.salesforce_account_industry,
				};

				if (existingRecord) {
					await this.stripeCustomerRepository.update(existingRecord.id, customerData);
					updated++;
				} else {
					await this.stripeCustomerRepository.save(customerData);
					inserted++;
				}
			}

			this.logger.log(`✓ Sincronización completada: ${inserted} insertados, ${updated} actualizados`);

			if (connection) {
				await this.bigQueryConnectionRepository.update(connection.id, {
					last_sync_at: new Date(),
				});
			}

			return {
				totalProcessed: rows.length,
				inserted,
				updated,
				message: 'Sincronización completada exitosamente',
			};
		} catch (error) {
			this.logger.error('Error sincronizando clientes Stripe:', error);
			throw new InternalServerErrorException(`Error al sincronizar clientes Stripe: ${error.message}`);
		}
	}

	/**
	 * Calcula [primer día del mes en curso, primer día del mes siguiente) en la
	 * zona horaria America/Santiago, en formato YYYY-MM-DD.
	 */
	getCurrentMonthRange(reference = new Date()): { monthStart: string; monthEnd: string } {
		const formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'America/Santiago',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		const parts = Object.fromEntries(formatter.formatToParts(reference).map((part) => [part.type, part.value]));
		const year = Number(parts.year);
		const month = Number(parts.month); // 1-12

		const pad = (value: number) => String(value).padStart(2, '0');
		const monthStart = `${year}-${pad(month)}-01`;
		const nextMonthYear = month === 12 ? year + 1 : year;
		const nextMonth = month === 12 ? 1 : month + 1;
		const monthEnd = `${nextMonthYear}-${pad(nextMonth)}-01`;

		return { monthStart, monthEnd };
	}

	/**
	 * Resuelve la ventana efectiva `[from, to]` (inclusiva en ambos extremos) del canal de cantidades.
	 *
	 * Sin rango explícito usa el mes en curso, que es lo que ejecuta el scheduler diario. Enviar solo
	 * uno de los dos extremos es un error deliberado: acotar por un lado dejaría el otro abierto y
	 * convertiría un typo en un backfill de todo el histórico.
	 */
	resolveDateRange(range?: { from?: string; to?: string }): QuantitiesDateRange {
		const from = range?.from?.trim();
		const to = range?.to?.trim();

		if (!from && !to) {
			const { monthStart, monthEnd } = this.getCurrentMonthRange();
			return { from: monthStart, to: this.previousDay(monthEnd) };
		}

		if (!from || !to) {
			throw new BadRequestException('El rango requiere `from` y `to`; enviar solo uno dejaría la ventana abierta por el otro extremo');
		}

		if (from > to) {
			throw new BadRequestException(`El rango es inválido: \`from\` (${from}) es posterior a \`to\` (${to})`);
		}

		return { from, to };
	}

	/** Día anterior a una fecha YYYY-MM-DD, para convertir un extremo exclusivo en inclusivo. */
	private previousDay(date: string): string {
		const parsed = new Date(`${date}T00:00:00Z`);
		parsed.setUTCDate(parsed.getUTCDate() - 1);
		return parsed.toISOString().slice(0, 10);
	}

	/**
	 * Períodos (primer día de mes) que cubre una ventana de fechas. La fase 2 filtra por `period`
	 * y no por `billing_date` porque es la columna indexada y la que define el destino en `quantities`.
	 */
	private toPeriodBounds(range: QuantitiesDateRange): { periodFrom: string; periodTo: string } {
		return {
			periodFrom: this.toMonthStart(range.from) as string,
			periodTo: this.toMonthStart(range.to) as string,
		};
	}

	private normalizeDwhValue(value: unknown): string | null {
		if (value === null || value === undefined) {
			return null;
		}
		// BigQuery devuelve DATE/valores tipados como { value: '...' }
		if (typeof value === 'object' && value !== null && 'value' in (value as Record<string, unknown>)) {
			const inner = (value as Record<string, unknown>).value;
			return inner === null || inner === undefined ? null : String(inner);
		}
		const asString = String(value).trim();
		return asString === '' ? null : asString;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Cantidades variables: finance.sapira_base → sapira_quantity_imports → quantities
	// ─────────────────────────────────────────────────────────────────────────────

	/** Convierte un valor del DWH a número. Descarta NaN y negativos (los rechazan los CHECK de quantities). */
	private parseImportNumeric(value: unknown): number | null {
		const raw = this.normalizeDwhValue(value);
		if (raw === null) {
			return null;
		}

		const parsed = Number(raw);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
	}

	/**
	 * Trunca una fecha al primer día del mes. `quantities.period` tiene un CHECK que exige
	 * `YYYY-MM-01` y `billing_date` puede venir a mitad de mes.
	 */
	private toMonthStart(value: string | null): string | null {
		if (!value) {
			return null;
		}

		const match = /^(\d{4})-(\d{2})-\d{2}/.exec(value);
		return match ? `${match[1]}-${match[2]}-01` : null;
	}

	private buildQuantityImportHash(row: Omit<NormalizedQuantityRow, 'source_hash'>): string {
		const payload = QUANTITY_IMPORT_HASH_FIELDS.map((field) => `${field}=${row[field] ?? ''}`).join('|');
		return createHash('sha256').update(payload).digest('hex');
	}

	/**
	 * Normaliza una fila cruda de `finance.sapira_base`.
	 *
	 * Solo devuelve null si falta la clave natural. Las filas sin cantidad ni precio SÍ se
	 * persisten (quedan en `no_quantity_data`): no son integrables, pero se vigilan para detectar
	 * cambios en el origen.
	 */
	private normalizeQuantityRow(raw: Record<string, unknown>): NormalizedQuantityRow | null {
		const sfId = this.normalizeDwhValue(raw.sf_id);
		const billingDate = this.normalizeDwhValue(raw.billing_date);
		const product = this.normalizeDwhValue(raw.product);
		const period = this.toMonthStart(billingDate);

		if (!sfId || !billingDate || !product || !period) {
			return null;
		}

		const unit = this.normalizeDwhValue(raw.unit);

		const base = {
			sf_id: sfId,
			billing_date: billingDate,
			product,
			period,
			quantity: this.parseImportNumeric(raw.quantity),
			unit_price: this.parseImportNumeric(raw.unit_price),
			unit_of_measure: unit === null ? null : unit.slice(0, QUANTITY_UNIT_OF_MEASURE_MAX_LENGTH),
			account: this.normalizeDwhValue(raw.account),
			currency: this.normalizeDwhValue(raw.currency),
			gross_local_amount: this.parseImportNumeric(raw.gross_local_amount),
			business_name: this.normalizeDwhValue(raw.business_name),
			entity_name: this.normalizeDwhValue(raw.entity_name),
			tin: this.normalizeDwhValue(raw.tin),
			country: this.normalizeDwhValue(raw.country),
			dwh_status: this.normalizeDwhValue(raw.status),
			sapira_contract_id: this.normalizeDwhValue(raw.sapira_contract_id),
			sapira_contract_item_id: this.normalizeDwhValue(raw.sapira_contract_item_id),
			quote_line_id: this.normalizeDwhValue(raw.quote_line_id),
			opportunity_id: this.normalizeDwhValue(raw.opportunity_id),
		};

		return { ...base, source_hash: this.buildQuantityImportHash(base) };
	}

	/**
	 * Estado inicial de una fila según su payload: sin cantidad ni precio no hay override que
	 * aplicar, así que nunca entra a la fase 2. Se calcula desde el payload (no desde la
	 * resolución) para que sea determinista al reingestar.
	 */
	private initialImportStatus(row: NormalizedQuantityRow): QuantityImportStatus {
		return row.quantity === null && row.unit_price === null ? 'no_quantity_data' : 'pending';
	}

	/** Diff campo a campo entre lo ya ingestado y lo que trae ahora el DWH. */
	private buildQuantityImportDiffs(existing: SapiraQuantityImport, incoming: NormalizedQuantityRow): QuantityImportDiff[] {
		const numericFields = new Set(['quantity', 'unit_price', 'gross_local_amount']);

		return QUANTITY_IMPORT_HASH_FIELDS.flatMap((field) => {
			const current = existing[field] ?? null;
			const next = incoming[field] ?? null;
			const equal = numericFields.has(field) ? this.numericEquals(current, next) : this.textEquals(current as string, next as string);

			return equal ? [] : [{ field, current: current === null ? null : String(current), incoming: next === null ? null : String(next) }];
		});
	}

	/** Vuelca los campos del payload normalizado sobre la entidad (numéricos como string). */
	private assignQuantityImportPayload(target: SapiraQuantityImport, row: NormalizedQuantityRow): void {
		target.period = row.period;
		target.quantity = row.quantity === null ? null : String(row.quantity);
		target.unit_price = row.unit_price === null ? null : String(row.unit_price);
		target.unit_of_measure = row.unit_of_measure;
		target.account = row.account;
		target.currency = row.currency;
		target.gross_local_amount = row.gross_local_amount === null ? null : String(row.gross_local_amount);
		target.business_name = row.business_name;
		target.entity_name = row.entity_name;
		target.tin = row.tin;
		target.country = row.country;
		target.dwh_status = row.dwh_status;
		target.sapira_contract_id = row.sapira_contract_id;
		target.sapira_contract_item_id = row.sapira_contract_item_id;
		target.quote_line_id = row.quote_line_id;
		target.opportunity_id = row.opportunity_id;
		target.source_hash = row.source_hash;
		target.synced_at = new Date();
	}

	/**
	 * Fase 1 — Ingesta: `datawarehouse-a2e2.finance.sapira_base` → `sapira_quantity_imports`.
	 *
	 * Es la única consulta a BigQuery del canal: cubre tanto la cola de integración como la
	 * detección de cambios en el origen.
	 *
	 * Acá el upsert sí corresponde: la tabla intermedia es nuestro espejo del DWH, no dato de
	 * usuario. Lo que nunca se sobrescribe es `quantities` (eso lo decide la fase 2).
	 */
	async ingestSapiraQuantities(holdingId: string, range?: { from?: string; to?: string }): Promise<QuantitiesIngestResult> {
		const client = await this.requireClientForHolding(holdingId);
		const resolvedRange = this.resolveDateRange(range);

		this.logger.log(`Ingestando cantidades variables [${resolvedRange.from}, ${resolvedRange.to}] para holding ${holdingId}`);

		// Columnas explícitas (no SELECT *) para limitar el escaneo facturable de BigQuery.
		const [rows] = await client.query({
			query:
				'SELECT sf_id, billing_date, product, business_name, entity_name, tin, country, ' +
				'unit, currency, quantity, unit_price, gross_local_amount, account, status, ' +
				'quote_line_id, opportunity_id, sapira_contract_id, sapira_contract_item_id ' +
				'FROM `datawarehouse-a2e2.finance.sapira_base` ' +
				'WHERE billing_date >= @from AND billing_date <= @to',
			params: { from: resolvedRange.from, to: resolvedRange.to },
			location: 'US',
		});

		const result: QuantitiesIngestResult = {
			holdingId,
			range: resolvedRange,
			totalFromDwh: rows.length,
			discarded: 0,
			inserted: 0,
			updated: 0,
			unchanged: 0,
			changedInSource: 0,
			noQuantityData: 0,
		};

		for (const raw of rows as Array<Record<string, unknown>>) {
			const normalized = this.normalizeQuantityRow(raw);
			if (!normalized) {
				// Solo se descarta lo que no tiene clave natural: sin ella no hay nada que vigilar.
				result.discarded++;
				continue;
			}

			const initialStatus = this.initialImportStatus(normalized);
			if (initialStatus === 'no_quantity_data') {
				result.noQuantityData++;
			}

			const existing = await this.quantityImportRepository.findOne({
				where: {
					holding_id: holdingId,
					sf_id: normalized.sf_id,
					billing_date: normalized.billing_date,
					product: normalized.product,
					quote_line_id: normalized.quote_line_id === null ? IsNull() : normalized.quote_line_id,
				},
			});

			if (!existing) {
				const created = this.quantityImportRepository.create({
					holding_id: holdingId,
					sf_id: normalized.sf_id,
					billing_date: normalized.billing_date,
					product: normalized.product,
					integration_status: initialStatus,
				});
				this.assignQuantityImportPayload(created, normalized);
				await this.quantityImportRepository.save(created);
				result.inserted++;
				continue;
			}

			if (existing.source_hash === normalized.source_hash) {
				result.unchanged++;
				continue;
			}

			// El DWH cambió. Si la fila ya se integró, NO se toca quantities: se marca y se notifica
			// con el diff campo a campo para que alguien decida el reemplazo (semántica insert-only).
			if (existing.integration_status === 'integrated') {
				const diffs = this.buildQuantityImportDiffs(existing, normalized);
				this.assignQuantityImportPayload(existing, normalized);
				existing.integration_status = 'changed_in_source';
				existing.integration_reason = 'El DWH modificó esta fila después de haberse integrado en quantities';
				await this.quantityImportRepository.save(existing);
				result.changedInSource++;
				await this.notifyQuantityDifference(holdingId, existing, { diffs });
				continue;
			}

			this.assignQuantityImportPayload(existing, normalized);
			existing.integration_status = initialStatus;
			existing.integration_reason = null;
			await this.quantityImportRepository.save(existing);
			result.updated++;
		}

		this.logger.log(
			`✓ Ingesta cantidades holding ${holdingId} [${resolvedRange.from}, ${resolvedRange.to}]: ` +
				`dwh=${result.totalFromDwh}, nuevas=${result.inserted}, actualizadas=${result.updated}, ` +
				`sin cambios=${result.unchanged}, cambiadas tras integrar=${result.changedInSource}, ` +
				`sin datos de cantidad=${result.noQuantityData}, descartadas=${result.discarded}`
		);

		return result;
	}

	/**
	 * Resuelve los `contract_items` candidatos con una sola query por holding.
	 *
	 * El `WHERE ci.holding_id = $1` es un guard de tenancy obligatorio: la conexión de TypeORM usa
	 * credenciales de servicio y NO pasa por RLS, a diferencia del front.
	 */
	private async loadContractItemCandidates(holdingId: string, contractItemIds: string[], quoteLineIds: string[]): Promise<ContractItemCandidate[]> {
		return this.dataSource.query(
			`SELECT ci.id, ci.contract_id, ci.holding_id, ci.quote_item_number,
			        ci.unit_price, ci.quantity, ci.currency AS item_currency,
			        c.salesforce_opportunity_id, c.currency AS contract_currency
			 FROM contract_items ci
			 JOIN contracts c ON c.id = ci.contract_id
			 WHERE ci.holding_id = $1
			   AND (ci.id = ANY($2::uuid[]) OR ci.quote_item_number = ANY($3::text[]))`,
			[holdingId, contractItemIds, quoteLineIds]
		);
	}

	private numericEquals(a: unknown, b: unknown): boolean {
		const toNumber = (value: unknown): number | null => {
			if (value === null || value === undefined || value === '') {
				return null;
			}
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		};

		const left = toNumber(a);
		const right = toNumber(b);
		return left === right;
	}

	private textEquals(a: string | null | undefined, b: string | null | undefined): boolean {
		const normalize = (value: string | null | undefined) => {
			const trimmed = (value ?? '').trim();
			return trimmed === '' ? null : trimmed;
		};

		return normalize(a) === normalize(b);
	}

	/**
	 * Espejo de `isVariableItem()` del front (src/utils/variablePricingUtils.ts): un ítem es
	 * variable cuando tiene precio unitario y cantidad base mayor a cero.
	 */
	private isVariableContractItem(candidate: ContractItemCandidate): boolean {
		if (candidate.unit_price === null || candidate.unit_price === undefined) {
			return false;
		}

		const quantity = Number(candidate.quantity);
		return Number.isFinite(quantity) && quantity > 0;
	}

	/**
	 * Resuelve el `contract_item` de una fila del DWH replicando la precedencia del trigger
	 * `quantities_set_holding_from_contract_item()`:
	 *   1º par Sapira (`sapira_contract_item_id`) · 2º par Salesforce (`quote_line_id` +
	 *   `opportunity_id`) · ambos nulos o sin match → sin mapeo.
	 *
	 * En los datos reales del DWH los IDs Sapira vienen NULL, así que el paso 2 es el que resuelve
	 * casi todo.
	 */
	private resolveContractItemForImport(
		importRow: SapiraQuantityImport,
		byId: Map<string, ContractItemCandidate>,
		byQuoteItemNumber: Map<string, ContractItemCandidate[]>
	): { candidate?: ContractItemCandidate; source?: QuantityImportResolutionSource; status?: QuantityImportStatus; reason?: string } {
		const sapiraItemId = importRow.sapira_contract_item_id?.trim();
		if (sapiraItemId && UUID_PATTERN.test(sapiraItemId)) {
			const candidate = byId.get(sapiraItemId.toLowerCase());
			if (candidate) {
				return { candidate, source: 'sapira_ids' };
			}
		}

		const quoteLineId = importRow.quote_line_id?.trim();
		if (quoteLineId) {
			const matches = byQuoteItemNumber.get(quoteLineId) ?? [];

			// Acotar por oportunidad evita colisiones entre clientes distintos que comparten
			// número de línea. Igual que el trigger, si la oportunidad no acota nada se usa el
			// match sin filtrar.
			const opportunityId = importRow.opportunity_id?.trim();
			const scoped = opportunityId ? matches.filter((match) => match.salesforce_opportunity_id === opportunityId) : [];
			const effective = scoped.length > 0 ? scoped : matches;

			if (effective.length === 1) {
				return { candidate: effective[0], source: 'salesforce_ids' };
			}

			if (effective.length > 1) {
				return {
					status: 'ambiguous',
					reason: `El quote_line_id ${quoteLineId} matchea ${effective.length} contract_items; no se puede desambiguar`,
				};
			}
		}

		if (!sapiraItemId && !quoteLineId) {
			return {
				status: 'unmapped',
				reason: 'La fila del DWH no trae ni IDs Sapira ni IDs de Salesforce: no es mapeable',
			};
		}

		return {
			status: 'unmapped',
			reason: `No se encontró contract_item para sapira_contract_item_id=${sapiraItemId ?? '—'} / quote_line_id=${quoteLineId ?? '—'}`,
		};
	}

	/**
	 * Fase 2 — Integración: `sapira_quantity_imports` → `quantities`. No consulta BigQuery.
	 *
	 * Con `retryFailed` reprocesa además los estados recuperables, que es el camino para
	 * recuperar filas después de poblar `quote_item_number` o de anular una factura.
	 */
	async integrateSapiraQuantities(
		holdingId: string,
		options: { retryFailed?: boolean; range?: { from?: string; to?: string } } = {}
	): Promise<QuantitiesIntegrationResult> {
		if (!holdingId) {
			throw new BadRequestException('El header x-holding-id es requerido');
		}

		const resolvedRange = this.resolveDateRange(options.range);
		const { periodFrom, periodTo } = this.toPeriodBounds(resolvedRange);
		const statuses: QuantityImportStatus[] = options.retryFailed ? ['pending', ...RETRYABLE_IMPORT_STATUSES] : ['pending'];

		// Acotar por `period` es lo que hace segmentable a la fase 2: sin este filtro, integrar un mes
		// pasado arrastraría también lo pendiente de cualquier otro período del holding.
		const pending = await this.quantityImportRepository.find({
			where: {
				holding_id: holdingId,
				integration_status: In(statuses),
				period: Between(periodFrom, periodTo),
			},
			order: { billing_date: 'ASC' },
		});

		const result: QuantitiesIntegrationResult = {
			holdingId,
			range: resolvedRange,
			totalProcessed: pending.length,
			integrated: 0,
			unmapped: 0,
			notVariable: 0,
			currencyMismatch: 0,
			blocked: 0,
			ambiguous: 0,
			conflict: 0,
		};

		if (pending.length === 0) {
			await this.notifyQuantitiesAggregates(holdingId, result, resolvedRange);
			return result;
		}

		const contractItemIds = [
			...new Set(
				pending
					.map((row) => row.sapira_contract_item_id?.trim())
					.filter((value): value is string => Boolean(value) && UUID_PATTERN.test(value as string))
			),
		];
		const quoteLineIds = [...new Set(pending.map((row) => row.quote_line_id?.trim()).filter((value): value is string => Boolean(value)))];

		const candidates = await this.loadContractItemCandidates(holdingId, contractItemIds, quoteLineIds);
		const byId = new Map(candidates.map((candidate) => [candidate.id.toLowerCase(), candidate]));
		const byQuoteItemNumber = new Map<string, ContractItemCandidate[]>();
		for (const candidate of candidates) {
			if (!candidate.quote_item_number) {
				continue;
			}
			const bucket = byQuoteItemNumber.get(candidate.quote_item_number) ?? [];
			bucket.push(candidate);
			byQuoteItemNumber.set(candidate.quote_item_number, bucket);
		}

		// Resolver, filtrar y validar antes de tocar quantities.
		const resolved: Array<{ importRow: SapiraQuantityImport; candidate: ContractItemCandidate }> = [];

		for (const importRow of pending) {
			const resolution = this.resolveContractItemForImport(importRow, byId, byQuoteItemNumber);

			if (!resolution.candidate) {
				await this.markImport(importRow, resolution.status ?? 'unmapped', resolution.reason ?? null);
				this.countImportOutcome(result, resolution.status ?? 'unmapped');
				continue;
			}

			const candidate = resolution.candidate;
			importRow.resolved_contract_item_id = candidate.id;
			importRow.resolved_contract_id = candidate.contract_id;
			importRow.resolution_source = resolution.source ?? null;

			if (!this.isVariableContractItem(candidate)) {
				await this.markImport(
					importRow,
					'not_variable',
					'El contract_item no es variable (requiere unit_price definido y quantity > 0 en el contrato base)'
				);
				result.notVariable++;
				continue;
			}

			// quantities no tiene columna de moneda: el unit_price se interpreta como moneda de
			// contrato. Integrar una fila en otra moneda produciría montos silenciosamente erróneos.
			const contractCurrency = candidate.item_currency ?? candidate.contract_currency;
			if (importRow.currency && contractCurrency && !this.textEquals(importRow.currency, contractCurrency)) {
				await this.markImport(
					importRow,
					'currency_mismatch',
					`El DWH informa ${importRow.currency} y el contrato está en ${contractCurrency}`
				);
				result.currencyMismatch++;
				continue;
			}

			resolved.push({ importRow, candidate });
		}

		// Deduplicar por la clave natural de quantities: dos filas del DWH que apunten al mismo
		// (contract_item_id, period) con valores distintos no se integran.
		const byTarget = new Map<string, Array<{ importRow: SapiraQuantityImport; candidate: ContractItemCandidate }>>();
		for (const entry of resolved) {
			const key = `${entry.candidate.id}|${entry.importRow.period}`;
			const bucket = byTarget.get(key) ?? [];
			bucket.push(entry);
			byTarget.set(key, bucket);
		}

		for (const [, bucket] of byTarget) {
			if (bucket.length > 1) {
				const distinct = new Set(
					bucket.map((entry) =>
						[entry.importRow.quantity, entry.importRow.unit_price, entry.importRow.unit_of_measure, entry.importRow.account].join('|')
					)
				);

				if (distinct.size > 1) {
					for (const entry of bucket) {
						await this.markImport(
							entry.importRow,
							'ambiguous',
							`El DWH trae ${bucket.length} filas para el mismo contract_item y período con valores distintos`
						);
						result.ambiguous++;
					}
					continue;
				}
			}

			// Duplicados idénticos: se integra el primero y los demás quedan apuntando a la misma fila.
			const [first, ...rest] = bucket;
			const outcome = await this.integrateSingleQuantity(holdingId, first.importRow);
			this.countImportOutcome(result, outcome.status);

			for (const duplicate of rest) {
				duplicate.importRow.quantity_id = outcome.quantityId ?? null;
				await this.markImport(duplicate.importRow, outcome.status, outcome.reason);
				this.countImportOutcome(result, outcome.status);
			}
		}

		await this.notifyQuantitiesAggregates(holdingId, result, resolvedRange);

		this.logger.log(
			`✓ Integración cantidades holding ${holdingId} [${resolvedRange.from}, ${resolvedRange.to}]: ` +
				`procesadas=${result.totalProcessed}, integradas=${result.integrated}, ` +
				`sin mapeo=${result.unmapped}, no variables=${result.notVariable}, moneda distinta=${result.currencyMismatch}, ` +
				`bloqueadas=${result.blocked}, ambiguas=${result.ambiguous}, en conflicto=${result.conflict}`
		);

		return result;
	}

	/**
	 * Inserta una fila en `quantities` respetando la semántica insert-only.
	 *
	 * Cada INSERT va aislado en su propio try/catch porque
	 * `trg_validate_quantity_invoice_status` lanza excepción cuando la factura activa del período
	 * no está en "Por Emitir": sin esto, una sola factura emitida tumbaría el batch completo.
	 */
	private async integrateSingleQuantity(
		holdingId: string,
		importRow: SapiraQuantityImport
	): Promise<{ status: QuantityImportStatus; reason: string | null; quantityId: string | null }> {
		const contractItemId = importRow.resolved_contract_item_id as string;

		const existingRows: QuantityRecord[] = await this.dataSource.query(
			`SELECT id, unit_price, quantity, unit_of_measure, account
			 FROM quantities
			 WHERE contract_item_id = $1 AND period = $2`,
			[contractItemId, importRow.period]
		);

		if (existingRows.length > 0) {
			return this.reconcileExistingQuantity(holdingId, importRow, existingRows[0]);
		}

		try {
			// No se mandan holding_id (lo deriva trg_quantities_set_holding) ni amount (se llena
			// por otro lado y ganaría al COALESCE del trigger de RSM).
			const inserted: Array<{ id: string }> = await this.dataSource.query(
				`INSERT INTO quantities (contract_item_id, contract_id, period, unit_price, quantity,
				                         unit_of_measure, account, salesforce_opportunity_id,
				                         salesforce_line_item_id, notes)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 ON CONFLICT (contract_item_id, period) DO NOTHING
				 RETURNING id`,
				[
					contractItemId,
					importRow.resolved_contract_id,
					importRow.period,
					importRow.unit_price,
					importRow.quantity,
					importRow.unit_of_measure,
					importRow.account,
					importRow.opportunity_id,
					importRow.quote_line_id,
					`${QUANTITY_IMPORT_NOTES_SOURCE} · sf_id=${importRow.sf_id}`,
				]
			);

			if (inserted.length === 0) {
				// Carrera: otro proceso insertó la fila entremedio. Se reevalúa como existente.
				const raced: QuantityRecord[] = await this.dataSource.query(
					`SELECT id, unit_price, quantity, unit_of_measure, account
					 FROM quantities
					 WHERE contract_item_id = $1 AND period = $2`,
					[contractItemId, importRow.period]
				);

				if (raced.length > 0) {
					return this.reconcileExistingQuantity(holdingId, importRow, raced[0]);
				}

				return { status: 'blocked', reason: 'El INSERT no retornó fila y no se encontró el registro existente', quantityId: null };
			}

			importRow.quantity_id = inserted[0].id;
			importRow.integrated_at = new Date();
			await this.markImport(importRow, 'integrated', null);
			await this.notificationsService.resolveByDeduplicationKey(holdingId, this.quantityDiffDedupKey(holdingId, importRow));

			return { status: 'integrated', reason: null, quantityId: inserted[0].id };
		} catch (error) {
			const reason = error?.message ?? 'Error desconocido al insertar en quantities';
			this.logger.warn(`No se pudo integrar la cantidad ${importRow.sf_id} (${importRow.period}): ${reason}`);
			await this.markImport(importRow, 'blocked', reason);

			return { status: 'blocked', reason, quantityId: null };
		}
	}

	/** Decide qué hacer cuando ya existe un override para (contract_item_id, period). */
	private async reconcileExistingQuantity(
		holdingId: string,
		importRow: SapiraQuantityImport,
		existing: QuantityRecord
	): Promise<{ status: QuantityImportStatus; reason: string | null; quantityId: string | null }> {
		const isSame =
			this.numericEquals(existing.unit_price, importRow.unit_price) &&
			this.numericEquals(existing.quantity, importRow.quantity) &&
			this.textEquals(existing.unit_of_measure, importRow.unit_of_measure) &&
			this.textEquals(existing.account, importRow.account);

		importRow.quantity_id = existing.id;

		if (isSame) {
			importRow.integrated_at = importRow.integrated_at ?? new Date();
			await this.markImport(importRow, 'integrated', null);
			await this.notificationsService.resolveByDeduplicationKey(holdingId, this.quantityDiffDedupKey(holdingId, importRow));

			return { status: 'integrated', reason: null, quantityId: existing.id };
		}

		// Diff contra el override existente, solo sobre los campos que sí se propagan a quantities.
		const diffs = QUANTITY_INTEGRATED_FIELDS.flatMap((field) => {
			const current = existing[field] ?? null;
			const next = importRow[field] ?? null;
			const equal =
				field === 'unit_price' || field === 'quantity'
					? this.numericEquals(current, next)
					: this.textEquals(current as string, next as string);

			return equal ? [] : [{ field, current: current === null ? null : String(current), incoming: next === null ? null : String(next) }];
		});

		const reason = 'Ya existe un override para este ítem y período con valores distintos; no se sobrescribe automáticamente';
		await this.markImport(importRow, 'conflict', reason);
		await this.notifyQuantityDifference(holdingId, importRow, { diffs, current: existing });

		return { status: 'conflict', reason, quantityId: existing.id };
	}

	private async markImport(importRow: SapiraQuantityImport, status: QuantityImportStatus, reason: string | null): Promise<void> {
		importRow.integration_status = status;
		importRow.integration_reason = reason;
		await this.quantityImportRepository.save(importRow);
	}

	private countImportOutcome(result: QuantitiesIntegrationResult, status: QuantityImportStatus): void {
		switch (status) {
			case 'integrated':
				result.integrated++;
				break;
			case 'unmapped':
				result.unmapped++;
				break;
			case 'not_variable':
				result.notVariable++;
				break;
			case 'currency_mismatch':
				result.currencyMismatch++;
				break;
			case 'blocked':
				result.blocked++;
				break;
			case 'ambiguous':
				result.ambiguous++;
				break;
			case 'conflict':
				result.conflict++;
				break;
			default:
				break;
		}
	}

	private quantityDiffDedupKey(holdingId: string, importRow: SapiraQuantityImport): string {
		return `bigquery-quantities-diff:${holdingId}:${importRow.id}`;
	}

	/**
	 * Notificación POR FILA: es la única que la necesita, porque el botón de reemplazo del front
	 * requiere el `quantity_id` concreto.
	 */
	private async notifyQuantityDifference(
		holdingId: string,
		importRow: SapiraQuantityImport,
		options: { diffs: QuantityImportDiff[]; current?: QuantityRecord | null }
	): Promise<void> {
		const { diffs, current = null } = options;

		// `changed_in_source` puede traer diffs en campos que no se integran (country, tin…).
		// En ese caso la notificación es informativa: el reemplazo reaplica los valores vigentes.
		const afectaIntegracion = diffs.some((diff) => (QUANTITY_INTEGRATED_FIELDS as readonly string[]).includes(diff.field));

		await this.notificationsService.createOrUpdate(holdingId, {
			source: 'bigquery',
			type: QUANTITIES_DIFF_NOTIFICATION_TYPE,
			severity: 'warning',
			title: `Diferencias en cantidad variable (${importRow.business_name || importRow.sf_id})`,
			message: current
				? `La cantidad variable de ${importRow.product} para el período ${importRow.period} difiere entre el DWH y el ` +
					'override ya registrado en Sapira. No se sobrescribió automáticamente.'
				: `El DWH modificó ${importRow.product} (${importRow.period}) después de haberse integrado. ` +
					`${afectaIntegracion ? 'El cambio afecta valores ya propagados a Sapira.' : 'El cambio no afecta los valores propagados a Sapira.'}`,
			recommendation: afectaIntegracion
				? 'Revisa las diferencias y usa "Reemplazar con datos de BigQuery" si el valor del DWH es el correcto.'
				: 'Revisa las diferencias. Si el cambio del DWH es esperado, reemplaza para dejar constancia y cerrar el aviso.',
			action_type: REPLACE_QUANTITY_RECORD_ACTION,
			action_payload: {
				quantity_id: importRow.quantity_id,
				import_id: importRow.id,
				incoming: {
					unit_price: importRow.unit_price,
					quantity: importRow.quantity,
					unit_of_measure: importRow.unit_of_measure,
					account: importRow.account,
				},
			},
			metadata: {
				sf_id: importRow.sf_id,
				product: importRow.product,
				period: importRow.period,
				contract_item_id: importRow.resolved_contract_item_id,
				// El front renderiza esta tabla de diferencias (campo / actual / entrante).
				differences: diffs,
				current: current
					? {
							unit_price: current.unit_price,
							quantity: current.quantity,
							unit_of_measure: current.unit_of_measure,
							account: current.account,
						}
					: null,
			},
			deduplication_key: this.quantityDiffDedupKey(holdingId, importRow),
		});
	}

	/**
	 * Notificaciones AGREGADAS: una por holding y corrida, no una por fila.
	 *
	 * En los datos reales del DWH hay muchas filas sin IDs de mapeo, así que notificar fila a fila
	 * generaría cientos de notificaciones por noche. El detalle vive en `sapira_quantity_imports`,
	 * que es consultable vía `GET /bigquery/quantities/imports`.
	 *
	 * La clave de deduplicación lleva el rango PROCESADO, no el mes en curso. Es crítico: con la
	 * clave fija del mes actual, un backfill de un período pasado sin filas problemáticas ejecutaría
	 * `resolveByDeduplicationKey` sobre la alerta vigente del mes en curso y la cerraría en silencio.
	 */
	private async notifyQuantitiesAggregates(holdingId: string, result: QuantitiesIntegrationResult, range: QuantitiesDateRange): Promise<void> {
		const ventana = `${range.from} a ${range.to}`;

		const aggregates: Array<{ type: string; count: number; title: string; message: string; recommendation: string }> = [
			{
				type: QUANTITIES_UNMAPPED_NOTIFICATION_TYPE,
				count: result.unmapped,
				title: `Cantidades variables sin mapeo (${result.unmapped})`,
				message:
					`${result.unmapped} fila(s) del DWH del rango ${ventana} no se pudieron asociar a un ítem de contrato ` +
					'porque no traen IDs Sapira ni IDs de Salesforce válidos.',
				recommendation:
					'Revisa el listado en la auditoría del canal automático. Suele resolverse poblando contract_items.quote_item_number ' +
					'desde la cotización; después puedes reprocesar sin volver a consultar BigQuery.',
			},
			{
				type: QUANTITIES_BLOCKED_NOTIFICATION_TYPE,
				count: result.blocked,
				title: `Cantidades variables bloqueadas por estado de factura (${result.blocked})`,
				message:
					`${result.blocked} fila(s) del rango ${ventana} no se integraron porque la factura activa del período ` +
					'no está en estado "Por Emitir".',
				recommendation: 'Anula las facturas involucradas para que vuelvan a "Por Emitir" y reprocesa la integración.',
			},
			{
				type: QUANTITIES_CURRENCY_MISMATCH_NOTIFICATION_TYPE,
				count: result.currencyMismatch,
				title: `Cantidades variables con moneda distinta a la del contrato (${result.currencyMismatch})`,
				message:
					`${result.currencyMismatch} fila(s) del rango ${ventana} informan una moneda distinta a la del contrato. ` +
					'No se integraron para evitar montos erróneos: quantities no tiene columna de moneda.',
				recommendation: 'Verifica la moneda en el DWH o en el contrato antes de reprocesar.',
			},
		];

		for (const aggregate of aggregates) {
			const deduplicationKey = `${aggregate.type}:${holdingId}:${range.from}:${range.to}`;

			if (aggregate.count === 0) {
				await this.notificationsService.resolveByDeduplicationKey(holdingId, deduplicationKey);
				continue;
			}

			await this.notificationsService.createOrUpdate(holdingId, {
				source: 'bigquery',
				type: aggregate.type,
				severity: 'warning',
				title: aggregate.title,
				message: aggregate.message,
				recommendation: aggregate.recommendation,
				metadata: { range_from: range.from, range_to: range.to, count: aggregate.count },
				deduplication_key: deduplicationKey,
			});
		}
	}

	/**
	 * Fase 1 + fase 2 en una sola llamada. Es lo que ejecuta el scheduler diario (sin rango, o sea
	 * el mes en curso) y también el backfill acotado.
	 *
	 * El rango se resuelve UNA sola vez y se pasa explícito a ambas fases: si cada una lo resolviera
	 * por su cuenta, una corrida iniciada justo al cambiar el mes podría ingerir una ventana e
	 * integrar otra.
	 */
	async syncSapiraQuantities(holdingId: string, range?: { from?: string; to?: string }): Promise<SapiraQuantitiesSyncResult> {
		const resolvedRange = this.resolveDateRange(range);
		const ingest = await this.ingestSapiraQuantities(holdingId, resolvedRange);
		const integration = await this.integrateSapiraQuantities(holdingId, { range: resolvedRange });

		return { holdingId, range: resolvedRange, ingest, integration };
	}

	/** Listado de auditoría: por qué entró (o no) cada fila del DWH. */
	async listQuantityImports(holdingId: string, filters: ListQuantityImportsDto): Promise<{ total: number; items: SapiraQuantityImport[] }> {
		if (!holdingId) {
			throw new BadRequestException('El header x-holding-id es requerido');
		}

		const where: Record<string, unknown> = { holding_id: holdingId };
		if (filters.integration_status) {
			where.integration_status = filters.integration_status;
		}

		// `period` puntual gana sobre el rango: es el filtro más específico.
		if (filters.period) {
			where.period = filters.period;
		} else if (filters.from || filters.to) {
			const { periodFrom, periodTo } = this.toPeriodBounds(this.resolveDateRange({ from: filters.from, to: filters.to }));
			where.period = Between(periodFrom, periodTo);
		}

		const [items, total] = await this.quantityImportRepository.findAndCount({
			where,
			order: { synced_at: 'DESC' },
			take: filters.limit ?? 100,
			skip: filters.offset ?? 0,
		});

		return { total, items };
	}

	/**
	 * Aplica los valores del DWH sobre un override existente de `quantities` y resuelve la
	 * notificación. Es la contraparte manual de la semántica insert-only.
	 */
	async replaceQuantityRecord(holdingId: string, quantityId: string, incoming: ReplaceQuantityRecordDto): Promise<QuantityRecord> {
		if (!holdingId) {
			throw new BadRequestException('El header x-holding-id es requerido');
		}

		const existing: QuantityRecord[] = await this.dataSource.query(
			`SELECT id, unit_price, quantity, unit_of_measure, account
			 FROM quantities
			 WHERE id = $1 AND holding_id = $2`,
			[quantityId, holdingId]
		);

		if (existing.length === 0) {
			throw new NotFoundException('Registro de quantities no encontrado para el holding');
		}

		// amount queda fuera a propósito: el canal automático nunca lo escribe.
		const updated: QuantityRecord[] = await this.dataSource.query(
			`UPDATE quantities
			 SET unit_price = $3, quantity = $4, unit_of_measure = $5, account = $6, updated_at = now()
			 WHERE id = $1 AND holding_id = $2
			 RETURNING id, unit_price, quantity, unit_of_measure, account`,
			[
				quantityId,
				holdingId,
				incoming.unit_price ?? null,
				incoming.quantity ?? null,
				incoming.unit_of_measure ?? null,
				incoming.account ?? null,
			]
		);

		const relatedImports = await this.quantityImportRepository.find({ where: { holding_id: holdingId, quantity_id: quantityId } });
		for (const importRow of relatedImports) {
			importRow.integrated_at = new Date();
			await this.markImport(importRow, 'integrated', null);
			await this.notificationsService.resolveByDeduplicationKey(holdingId, this.quantityDiffDedupKey(holdingId, importRow));
		}

		return updated[0];
	}
}
