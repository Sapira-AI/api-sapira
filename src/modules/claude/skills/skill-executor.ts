import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DynamicQueryBuilder } from './query-builder';
import { SkillDefinition, SkillExecutionContext, SkillExecutionResult } from './skill-definition.interface';

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
				return {
					success: true,
					data: [],
					message: 'No se encontraron datos para los criterios especificados.',
				};
			}

			const response: SkillExecutionResult = {
				success: true,
				message: 'Datos obtenidos exitosamente',
				data: results,
			};

			console.log('🎯 SkillExecutor - Skill:', skill.name);
			console.log('🎯 SkillExecutor - include_widgets:', params.include_widgets);
			console.log('🎯 SkillExecutor - widgetConfig:', skill.response.widgetConfig);
			console.log('🎯 SkillExecutor - Datos obtenidos:', results.length, 'filas');

			if (params.include_widgets && skill.response.widgetConfig) {
				console.log('✅ SkillExecutor - Generando widgets...');
				response.widgets = this.generateWidgets(results, skill);
				console.log('✅ SkillExecutor - Widgets generados:', response.widgets);
			} else {
				console.log(
					'❌ SkillExecutor - NO se generan widgets. include_widgets:',
					params.include_widgets,
					'widgetConfig:',
					!!skill.response.widgetConfig
				);
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

		if (processed.mode === 'snapshot' && !processed.date_to) {
			const today = new Date();
			const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
			processed.date_to = firstDayOfMonth.toISOString().split('T')[0];
			processed.date_from = processed.date_to;
		}

		if (processed.mode === 'series' && !processed.date_from && processed.months_back) {
			const today = new Date();
			const toDate = new Date(today.getFullYear(), today.getMonth(), 1);
			const fromDate = new Date(toDate);
			fromDate.setMonth(fromDate.getMonth() - (processed.months_back - 1));

			processed.date_from = fromDate.toISOString().split('T')[0];
			processed.date_to = toDate.toISOString().split('T')[0];
		}

		return processed;
	}

	private buildQueryForSkill(skill: SkillDefinition, params: any, holdingId: string): { query: string; values: any[] } {
		let baseQuery = skill.database.baseQuery;

		const currencyMode = params.currency_mode || 'system';
		const mrrColumnLegacy = this.getMrrColumn('legacy', currencyMode);
		const mrrColumnRsm = this.getMrrColumn('rsm', currencyMode);

		baseQuery = baseQuery.replace(/\{\{MRR_COLUMN_LEGACY\}\}/g, mrrColumnLegacy);
		baseQuery = baseQuery.replace(/\{\{MRR_COLUMN_RSM\}\}/g, mrrColumnRsm);

		if (params.group_by && Array.isArray(params.group_by)) {
			const groupByColumns = params.group_by.map((col: string) => `${col},`).join(' ');
			baseQuery = baseQuery.replace('{{GROUP_BY_COLUMNS}}', groupByColumns);

			if (!skill.database.groupBy) {
				skill.database.groupBy = [];
			}
			skill.database.groupBy.push(...params.group_by);
		} else {
			baseQuery = baseQuery.replace('{{GROUP_BY_COLUMNS}}', '');
		}

		const modifiedSkill = { ...skill, database: { ...skill.database, baseQuery } };

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

	private generateWidgets(data: any[], skill: SkillDefinition): any[] {
		if (!skill.response.widgetConfig) {
			return [];
		}

		const config = skill.response.widgetConfig;
		const widgets: any[] = [];

		if (config.type === 'line' || config.type === 'bar' || config.type === 'area') {
			const xKey = config.xAxis || 'period_month';
			const yKey = config.yAxis || 'mrr';

			// Determinar el tipo correcto para el frontend
			const widgetType = config.type === 'line' ? 'chart_line' : config.type === 'bar' ? 'chart_bar' : 'chart_line';

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
			});
		}

		if (config.type === 'table') {
			const columns = config.columns || Object.keys(data[0] || {});
			const rows = data.map((row) => columns.map((col) => row[col]));

			widgets.push({
				type: 'table',
				title: config.title || skill.name,
				columns: columns,
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
				value: this.formatKpiValue(value, config.format),
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
		};
		return nameMap[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
	}

	private formatKpiValue(value: any, format?: any): string {
		if (value === null || value === undefined) return '—';

		if (format?.mrr === 'currency' || format?.revenue === 'currency') {
			return new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency: 'USD',
				minimumFractionDigits: 0,
				maximumFractionDigits: 0,
			}).format(value);
		}

		return String(value);
	}

	private handleQueryError(error: any, skillName: string): SkillExecutionResult {
		console.error(`Error al ejecutar skill ${skillName}:`, error);

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
