/**
 * Categorías de los movimientos de MRR (spec-revenue-y-metricas §1.4). Las cinco canónicas de la industria (ChartMogul/Stripe) + tipo de
 * cambio + otros. La subcategoría (`key`) es dato abierto: el `momentum` del devengo o una de las derivadas de este módulo; una `key`
 * desconocida cae en `other` con su nombre, así una subcategoría nueva (PAUSE, RESUME…) aparece sin tocar el front.
 */
export const MOVEMENT_CATEGORIES = ['new', 'expansion', 'reactivation', 'contraction', 'churn', 'fx', 'other'] as const;
export type MovementCategory = (typeof MOVEMENT_CATEGORIES)[number];

export interface CategoryInfo {
	key: MovementCategory;
	label: string;
	kind: 'gain' | 'loss' | 'neutral';
}

export const CATEGORY_INFO: Record<MovementCategory, CategoryInfo> = {
	new: { key: 'new', label: 'Nuevo', kind: 'gain' },
	expansion: { key: 'expansion', label: 'Expansión', kind: 'gain' },
	reactivation: { key: 'reactivation', label: 'Reactivación', kind: 'gain' },
	contraction: { key: 'contraction', label: 'Contracción', kind: 'loss' },
	churn: { key: 'churn', label: 'Churn', kind: 'loss' },
	fx: { key: 'fx', label: 'Tipo de cambio', kind: 'neutral' },
	other: { key: 'other', label: 'Otros', kind: 'neutral' },
};

/** Subcategorías derivadas por este módulo (no vienen del devengo). */
export const DERIVED_KEYS = {
	expired: 'EXPIRED',
	fx: 'FX',
	legacyNew: 'LEGACY_NEW',
	legacyEnd: 'LEGACY_END',
	legacyChange: 'LEGACY_CHANGE',
	legacyMigration: 'LEGACY_MIGRATION',
	subscriptionChange: 'SUBSCRIPTION_CHANGE',
	other: 'OTHER',
} as const;

/** Subcategorías con categoría fija. */
const FIXED: Record<string, MovementCategory> = {
	NEW: 'new',
	UPSELL: 'expansion',
	'CROSS-SELL': 'expansion',
	REACTIVATION: 'reactivation',
	RESUME: 'reactivation',
	DOWNSELL: 'contraction',
	CHURN: 'churn',
	EXPIRED: 'churn',
	PAUSE: 'churn',
	FX: 'fx',
};

/** Subcategorías cuya categoría depende del signo: alza = expansión, baja = contracción (D8: renovación con cambio de precio). */
const BY_SIGN = new Set(['RENEWAL', 'LEGACY_MIGRATION', 'LEGACY_CHANGE', 'SUBSCRIPTION_CHANGE']);

/** Etiquetas en español de las subcategorías conocidas; el front muestra la `key` si no hay etiqueta. */
export const KEY_LABELS: Record<string, string> = {
	NEW: 'Nuevo',
	UPSELL: 'Upsell',
	'CROSS-SELL': 'Cross-sell',
	REACTIVATION: 'Reactivación',
	RESUME: 'Reanudación',
	DOWNSELL: 'Downsell',
	CHURN: 'Churn',
	EXPIRED: 'Vencido sin renovar',
	PAUSE: 'Pausa',
	RENEWAL: 'Renovación',
	FX: 'Tipo de cambio',
	LEGACY_NEW: 'Legacy nuevo',
	LEGACY_END: 'Legacy terminado',
	LEGACY_CHANGE: 'Variación legacy',
	LEGACY_MIGRATION: 'Migración legacy → contrato',
	SUBSCRIPTION_CHANGE: 'Variación suscripción',
	OTHER: 'Otros',
};

/** Categoría de una subcategoría con su monto (las dependientes del cliente, `LEGACY_NEW`/`LEGACY_END`, las resuelve el clasificador). */
export function categoryOf(key: string, amount: number): MovementCategory {
	if (FIXED[key]) return FIXED[key];
	if (BY_SIGN.has(key)) return amount >= 0 ? 'expansion' : 'contraction';

	return 'other';
}

/** Fórmulas que la UI muestra en "¿cómo se calcula?" (spec §1.5). */
export const FORMULAS: Record<string, string> = {
	mrr: 'Σ MRR del mes de contratos, suscripciones y legacy (sin pendientes de renovar), en la moneda elegida',
	arr: 'MRR × 12',
	cmrr: 'Σ CMRR del mes: incluye firmados que aún no inician (desde su fecha de booking), sin pendientes de renovar',
	carr: 'CMRR × 12',
	pending_renewal:
		'Σ MRR de las filas "pendiente de renovar" del mes (ítems vencidos sin renovar ni dar de baja): misma regla que "Por renovar" en Contratos',
	active_clients: 'Clientes con MRR > 0 en el mes',
	arpa: 'MRR ÷ clientes activos',
	net_new_mrr: 'Nuevo + expansión + reactivación − contracción − churn (sin tipo de cambio)',
	growth: '(MRR de cierre − MRR de inicio) ÷ MRR de inicio',
	gross_mrr_churn: '(Contracción + churn) ÷ MRR de inicio',
	net_mrr_churn: '((Contracción + churn) − (expansión + reactivación)) ÷ MRR de inicio',
	logo_churn: 'Clientes con MRR el mes anterior y 0 este mes ÷ clientes activos el mes anterior',
	nrr: '(MRR de inicio + expansión + reactivación − contracción − churn) ÷ MRR de inicio',
	grr: '(MRR de inicio − contracción − churn) ÷ MRR de inicio',
	nrr_yoy: 'Σ MRR de hoy de los clientes activos hace 12 meses ÷ Σ su MRR de hace 12 meses',
	grr_yoy: 'Σ mín(MRR de hoy, MRR de hace 12 meses) de esos clientes ÷ Σ su MRR de hace 12 meses',
	quick_ratio: '(Nuevo + expansión + reactivación) ÷ (contracción + churn); N/A sin pérdidas',
};
