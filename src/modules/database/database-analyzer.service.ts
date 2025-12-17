import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface TableColumn {
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
	character_maximum_length: number | null;
	numeric_precision: number | null;
	numeric_scale: number | null;
}

export interface TableIndex {
	index_name: string;
	index_definition: string;
	index_type: string;
	is_unique: string;
	index_size: string;
}

export interface ForeignKey {
	constraint_name: string;
	table_name: string;
	column_name: string;
	foreign_table_name: string;
	foreign_column_name: string;
	update_rule: string;
	delete_rule: string;
}

export interface PrimaryUniqueKey {
	constraint_name: string;
	constraint_type: string;
	column_name: string;
	is_deferrable: string;
	initially_deferred: string;
}

export interface TableTrigger {
	trigger_name: string;
	event_manipulation: string;
	event_object_table: string;
	action_timing: string;
	action_statement: string;
	action_orientation: string;
	action_condition: string | null;
}

export interface TablePolicy {
	schemaname: string;
	tablename: string;
	policyname: string;
	permissive: string;
	roles: string[];
	cmd: string;
	qual: string | null;
	with_check: string | null;
}

export interface TableStats {
	schemaname: string;
	tablename: string;
	attname: string;
	n_distinct: number | null;
	most_common_vals: string[] | null;
	most_common_freqs: number[] | null;
	histogram_bounds: string[] | null;
}

export interface TableSize {
	total_size: string;
	table_size: string;
	indexes_size: string;
}

export interface TablePermission {
	grantee: string;
	privilege_type: string;
	is_grantable: string;
}

export interface TableAnalysisResult {
	table_name: string;
	schema_name: string;
	columns: TableColumn[];
	indexes: TableIndex[];
	foreign_keys: ForeignKey[];
	primary_unique_keys: PrimaryUniqueKey[];
	triggers: TableTrigger[];
	policies: TablePolicy[];
	statistics: TableStats[];
	size_info: TableSize;
	permissions: TablePermission[];
	analysis_timestamp: string;
}

@Injectable()
export class DatabaseAnalyzerService {
	constructor(
		@InjectDataSource()
		private readonly dataSource: DataSource
	) {}

	/**
	 * Analiza completamente una tabla y devuelve toda su información
	 */
	async analyzeTable(tableName: string, schemaName: string = 'public'): Promise<TableAnalysisResult> {
		try {
			console.log(`🔍 Analizando tabla: ${schemaName}.${tableName}`);

			const [columns, indexes, foreignKeys, primaryUniqueKeys, triggers, policies, statistics, sizeInfo, permissions] = await Promise.all([
				this.getTableColumns(tableName, schemaName),
				this.getTableIndexes(tableName, schemaName),
				this.getForeignKeys(tableName, schemaName),
				this.getPrimaryUniqueKeys(tableName, schemaName),
				this.getTableTriggers(tableName, schemaName),
				this.getTablePolicies(tableName, schemaName),
				this.getTableStatistics(tableName, schemaName),
				this.getTableSize(tableName, schemaName),
				this.getTablePermissions(tableName, schemaName),
			]);

			return {
				table_name: tableName,
				schema_name: schemaName,
				columns,
				indexes,
				foreign_keys: foreignKeys,
				primary_unique_keys: primaryUniqueKeys,
				triggers,
				policies,
				statistics,
				size_info: sizeInfo,
				permissions,
				analysis_timestamp: new Date().toISOString(),
			};
		} catch (error) {
			console.error(`❌ Error analizando tabla ${tableName}:`, error);
			throw new Error(`Error analizando tabla: ${error.message}`);
		}
	}

	/**
	 * Obtiene información de las columnas de la tabla
	 */
	private async getTableColumns(tableName: string, schemaName: string): Promise<TableColumn[]> {
		const query = `
			SELECT 
				column_name,
				data_type,
				is_nullable,
				column_default,
				character_maximum_length,
				numeric_precision,
				numeric_scale
			FROM information_schema.columns 
			WHERE table_name = $1 
			  AND table_schema = $2
			ORDER BY ordinal_position;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene información de los índices de la tabla
	 */
	private async getTableIndexes(tableName: string, schemaName: string): Promise<TableIndex[]> {
		const query = `
			SELECT 
				i.indexname as index_name,
				i.indexdef as index_definition,
				am.amname as index_type,
				CASE 
					WHEN i.indexdef LIKE '%UNIQUE%' THEN 'YES'
					ELSE 'NO'
				END as is_unique,
				pg_size_pretty(pg_relation_size(c.oid)) as index_size
			FROM pg_indexes i
			JOIN pg_class c ON c.relname = i.indexname
			JOIN pg_am am ON am.oid = c.relam
			WHERE i.tablename = $1
			  AND i.schemaname = $2
			ORDER BY i.indexname;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene las llaves foráneas de la tabla
	 */
	private async getForeignKeys(tableName: string, schemaName: string): Promise<ForeignKey[]> {
		const query = `
			SELECT 
				tc.constraint_name,
				tc.table_name,
				kcu.column_name,
				ccu.table_name AS foreign_table_name,
				ccu.column_name AS foreign_column_name,
				rc.update_rule,
				rc.delete_rule
			FROM information_schema.table_constraints AS tc 
			JOIN information_schema.key_column_usage AS kcu
				ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema = kcu.table_schema
			JOIN information_schema.constraint_column_usage AS ccu
				ON ccu.constraint_name = tc.constraint_name
				AND ccu.table_schema = tc.table_schema
			JOIN information_schema.referential_constraints AS rc
				ON tc.constraint_name = rc.constraint_name
			WHERE tc.constraint_type = 'FOREIGN KEY' 
			  AND tc.table_name = $1
			  AND tc.table_schema = $2;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene las llaves primarias y únicas de la tabla
	 */
	private async getPrimaryUniqueKeys(tableName: string, schemaName: string): Promise<PrimaryUniqueKey[]> {
		const query = `
			SELECT 
				tc.constraint_name,
				tc.constraint_type,
				kcu.column_name,
				tc.is_deferrable,
				tc.initially_deferred
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu 
				ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema = kcu.table_schema
			WHERE tc.table_name = $1
			  AND tc.table_schema = $2
			  AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
			ORDER BY tc.constraint_type, kcu.ordinal_position;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene los triggers asociados a la tabla
	 */
	private async getTableTriggers(tableName: string, schemaName: string): Promise<TableTrigger[]> {
		const query = `
			SELECT 
				t.trigger_name,
				t.event_manipulation,
				t.event_object_table,
				t.action_timing,
				t.action_statement,
				t.action_orientation,
				t.action_condition
			FROM information_schema.triggers t
			WHERE t.event_object_table = $1
			  AND t.event_object_schema = $2
			ORDER BY t.trigger_name;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene las políticas RLS de la tabla
	 */
	private async getTablePolicies(tableName: string, schemaName: string): Promise<TablePolicy[]> {
		const query = `
			SELECT 
				schemaname,
				tablename,
				policyname,
				permissive,
				roles,
				cmd,
				qual,
				with_check
			FROM pg_policies 
			WHERE tablename = $1
			  AND schemaname = $2;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene estadísticas de la tabla
	 */
	private async getTableStatistics(tableName: string, schemaName: string): Promise<TableStats[]> {
		const query = `
			SELECT 
				schemaname,
				tablename,
				attname,
				n_distinct,
				most_common_vals,
				most_common_freqs,
				histogram_bounds
			FROM pg_stats 
			WHERE tablename = $1
			  AND schemaname = $2
			ORDER BY attname;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Obtiene información del tamaño de la tabla
	 */
	private async getTableSize(tableName: string, schemaName: string): Promise<TableSize> {
		const query = `
			SELECT 
				pg_size_pretty(pg_total_relation_size($1)) as total_size,
				pg_size_pretty(pg_relation_size($1)) as table_size,
				pg_size_pretty(pg_total_relation_size($1) - pg_relation_size($1)) as indexes_size;
		`;

		const fullTableName = `${schemaName}.${tableName}`;
		const result = await this.dataSource.query(query, [fullTableName]);
		return result[0] || { total_size: '0 bytes', table_size: '0 bytes', indexes_size: '0 bytes' };
	}

	/**
	 * Obtiene los permisos de la tabla
	 */
	private async getTablePermissions(tableName: string, schemaName: string): Promise<TablePermission[]> {
		const query = `
			SELECT 
				grantee,
				privilege_type,
				is_grantable
			FROM information_schema.role_table_grants 
			WHERE table_name = $1
			  AND table_schema = $2
			ORDER BY grantee, privilege_type;
		`;

		return await this.dataSource.query(query, [tableName, schemaName]);
	}

	/**
	 * Lista todas las tablas disponibles en un esquema
	 */
	async listTables(schemaName: string = 'public'): Promise<string[]> {
		const query = `
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = $1
			  AND table_type = 'BASE TABLE'
			ORDER BY table_name;
		`;

		const result = await this.dataSource.query(query, [schemaName]);
		return result.map((row: any) => row.table_name);
	}

	/**
	 * Verifica si una tabla existe
	 */
	async tableExists(tableName: string, schemaName: string = 'public'): Promise<boolean> {
		const query = `
			SELECT EXISTS (
				SELECT 1
				FROM information_schema.tables
				WHERE table_schema = $1
				  AND table_name = $2
			) as exists;
		`;

		const result = await this.dataSource.query(query, [schemaName, tableName]);
		return result[0]?.exists || false;
	}
}
