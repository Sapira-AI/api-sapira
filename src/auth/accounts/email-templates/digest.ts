import { PREFERENCES_NOTE } from './alert';
import { EmailLayout, EmailOptions, EmailSection, oneLine, RenderedEmail, renderLayout, renderLayoutText } from './layout';

export interface DigestEmailValues {
	name: string | null;
	holdingName: string;
	/** "Semana del 5 de octubre". */
	weekLabel: string;
	/** Centro de notificaciones (`/notificaciones`). */
	url: string;
	tasks: Array<{ module: string; title: string; count: number; url: string | null }>;
	alerts: { total: number; items: Array<{ title: string; severity: string; url: string | null }> };
	mrr: {
		month: string;
		previousMonth: string;
		value: string;
		previous: string;
		delta: string;
		deltaTone: 'up' | 'down' | null;
		increases: Array<{ label: string; value: string }>;
		decreases: Array<{ label: string; value: string }>;
	} | null;
	renewals: { count: number; items: Array<{ label: string; url: string | null }> };
	/**
	 * "Por compañía": solo si el usuario ve más de una compañía y más de una tiene datos (si no, vacío y la sección no aparece). Tareas
	 * abiertas (suma de conteos de las tareas por compañía), alertas abiertas de la semana y MRR del mes (si está disponible).
	 */
	companies?: Array<{ name: string; tasks: number; alerts: number; mrr: string | null }>;
	/** Compañías aplicadas ("Mis compañías"), si el usuario filtró. */
	companiesNote?: string | null;
	logoUrl?: string;
}

/**
 * Resumen semanal (Notificaciones v2 fase 2, contrato §8.4): compacto, con la marca. Secciones vacías se omiten. Texto plano en los valores:
 * el layout escapa todo.
 */
export function renderDigestEmail(values: DigestEmailValues, options: EmailOptions = {}): RenderedEmail {
	const subject = oneLine(`Tu resumen semanal de Sapira · ${values.holdingName}`);
	const openTasks = values.tasks.reduce((sum, task) => sum + task.count, 0);
	const sections: EmailSection[] = [];

	if (values.tasks.length) {
		sections.push({
			title: 'Tareas abiertas',
			rows: values.tasks.map((task) => ({ label: `${task.module} · ${task.title}`, value: String(task.count), url: task.url ?? undefined })),
		});
	}
	if (values.alerts.total) {
		sections.push({
			title: `Alertas abiertas de la semana (${values.alerts.total})`,
			rows: values.alerts.items.map((alert) => ({ label: alert.title, value: alert.severity, url: alert.url ?? undefined })),
		});
	}
	if ((values.companies?.length ?? 0) > 1) {
		const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

		sections.push({
			title: 'Por compañía',
			rows: values.companies!.map((company) => ({
				label: company.name,
				value: [
					plural(company.tasks, 'tarea', 'tareas'),
					plural(company.alerts, 'alerta', 'alertas'),
					...(company.mrr ? [`MRR ${company.mrr}`] : []),
				].join(' · '),
			})),
		});
	}
	if (values.mrr) {
		sections.push({
			title: `MRR de ${values.mrr.month}`,
			rows: [
				{ label: `MRR de ${values.mrr.month}`, value: values.mrr.value },
				{ label: `MRR de ${values.mrr.previousMonth}`, value: values.mrr.previous },
				{ label: 'Variación', value: values.mrr.delta, tone: values.mrr.deltaTone ?? undefined },
				...values.mrr.increases.map((row) => ({ label: `Aumento · ${row.label}`, value: row.value, tone: 'up' as const })),
				...values.mrr.decreases.map((row) => ({ label: `Pérdida · ${row.label}`, value: row.value, tone: 'down' as const })),
			],
		});
	}
	if (values.renewals.count) {
		sections.push({
			title: `Renovaciones ejecutadas (${values.renewals.count})`,
			rows: values.renewals.items.map((item) => ({ label: item.label, url: item.url ?? undefined })),
		});
	}
	const layout: EmailLayout = {
		title: subject,
		preheader: `${openTasks} tarea(s) abiertas y ${values.alerts.total} alerta(s) de la semana en ${values.holdingName}.`,
		eyebrow: 'Resumen semanal',
		heading: values.weekLabel,
		lead:
			openTasks || values.alerts.total ? `Esto es lo que tienes pendiente en ${values.holdingName}.` : `Todo al día en ${values.holdingName}.`,
		button: { label: 'Abrir notificaciones', url: values.url },
		paragraphs: [values.name ? `Hola, ${oneLine(values.name)}:` : 'Hola:'],
		sections,
		notes: [...(values.companiesNote ? [values.companiesNote] : []), 'Te llega los lunes. ' + PREFERENCES_NOTE],
		logoUrl: values.logoUrl,
	};

	return { subject, html: renderLayout(layout, options), text: renderLayoutText(layout) };
}
