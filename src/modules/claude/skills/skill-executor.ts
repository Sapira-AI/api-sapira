import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DynamicQueryBuilder } from './query-builder';
import { SkillDefinition, SkillExecutionContext, SkillExecutionResult } from './skill-definition.interface';

// Paleta de colores para series múltiples (bar_stacked, etc.)
const SERIES_COLORS = [
	'#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
	'#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
];

@Injectable()
export class SkillExecutor {
	private readonly logger = new Logger(SkillExecutor.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly queryBuilder: DynamicQueryBuilder
	) {}

	async executeSkill(skill: SkillDefinition, context: SkillExecutionContext): Promise<SkillExecutionResult> {
		try {
			this.logger.log(`Ejecutando skill: ${skill.name}`);

			const params = this.processParameters(skill, context.parameters);

			const { query, values } = this.buildQueryForSkill(skill, params, context.holdingId);

			this.logger.debug(`Query: ${query}`);
			this.logger.debug(`Values: ${JSON.stringify(values)}`);

			const results = await this.dataSource.query(query, values);

			this.logger.log(`Skill ${skill.name} ejecutada exitosamente. Resultados: ${results.length} filas`);

			if (results.length === 0) {
				// Sin datos: no generar widgets, usar mensaje contextual si existe
				return {
					success: true,
					data: [],
					message: skill.emptyMessage || 'No se encontraron datos para los criterios especificados.',
				};
			}

			const response: SkillExecutionResult = {
				success: true,
				message: 'Datos obtenidos exitosamente',
				data: results,
			};

			this.logger.debug(`Skill: ${skill.name} | include_widgets: ${params.include_widgets}`);

			if (params.include_widgets && skill.response.widgetConfig) {
				response.widgets = this.generateWidgets(results, skill);
			}

			return response;
		} catch (error) {
			this.logger.error(`Error ejecutando skill ${skill.name}:`, error);
			return this.handleQueryError(error, skill.name);
		}
	}

	private processParameters(skill: SkillDefinition, rawParams: any): any {
		const processed: any = {};

		for (const [paramName, paramSchema] of Object.entries(skill.parameters.schema)) {
			let value = rawParams[paramName];

			if (value === undefined || value === null) {
				if (paramSchema.default !== undefined) {
					value = paramSchema.default;
				} else if (skill.parameters.required.includes(paramName)) {
					throw new Error(`Parámetro requerido faltante: ${paramName}`);
				} else {
					continue;
				}
			}

			processed[paramName] = value;
		}

		// snapshot: ambas fechas al primer día del mes actual
		if (processed.mode === 'snapshot' && !processed.date_to) {
			const today = new Date();
			const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
			processed.date_to = firstDayOfMonth.toISOString().split('T')[0];
			processed.date_from = processed.date_to;
		}

		// series con months_back: calcular rango (también aplica si no hay mode pero hay months_back)
		if (!processed.date_from && processed.months_back) {
			const today = new Date();
			const toDate = new Date(today.getFullYear(), today.getMonth(), 1);
			const fromDate = new Date(toDate);
			fromDate.setMonth(fromDate.getMonth() - (processed.months_back - 1));

			processed.date_from = fromDate.toISOString().split('T')[0];
			processed.date_to = toDate.toISOString().split('T')[0];
		}

		// Cap universal: si no hay date_to definido, limitar al mes actual para evitar datos futuros
		if (!processed.date_to && processed.mode !== 'snapshot') {
			const today = new Date();
			const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
			processed.date_to = firstDayOfMonth.toISOString().split('T')[0];
		}

		// Calcular mes/año actual si no se proporcionan (para invoice skills)
		if (!processed.month) {
			const today = new Date();
			processed.month = today.getMonth() + 1;
		}
		if (!processed.year) {
			const today = new Date();
			processed.year = today.getFullYear();
		}

		// Calcular fecha límite para contratos por vencer si se proporciona days_ahead
		if (processed.days_ahead && typeof processed.days_ahead === 'number') {
			const today = new Date();
			const futureDate = new Date(today);
			futureDate.setDate(futureDate.getDate() + processed.days_ahead);
			processed.date_to_calculated = futureDate.toISOString().split('T')[0];
		}

		return processed;
	}

	private buildQueryForSkill(skill: SkillDefinition, params: any, holdingId: string): { query: string; values: any[] } {
		let baseQuery = skill.database.baseQuery;

		const currencyMode = params.currency_mode || 'system';
		const mrrColumnLegacy = this.getMrrColumn('legacy', currencyMode);
		const mrrColumnRsm = this.getMrrColumn('rsm', currencyMode);
		const cmrrColumn = this.getCmrrColumn(currencyMode);
		const mrrColumn = this.getMrrColumnRsm(currencyMode);
		const recognizedColumn = this.getRecognizedColumn(currencyMode);
		const deferredColumn = this.getDeferredColumn(currencyMode);
		const unbilledColumn = this.getUnbilledColumn(currencyMode);

		baseQuery = baseQuery.replace(/\{\{MRR_COLUMN_LEGACY\}\}/g, mrrColumnLegacy);
		baseQuery = baseQuery.replace(/\{\{MRR_COLUMN_RSM\}\}/g, mrrColumnRsm);
		baseQuery = baseQuery.replace(/\{\{CMRR_COLUMN\}\}/g, cmrrColumn);
		baseQuery = baseQuery.replace(/\{\{MRR_COLUMN\}\}/g, mrrColumn);
		baseQuery = baseQuery.replace(/\{\{RECOGNIZED_COLUMN\}\}/g, recognizedColumn);
		baseQuery = baseQuery.replace(/\{\{DEFERRED_COLUMN\}\}/g, deferredColumn);
		baseQuery = baseQuery.replace(/\{\{UNBILLED_COLUMN\}\}/g, unbilledColumn);

		// Copiar groupBy inmutablemente para no mutar el singleton del catálogo
		let groupBy = [...(skill.database.groupBy || [])];

		if (params.group_by && Array.isArray(params.group_by)) {
			const groupByColumns = params.group_by.map((col: string) => `${col},`).join(' ');
			baseQuery = baseQuery.replace('{{GROUP_BY_COLUMNS}}', groupByColumns);
			groupBy = [...groupBy, ...params.group_by];
		} else {
			baseQuery = baseQuery.replace('{{GROUP_BY_COLUMNS}}', '');
		}

		const modifiedSkill = { ...skill, database: { ...skill.database, baseQuery, groupBy } };

		return this.queryBuilder.buildQuery(modifiedSkill, params, holdingId);
	}

	private getMrrColumn(table: 'legacy' | 'rsm', currencyMode: string): string {
		if (table === 'legacy') {
			switch (currencyMode) {
				case 'system':
					return 'mrr_legacy_system_currency';
				case 'contract':
					return 'mrr_legacy';
				case 'company':
					return 'mrr_legacy';
				default:
					return 'mrr_legacy_system_currency';
			}
		} else {
			switch (currencyMode) {
				case 'system':
					return 'mrr_period_system_ccy';
				case 'contract':
					return 'mrr_period_contract_ccy';
				case 'company':
					return 'mrr_period_ccy';
				default:
					return 'mrr_period_system_ccy';
			}
		}
	}

	private getCmrrColumn(currencyMode: string): string {
		switch (currencyMode) {
			case 'system':
				return 'cmrr_period_system_ccy';
			case 'contract':
				return 'cmrr_period_contract_ccy';
			case 'company':
				return 'cmrr_period_ccy';
			default:
				return 'cmrr_period_system_ccy';
		}
	}

	private getMrrColumnRsm(currencyMode: string): string {
		switch (currencyMode) {
			case 'system':
				return 'mrr_period_system_ccy';
			case 'contract':
				return 'mrr_period_contract_ccy';
			case 'company':
				return 'mrr_period_ccy';
			default:
				return 'mrr_period_system_ccy';
		}
	}

	private getRecognizedColumn(currencyMode: string): string {
		switch (currencyMode) {
			case 'system':
				return 'recognized_period_system_ccy';
			case 'contract':
				return 'recognized_period_contract_ccy';
			case 'company':
				return 'recognized_period_ccy';
			default:
				return 'recognized_period_system_ccy';
		}
	}

	private getDeferredColumn(currencyMode: string): string {
		switch (currencyMode) {
			case 'system':
				return 'deferred_balance_eom_system_ccy';
			case 'contract':
				return 'deferred_balance_eom_contract_ccy';
			case 'company':
				return 'deferred_balance_eom_ccy';
			default:
				return 'deferred_balance_eom_system_ccy';
		}
	}

	private getUnbilledColumn(currencyMode: string): string {
		switch (currencyMode) {
			case 'system':
				return 'unbilled_balance_eom_system_ccy';
			case 'contract':
				return 'unbilled_balance_eom_contract_ccy';
			case 'company':
				return 'unbilled_balance_eom_ccy';
			default:
				return 'unbilled_balance_eom_system_ccy';
		}
	}

	private generateWidgets(data: any[], skill: SkillDefinition): any[] {
		if (!skill.response.widgetConfig) {
			return [];
		}

		const config = skill.response.widgetConfig;
		const widgets: any[] = [];

		// Caso especial: facturas por emitir — KPI con totales del CTE
		if (skill.name === 'get_invoices_to_issue' && data.length > 0 && data[0].total_count !== undefined) {
			widgets.push({
				type: 'kpi',
				title: 'Total Facturas Pendientes',
				value: `${data[0].total_count || 0} facturas`,
			});
		}

		// Gráfico de barras apiladas con múltiples series (una por valor único de seriesKey)
		if (config.type === 'bar_stacked') {
			const xKey = config.xAxis || 'period_month';
			const yKey = config.yAxis || 'mrr';
			const seriesKey = config.seriesKey || 'company_name';

			// Extraer series únicas preservando orden de aparición
			const seriesNames: string[] = [];
			data.forEach((row) => {
				const name = String(row[seriesKey] ?? 'Sin nombre');
				if (!seriesNames.includes(name)) seriesNames.push(name);
			});

			// Pivotar: { period_month: { Company_A: mrr, Company_B: mrr } }
			const pivotMap: Record<string, Record<string, number>> = {};
			const xOrder: string[] = [];
			data.forEach((row) => {
				const xVal = String(row[xKey] ?? '');
				const sName = String(row[seriesKey] ?? 'Sin nombre');
				const yVal = Number(row[yKey]) || 0;
				if (!pivotMap[xVal]) {
					pivotMap[xVal] = {};
					xOrder.push(xVal);
				}
				// Sumar en caso de duplicados
				pivotMap[xVal][sName] = (pivotMap[xVal][sName] || 0) + yVal;
			});

			// Construir array de datos pivotado
			const pivotedData = xOrder.map((xVal) => {
				const row: Record<string, any> = { [xKey]: xVal };
				seriesNames.forEach((name) => {
					row[name] = pivotMap[xVal][name] ?? 0;
				});
				return row;
			});

			// Construir array de series con colores
			const series = seriesNames.map((name, idx) => ({
				key: name,
				name: name,
				color: SERIES_COLORS[idx % SERIES_COLORS.length],
			}));

			widgets.push({
				type: 'chart_bar_stacked',
				title: config.title || skill.name,
				xKey: xKey,
				series: series,
				data: pivotedData,
			});
		}

		if (config.type === 'line' || config.type === 'bar' || config.type === 'area') {
			const xKey = config.xAxis || 'period_month';
			const yKey = config.yAxis || 'mrr';

			const widgetType = config.type === 'line' ? 'chart_line' : config.type === 'bar' ? 'chart_bar' : 'chart_line';

			const yValues = data.map((item) => Number(item[yKey]) || 0);
			const maxValue = Math.max(...yValues);

			widgets.push({
				type: widgetType,
				title: config.title || skill.name,
				xKey: xKey,
				series: [
					{
						key: yKey,
						name: this.formatSeriesName(yKey),
						color: config.type === 'line' ? '#8b5cf6' : '#3b82f6',
					},
				],
				data: data,
				yAxisConfig: {
					min: 0,
					max: maxValue * 1.1,
					formatWithThousandsSeparator: true,
				},
			});
		}

		if (config.type === 'table') {
			const columns = config.columns || Object.keys(data[0] || {});

			const keepIndices: number[] = [];
			const displayColumns: string[] = [];

			columns.forEach((col, idx) => {
				const colLower = col.toLowerCase();
				if (colLower.includes('_id') || colLower === 'id' || colLower.includes('holding') || colLower.includes('tenant')) {
					return;
				}
				keepIndices.push(idx);
				displayColumns.push(config.columnLabels?.[col] || col);
			});

			const rows = data.map((row) =>
				keepIndices.map((idx) => {
					const col = columns[idx];
					const value = row[col];

					if (config.format?.[col] === 'month-year' && value) {
						try {
							const date = new Date(value);
							const month = String(date.getMonth() + 1).padStart(2, '0');
							const year = date.getFullYear();
							return `${month}/${year}`;
						} catch (e) {
							return value;
						}
					}

					if (config.format?.[col] === 'currency' && typeof value === 'number') {
						return new Intl.NumberFormat('en-US', {
							style: 'currency',
							currency: 'USD',
							minimumFractionDigits: 2,
							maximumFractionDigits: 2,
						}).format(value);
					}

					if (config.format?.[col] === 'number' && typeof value === 'number') {
						return new Intl.NumberFormat('en-US', {
							minimumFractionDigits: 0,
							maximumFractionDigits: 2,
						}).format(value);
					}

					return value;
				})
			);

			widgets.push({
				type: 'table',
				title: config.title || skill.name,
				columns: displayColumns,
				rows: rows,
			});
		}

		if (config.type === 'kpi') {
			const latestData = data[data.length - 1];
			const yKey = config.yAxis || 'mrr';
			const value = latestData[yKey];

			widgets.push({
				type: 'kpi',
				title: config.title || skill.name,
				value: this.formatKpiValue(value, config.format, yKey),
			});
		}

		return widgets;
	}

	private formatSeriesName(key: string): string {
		const nameMap: Record<string, string> = {
			mrr: 'MRR',
			arr: 'ARR',
			cmrr: 'CMRR',
			revenue: 'Revenue',
			churn: 'Churn',
			active_clients: 'Clientes Activos',
			recognized_revenue: 'Revenue Reconocido',
			deferred_balance: 'Balance Diferido',
			unbilled_balance: 'Balance No Facturado',
			total_amount: 'Total',
			billed_amount: 'Facturado',
		};
		return nameMap[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
	}

	private formatKpiValue(value: any, format?: Record<string, string>, yKey?: string): string {
		if (value === null || value === undefined) return '—';

		// Determinar el formato según el yKey o el primer key de currency en format
		const isCurrency =
			(yKey && format?.[yKey] === 'currency') ||
			Object.values(format || {}).includes('currency');

		const isPercentage =
			(yKey && format?.[yKey] === 'percentage') ||
			Object.values(format || {}).includes('percentage');

		if (isCurrency && typeof value === 'number') {
			return new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency: 'USD',
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			}).format(value);
		}

		if (isPercentage && typeof value === 'number') {
			return `${value.toFixed(2)}%`;
		}

		if (typeof value === 'number') {
			return new Intl.NumberFormat('en-US', {
				minimumFractionDigits: 0,
				maximumFractionDigits: 2,
			}).format(value);
		}

		return String(value);
	}

	private handleQueryError(error: any, skillName: string): SkillExecutionResult {
		this.logger.error(`Error al ejecutar skill ${skillName}:`, error);

		if (error.code === '42P01') {
			return {
				success: false,
				message: 'Lo siento, no tengo acceso a esa información en este momento.',
				error: 'Tabla no existe',
			};
		}

		if (error.message?.includes('no rows')) {
			return {
				success: true,
				data: [],
				message: 'No encontré datos para los criterios especificados.',
			};
		}

		if (error.message?.includes('Parámetro requerido faltante')) {
			return {
				success: false,
				message: `Falta información necesaria: ${error.message}`,
				error: error.message,
			};
		}

		return {
			success: false,
			message: 'Ocurrió un error al consultar la información. Por favor intenta de nuevo.',
			error: error.message,
		};
	}
}
