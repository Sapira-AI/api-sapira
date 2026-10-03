import { EmailLayout, oneLine, RenderedEmail, renderLayout, renderLayoutText } from './layout';

export interface RecoveryEmailValues {
	name: string | null;
	link: string;
	logoUrl?: string;
}

/** Recuperar contraseña (`POST /auth/password-recovery`, contrato Configuración §10.6). */
export function renderRecoveryEmail(values: RecoveryEmailValues): RenderedEmail {
	const subject = 'Restablece tu contraseña de Sapira';
	const layout: EmailLayout = {
		title: subject,
		preheader: 'Crea una nueva contraseña para entrar a Sapira.',
		heading: 'Restablece tu contraseña',
		paragraphs: [
			values.name ? `Hola, ${oneLine(values.name)}:` : 'Hola:',
			'Recibimos una solicitud para restablecer la contraseña de tu cuenta de Sapira.',
		],
		button: { label: 'Crear nueva contraseña', url: values.link },
		notes: ['El enlace vence en 24 horas. Si no lo pediste, ignora este correo.'],
		logoUrl: values.logoUrl,
	};

	return { subject, html: renderLayout(layout), text: renderLayoutText(layout) };
}
