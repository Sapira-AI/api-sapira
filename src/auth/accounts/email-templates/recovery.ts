import { EmailLayout, EmailOptions, LOGIN_LINK_LABEL, oneLine, RenderedEmail, renderLayout, renderLayoutText } from './layout';

export interface RecoveryEmailValues {
	name: string | null;
	link: string;
	/** Inicio de sesión con el correo precargado (`AuthMailer` lo arma con `INVITE_LANDING_URL`). Sin él, se omite la línea. */
	loginUrl?: string;
	logoUrl?: string;
}

/** Recuperar contraseña (`POST /auth/password-recovery`, contrato Configuración §10.6). Más sobrio: mismo hero, sin bloques extra. */
export function renderRecoveryEmail(values: RecoveryEmailValues, options: EmailOptions = {}): RenderedEmail {
	const subject = 'Restablece tu contraseña de Sapira';
	const layout: EmailLayout = {
		title: subject,
		preheader: 'Crea una nueva contraseña para entrar a Sapira. El enlace vence en 24 horas.',
		eyebrow: 'Seguridad de la cuenta',
		heading: 'Restablece tu contraseña',
		lead: 'Recibimos una solicitud para cambiar la contraseña de tu cuenta. Crea una nueva en un paso.',
		button: { label: 'Crear nueva contraseña', url: values.link },
		paragraphs: [
			values.name ? `Hola, ${oneLine(values.name)}:` : 'Hola:',
			'Usa el botón de arriba para elegir tu nueva contraseña. Tu contraseña actual sigue funcionando hasta que la cambies.',
		],
		callout: 'Sapira nunca te pedirá tu contraseña por correo, chat ni teléfono.',
		altLogin: values.loginUrl
			? { text: 'Si usas Google o Microsoft, entra directamente desde el inicio de sesión.', label: LOGIN_LINK_LABEL, url: values.loginUrl }
			: undefined,
		notes: ['El enlace vence en 24 horas. Si no lo pediste, ignora este correo.'],
		logoUrl: values.logoUrl,
	};

	return { subject, html: renderLayout(layout, options), text: renderLayoutText(layout) };
}
