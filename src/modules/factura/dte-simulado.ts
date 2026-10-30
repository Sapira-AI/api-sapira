import { resolveConnectionEnvironment } from '@/databases/postgresql/connection-target';

/** Prefijo del id de un DTE simulado: así lo reconocen `invoices.dte_id`, Kame y el front («Simulado»). */
export const DTE_SIMULADO_PREFIJO = 'sim_';

/**
 * ¿Este entorno simula la emisión de DTE? Con `DTE_SIMULATED=true` (solo QA) los documentos no van a api-factura ni al SII: los
 * «emite» `FacturaSimuladaService` con folio propio y estado aceptado, para recorrer emisión → Kame sin efectos tributarios.
 */
export const dteSimulado = (raw: string | undefined = process.env.DTE_SIMULATED) => (raw ?? '').trim().toLowerCase() === 'true';

export const esDteSimulado = (dteId: string | null | undefined): boolean => !!dteId && dteId.startsWith(DTE_SIMULADO_PREFIJO);

/**
 * La simulación nunca corre contra producción: con `DTE_SIMULATED=true` la API no arranca si su base es la de producción (resuelta por
 * el project ref de la conexión, `connection-target.ts`), ni con `NODE_ENV=production` cuando la base no se puede identificar. Así un
 * QA mal configurado o el local (que apunta a producción) no dejan facturas reales «emitidas» sin pasar por el SII.
 */
export function assertDteSimulationAllowed(env: NodeJS.ProcessEnv = process.env): void {
	if (!dteSimulado(env.DTE_SIMULATED)) return;

	const connection = env.SUPABASE_DATABASE_URL || env.DATABASE_URL || '';
	let base: string;
	try {
		base = connection ? resolveConnectionEnvironment(connection, env).environment : 'desconocida';
	} catch {
		base = 'desconocida';
	}

	if (base === 'production') throw new Error('DTE_SIMULATED=true no se permite contra la base de producción: quítala o apunta a QA');
	if (base === 'desconocida' && (env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
		throw new Error('DTE_SIMULATED=true no se permite con NODE_ENV=production sin una base de QA identificable');
	}
}
