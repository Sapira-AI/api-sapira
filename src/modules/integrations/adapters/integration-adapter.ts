import type {
	Actor,
	ConnectionTestResult,
	ConnectionView,
	ImpactErrors,
	ImportRequest,
	ImportStarted,
	IntegrationRun,
	IntegrationRunDetail,
	IntegrationTipo,
	MappingItem,
	MappingStatus,
	MappingView,
	Paginated,
	RecordSource,
	Ref,
	RunsQuery,
	ScheduleInfo,
	SyncStarted,
} from '../integrations.types';

/** Reglas por tipo (`integration_settings.settings`), ya con los defaults aplicados. */
export type IntegrationRules = Record<string, unknown>;

export interface SyncOptions {
	date_from?: string;
	date_to?: string;
	/** Stripe: cuenta a sincronizar. */
	connection_id?: string;
}

/**
 * Adaptador por tipo de integración: declara sus objetos (registros y mapeos) y reutiliza los servicios existentes de su módulo
 * (Odoo, Salesforce, Stripe, BigQuery). Agregar una integración = un adaptador nuevo con esta forma (A2).
 */
export interface IntegrationAdapter {
	readonly tipo: IntegrationTipo;

	// Conexión
	getConnection(holdingId: string): Promise<ConnectionView>;
	/** `connectionId` solo en integraciones con varias cuentas (Stripe). */
	testConnection(holdingId: string, connectionId?: string): Promise<ConnectionTestResult>;
	setActive(holdingId: string, active: boolean, connectionId?: string): Promise<ConnectionView>;
	deleteImpact(holdingId: string, connectionId?: string): Promise<ImpactErrors>;
	deleteConnection(holdingId: string, connectionId?: string): Promise<void>;

	// Día a día
	sync(holdingId: string, actor: Actor, options: SyncOptions): Promise<SyncStarted>;
	listRuns(holdingId: string, query: RunsQuery): Promise<Paginated<IntegrationRun>>;
	getRun(holdingId: string, id: string): Promise<IntegrationRunDetail>;
	recordSources(rules: IntegrationRules): RecordSource[];
	importRecords(holdingId: string, request: ImportRequest, actor: Actor, discarded: Set<string>): Promise<ImportStarted>;

	// Mapeos
	readonly mappingObjects: string[];
	getMapping(holdingId: string, object: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView>;
	mappingOptions(
		holdingId: string,
		object: string,
		side: 'sapira' | 'external',
		search?: string
	): Promise<{ data: Ref[]; available: boolean; error: string | null }>;
	putMapping(holdingId: string, object: string, items: MappingItem[], actor: Actor): Promise<void>;
	deleteMapping(holdingId: string, object: string, sapiraId: string, externalId: string, confirm: boolean): Promise<void>;

	// Resumen y reglas
	pendingMapping(holdingId: string): Promise<number>;
	schedule(): ScheduleInfo;
	readonly defaultRules: IntegrationRules;
}
