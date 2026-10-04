import { EmailLayout, EmailOptions, EmailSection, oneLine, RenderedEmail, renderLayout, renderLayoutText } from './layout';

export interface AlertEmailValues {
	/** "Bloquea" | "Atención" | "Informativo". */
	severityLabel: string;
	/** Etiqueta del tipo en el catálogo (p. ej. "Falló la sincronización de tipos de cambio"). */
	typeLabel: string;
	moduleLabel: string;
	title: string;
	whatHappened: string;
	whatToDo: string;
	whatWeDo?: string | null;
	companyName?: string | null;
	holdingName?: string | null;
	/** `${INVITE_LANDING_URL}/notificaciones?alerta=<id>`. */
	url: string;
	/** Escaló (subió la gravedad o cambió el escalón): el asunto lo dice. */
	escalated?: boolean;
	logoUrl?: string;
}

export const PREFERENCES_NOTE = 'Eliges qué avisos te llegan por correo en Notificaciones › Preferencias.';

/**
 * Alerta inmediata (Notificaciones v2 fase 2, contrato §8.3): gravedad, Qué pasó, Qué hacer (+ Qué hacemos nosotros) y botón al centro de
 * notificaciones. Texto plano en los valores: el layout escapa todo.
 */
export function renderAlertEmail(values: AlertEmailValues, options: EmailOptions = {}): RenderedEmail {
	const subject = oneLine(`[${values.severityLabel}] ${values.escalated ? 'Sigue pendiente: ' : ''}${values.title}`);
	const context = [values.moduleLabel, values.companyName, values.holdingName].filter(Boolean).join(' · ');
	const sections: EmailSection[] = [
		{ title: 'Qué pasó', text: values.whatHappened },
		{ title: 'Qué hacer', text: values.whatToDo },
		...(values.whatWeDo ? [{ title: 'Qué hacemos nosotros', text: values.whatWeDo }] : []),
	];
	const layout: EmailLayout = {
		title: subject,
		preheader: oneLine(values.whatHappened).slice(0, 140),
		eyebrow: values.severityLabel,
		heading: oneLine(values.title),
		lead: context ? `${values.typeLabel} · ${context}` : values.typeLabel,
		button: { label: 'Ver alerta', url: values.url },
		paragraphs: [],
		sections,
		notes: [PREFERENCES_NOTE],
		logoUrl: values.logoUrl,
	};

	return { subject, html: renderLayout(layout, options), text: renderLayoutText(layout) };
}
