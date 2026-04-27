import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DatabaseAnalyzerService, TableAnalysisResult } from './database-analyzer.service';

export interface EntityGenerationResult {
	path: string;
	action: 'created' | 'updated' | 'skipped';
	columns_added?: number;
}

export interface FileGenerationResult {
	total: number;
	files: string[];
}

export interface TableGenerationResult {
	table_name: string;
	success: boolean;
	error?: string;
	entity?: EntityGenerationResult;
	triggers?: FileGenerationResult;
	functions?: FileGenerationResult;
	policies?: FileGenerationResult;
}

interface TriggerDefinition {
	trigger_name: string;
	trigger_definition: string;
}

interface FunctionDefinition {
	function_name: string;
	function_code: string;
}

interface PolicyDefinition {
	policyname: string;
	policy_definition: string;
}

@Injectable()
export class DatabaseGeneratorService {
	private readonly PROJECT_ROOT: string;
	private readonly ENTITIES_DIR: string;
	private readonly TRIGGERS_DIR: string;
	private readonly FUNCTIONS_DIR: string;
	private readonly RLS_DIR: string;

	constructor(
		@InjectDataSource()
		private readonly dataSource: DataSource,
		private readonly analyzerService: DatabaseAnalyzerService
	) {
		const isDist = __dirname.includes('/dist/');
		const rootOffset = isDist ? '../../../../src' : '../../..';
		this.PROJECT_ROOT = path.join(__dirname, rootOffset);
		this.ENTITIES_DIR = path.join(this.PROJECT_ROOT, 'databases/postgresql/entities');
		this.TRIGGERS_DIR = path.join(this.PROJECT_ROOT, 'databases/postgresql/triggers');
		this.FUNCTIONS_DIR = path.join(this.PROJECT_ROOT, 'databases/postgresql/functions');
		this.RLS_DIR = path.join(this.PROJECT_ROOT, 'databases/postgresql/rls');
	}

	async generateFromTable(tableName: string, schemaName: string = 'public'): Promise<TableGenerationResult> {
		try {
			console.log(`🚀 Generando archivos para tabla: ${schemaName}.${tableName}`);

			const analysis = await this.analyzerService.analyzeTable(tableName, schemaName);

			const [entity, triggers, functions, policies] = await Promise.all([
				this.generateOrUpdateEntity(analysis),
				this.generateTriggerFiles(tableName, schemaName),
				this.generateFunctionFiles(tableName, schemaName),
				this.generateRLSFiles(tableName, schemaName),
			]);

			return {
				table_name: tableName,
				success: true,
				entity,
				triggers,
				functions,
				policies,
			};
		} catch (error) {
			console.error(`❌ Error generando archivos para ${tableName}:`, error);
			return {
				table_name: tableName,
				success: false,
				error: error.message,
			};
		}
	}

	async generateAllTables(schemaName: string = 'public'): Promise<{
		total_tables: number;
		successful: number;
		failed: number;
		results: TableGenerationResult[];
		summary: {
			entities_created: number;
			entities_updated: number;
			total_triggers: number;
			total_functions: number;
			total_policies: number;
		};
	}> {
		console.log(`🌍 Generando archivos para todas las tablas del esquema: ${schemaName}`);

		const tables = await this.analyzerService.listTables(schemaName);
		const results: TableGenerationResult[] = [];
		const processedFunctions = new Set<string>();

		let successful = 0;
		let failed = 0;
		let entitiesCreated = 0;
		let entitiesUpdated = 0;
		let totalTriggers = 0;
		let totalFunctions = 0;
		let totalPolicies = 0;

		for (let i = 0; i < tables.length; i++) {
			const tableName = tables[i];
			console.log(`📊 Procesando tabla ${i + 1}/${tables.length}: ${tableName}`);

			const result = await this.generateFromTable(tableName, schemaName);
			results.push(result);

			if (result.success) {
				successful++;
				if (result.entity?.action === 'created') entitiesCreated++;
				if (result.entity?.action === 'updated') entitiesUpdated++;
				totalTriggers += result.triggers?.total || 0;
				totalPolicies += result.policies?.total || 0;

				if (result.functions?.files) {
					result.functions.files.forEach((f) => processedFunctions.add(f));
				}
			} else {
				failed++;
			}
		}

		totalFunctions = processedFunctions.size;

		return {
			total_tables: tables.length,
			successful,
			failed,
			results,
			summary: {
				entities_created: entitiesCreated,
				entities_updated: entitiesUpdated,
				total_triggers: totalTriggers,
				total_functions: totalFunctions,
				total_policies: totalPolicies,
			},
		};
	}

	private async generateOrUpdateEntity(analysis: TableAnalysisResult): Promise<EntityGenerationResult> {
		const existingEntityPath = await this.findExistingEntity(analysis.table_name);

		if (existingEntityPath) {
			return await this.updateEntity(existingEntityPath, analysis);
		} else {
			return await this.createEntity(analysis);
		}
	}

	private async findExistingEntity(tableName: string): Promise<string | null> {
		const searchPattern = `@Entity('${tableName}')`;
		const searchDir = path.join(this.PROJECT_ROOT, 'modules');

		try {
			const result = execSync(`grep -r "${searchPattern}" "${searchDir}" --include="*.entity.ts" -l`, {
				encoding: 'utf-8',
			}).trim();

			if (result) {
				const files = result.split('\n');
				return files[0];
			}
		} catch (error) {
			return null;
		}

		return null;
	}

	private async updateEntity(entityPath: string, analysis: TableAnalysisResult): Promise<EntityGenerationResult> {
		console.log(`📝 Actualizando entidad existente: ${entityPath}`);

		const content = await fs.readFile(entityPath, 'utf-8');
		const existingColumns = this.extractExistingColumns(content);
		const newColumns = analysis.columns.filter((col) => !existingColumns.has(col.column_name));

		if (newColumns.length === 0) {
			console.log(`✅ Entidad ya está actualizada, no se requieren cambios`);
			return {
				path: entityPath,
				action: 'skipped',
				columns_added: 0,
			};
		}

		const columnsCode = newColumns.map((col) => this.generateColumnCode(col)).join('\n\n');

		const lastBraceIndex = content.lastIndexOf('}');
		const updatedContent = content.slice(0, lastBraceIndex) + '\n' + columnsCode + '\n' + content.slice(lastBraceIndex);

		await fs.writeFile(entityPath, updatedContent, 'utf-8');

		console.log(`✅ Entidad actualizada con ${newColumns.length} columnas nuevas`);

		return {
			path: entityPath,
			action: 'updated',
			columns_added: newColumns.length,
		};
	}

	private extractExistingColumns(content: string): Set<string> {
		const columns = new Set<string>();
		const columnRegex = /@Column\([^)]*\)\s+(\w+)[\?!]?\s*:/g;
		const primaryRegex = /@PrimaryGeneratedColumn\([^)]*\)\s+(\w+)[\?!]?\s*:/g;
		const simpleRegex = /^\s+(\w+)[\?!]?\s*:\s*(string|number|boolean|Date|object|any)/gm;

		let match;
		while ((match = columnRegex.exec(content)) !== null) {
			columns.add(match[1]);
		}
		while ((match = primaryRegex.exec(content)) !== null) {
			columns.add(match[1]);
		}
		while ((match = simpleRegex.exec(content)) !== null) {
			columns.add(match[1]);
		}

		return columns;
	}

	private async createEntity(analysis: TableAnalysisResult): Promise<EntityGenerationResult> {
		const className = this.toPascalCase(analysis.table_name);
		const fileName = `${analysis.table_name}.entity.ts`;
		const entityPath = path.join(this.ENTITIES_DIR, fileName);

		console.log(`🆕 Creando nueva entidad: ${entityPath}`);

		await fs.mkdir(this.ENTITIES_DIR, { recursive: true });

		const imports = `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';`;
		const entityDecorator = `@Entity('${analysis.table_name}')`;
		const classDeclaration = `export class ${className} {`;

		const primaryKey = analysis.columns.find((col) => col.column_name === 'id');
		const otherColumns = analysis.columns.filter((col) => col.column_name !== 'id');

		let columnsCode = '';

		if (primaryKey) {
			columnsCode += this.generatePrimaryKeyCode(primaryKey) + '\n\n';
		}

		columnsCode += otherColumns.map((col) => this.generateColumnCode(col)).join('\n\n');

		const entityContent = `${imports}\n\n${entityDecorator}\n${classDeclaration}\n${columnsCode}\n}\n`;

		await fs.writeFile(entityPath, entityContent, 'utf-8');

		console.log(`✅ Entidad creada exitosamente`);

		return {
			path: entityPath,
			action: 'created',
		};
	}

	private generatePrimaryKeyCode(column: any): string {
		const isUuid = column.data_type === 'uuid';
		const decorator = isUuid ? `@PrimaryGeneratedColumn('uuid')` : `@PrimaryGeneratedColumn()`;
		const type = this.mapPostgreSQLTypeToTypeScript(column.data_type);

		return `\t${decorator}\n\t${column.column_name}: ${type};`;
	}

	private generateColumnCode(column: any): string {
		const type = this.mapPostgreSQLTypeToTypeScript(column.data_type);
		const typeOrmType = this.mapPostgreSQLTypeToTypeORM(column.data_type);
		const isNullable = column.is_nullable === 'YES';
		const options: string[] = [`type: '${typeOrmType}'`];

		if (isNullable) {
			options.push('nullable: true');
		}

		if (column.column_default) {
			const defaultValue = this.formatDefaultValue(column.column_default);
			if (defaultValue) {
				options.push(`default: ${defaultValue}`);
			}
		}

		const decorator = `@Column({ ${options.join(', ')} })`;
		const propertyName = column.column_name + (isNullable ? '?' : '');

		return `\t${decorator}\n\t${propertyName}: ${type};`;
	}

	private formatDefaultValue(defaultValue: string): string | null {
		if (defaultValue.includes('now()')) return null;
		if (defaultValue.includes('gen_random_uuid()')) return null;

		if (defaultValue.startsWith("'") && defaultValue.endsWith("'::text")) {
			return defaultValue.slice(0, -6);
		}

		if (defaultValue === 'true' || defaultValue === 'false') {
			return defaultValue;
		}

		if (!isNaN(Number(defaultValue))) {
			return defaultValue;
		}

		return null;
	}

	private mapPostgreSQLTypeToTypeScript(pgType: string): string {
		const typeMap: Record<string, string> = {
			uuid: 'string',
			text: 'string',
			varchar: 'string',
			char: 'string',
			boolean: 'boolean',
			integer: 'number',
			bigint: 'number',
			smallint: 'number',
			numeric: 'number',
			decimal: 'number',
			real: 'number',
			'double precision': 'number',
			timestamp: 'Date',
			'timestamp without time zone': 'Date',
			'timestamp with time zone': 'Date',
			date: 'Date',
			time: 'Date',
			jsonb: 'object',
			json: 'object',
			ARRAY: 'string[]',
			'USER-DEFINED': 'string',
		};

		return typeMap[pgType] || 'any';
	}

	private mapPostgreSQLTypeToTypeORM(pgType: string): string {
		if (pgType === 'ARRAY') {
			return 'simple-array';
		}
		if (pgType === 'USER-DEFINED') {
			return 'varchar';
		}
		return pgType.toLowerCase();
	}

	private toPascalCase(str: string): string {
		return str
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join('');
	}

	private async generateTriggerFiles(tableName: string, schemaName: string): Promise<FileGenerationResult> {
		const query = `
			SELECT 
				t.trigger_name,
				format(
					E'DROP TRIGGER IF EXISTS "%s" ON "%s"."%s";\n\nCREATE TRIGGER "%s"\n%s %s\nON "%s"."%s"\nFOR EACH %s\n%s;',
					t.trigger_name,
					t.event_object_schema,
					t.event_object_table,
					t.trigger_name,
					t.action_timing,
					string_agg(DISTINCT t.event_manipulation, ' OR ' ORDER BY t.event_manipulation),
					t.event_object_schema,
					t.event_object_table,
					t.action_orientation,
					t.action_statement
				) as trigger_definition
			FROM information_schema.triggers t
			WHERE t.event_object_schema = $1
			  AND t.event_object_table = $2
			GROUP BY 
				t.trigger_name,
				t.event_object_schema,
				t.event_object_table,
				t.action_timing,
				t.action_orientation,
				t.action_statement
			ORDER BY t.trigger_name;
		`;

		const triggers: TriggerDefinition[] = await this.dataSource.query(query, [schemaName, tableName]);
		const files: string[] = [];

		if (triggers.length > 0) {
			await fs.mkdir(this.TRIGGERS_DIR, { recursive: true });
		}

		for (const trigger of triggers) {
			const fileName = `${trigger.trigger_name}.sql`;
			const filePath = path.join(this.TRIGGERS_DIR, fileName);

			await fs.writeFile(filePath, trigger.trigger_definition + '\n', 'utf-8');
			files.push(fileName);
		}

		console.log(`✅ Generados ${triggers.length} archivos de triggers`);

		return {
			total: triggers.length,
			files,
		};
	}

	private async generateFunctionFiles(tableName: string, schemaName: string): Promise<FileGenerationResult> {
		const triggerQuery = `
			SELECT DISTINCT
				REGEXP_REPLACE(t.action_statement, 'EXECUTE FUNCTION ([a-zA-Z_]+)\\(\\).*', '\\1') as function_name
			FROM information_schema.triggers t
			WHERE t.event_object_schema = $1
			  AND t.event_object_table = $2
			  AND t.action_statement LIKE '%EXECUTE FUNCTION%';
		`;

		const functionNames = await this.dataSource.query(triggerQuery, [schemaName, tableName]);

		if (functionNames.length === 0) {
			return { total: 0, files: [] };
		}

		const functionNamesArray = functionNames.map((row: any) => row.function_name);

		const functionQuery = `
			SELECT 
				p.proname as function_name,
				pg_get_functiondef(p.oid) as function_code
			FROM pg_proc p
			WHERE p.proname = ANY($1)
			  AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
			ORDER BY p.proname;
		`;

		const functions: FunctionDefinition[] = await this.dataSource.query(functionQuery, [functionNamesArray, schemaName]);
		const files: string[] = [];

		if (functions.length > 0) {
			await fs.mkdir(this.FUNCTIONS_DIR, { recursive: true });
		}

		for (const func of functions) {
			const fileName = `${func.function_name}.sql`;
			const filePath = path.join(this.FUNCTIONS_DIR, fileName);

			await fs.writeFile(filePath, func.function_code + '\n', 'utf-8');
			files.push(fileName);
		}

		console.log(`✅ Generados ${functions.length} archivos de funciones`);

		return {
			total: functions.length,
			files,
		};
	}

	private async generateRLSFiles(tableName: string, schemaName: string): Promise<FileGenerationResult> {
		const query = `
			SELECT 
				policyname,
				format(
					E'DROP POLICY IF EXISTS "%s" ON "%s"."%s";\n\nCREATE POLICY "%s"\nON "%s"."%s"\nAS %s\nFOR %s\nTO %s%s%s;',
					policyname,
					schemaname,
					tablename,
					policyname,
					schemaname,
					tablename,
					permissive,
					cmd,
					array_to_string(roles, ', '),
					CASE WHEN qual IS NOT NULL THEN format(E'\nUSING (%s)', qual) ELSE '' END,
					CASE WHEN with_check IS NOT NULL THEN format(E'\nWITH CHECK (%s)', with_check) ELSE '' END
				) as policy_definition
			FROM pg_policies
			WHERE schemaname = $1 
			  AND tablename = $2
			ORDER BY policyname;
		`;

		const policies: PolicyDefinition[] = await this.dataSource.query(query, [schemaName, tableName]);
		const files: string[] = [];

		if (policies.length > 0) {
			await fs.mkdir(this.RLS_DIR, { recursive: true });
		}

		for (const policy of policies) {
			const fileName = `${policy.policyname}.sql`;
			const filePath = path.join(this.RLS_DIR, fileName);

			await fs.writeFile(filePath, policy.policy_definition + '\n', 'utf-8');
			files.push(fileName);
		}

		console.log(`✅ Generados ${policies.length} archivos de políticas RLS`);

		return {
			total: policies.length,
			files,
		};
	}
}
