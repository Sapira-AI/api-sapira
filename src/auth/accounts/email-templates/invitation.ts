import { EmailLayout, EmailOptions, LOGIN_LINK_LABEL, oneLine, RenderedEmail, renderLayout, renderLayoutText } from './layout';

export interface InvitationEmailValues {
	inviterName: string;
	holdingName: string;
	inviteeName: string | null;
	/** Rol asignado y lo que permite (desde la base: `roles` + `role_permissions`). Sin rol, el bloque no se muestra. */
	roleName?: string | null;
	capabilities?: { text: string }[];
	link: string;
	/** Inicio de sesión con el correo precargado (`AuthMailer` lo arma con `INVITE_LANDING_URL`). Sin él, se omite la línea. */
	loginUrl?: string;
	logoUrl?: string;
}

/**
 * Invitación a un holding (contrato Configuración §10.1–10.2). Datos desde la base, nunca del body.
 * Hero con titular y botón, saludo con quién invita y a qué empresa, "Tu rol: …" con lo que el rol permite, enlace alternativo y vencimiento.
 */
export function renderInvitationEmail(values: InvitationEmailValues, options: EmailOptions = {}): RenderedEmail {
	const inviter = oneLine(values.inviterName);
	const holding = oneLine(values.holdingName);
	const roleName = values.roleName ? oneLine(values.roleName) : null;
	const subject = `${inviter} te invita a ${holding} en Sapira`;
	const layout: EmailLayout = {
		title: subject,
		preheader: `${inviter} te invitó a ${holding}. Acepta la invitación para entrar a Sapira.`,
		eyebrow: 'Invitación',
		heading: `Únete a ${holding} en Sapira`,
		lead: 'Contratos, facturación, cobranza e ingresos en un solo lugar. Acepta la invitación para crear tu acceso.',
		button: { label: 'Aceptar invitación', url: values.link },
		paragraphs: [
			values.inviteeName ? `Hola, ${oneLine(values.inviteeName)}:` : 'Hola:',
			`${inviter} te invitó a trabajar en ${holding} en Sapira.`,
		],
		role:
			roleName && values.capabilities?.length
				? {
						title: `Tu rol: ${roleName}`,
						intro: 'Esto es lo que puedes hacer con tu rol:',
						items: values.capabilities.map((item) => ({ text: oneLine(item.text) })),
						footnote: '¿Necesitas ver o hacer algo más? Pide a tu administrador en Sapira que actualice tu rol.',
					}
				: undefined,
		altLogin: values.loginUrl
			? {
					text: 'También puedes entrar con tu cuenta de Google o Microsoft si es la de este correo.',
					label: LOGIN_LINK_LABEL,
					url: values.loginUrl,
				}
			: undefined,
		notes: ['El enlace vence en 24 horas.'],
		logoUrl: values.logoUrl,
	};

	return { subject, html: renderLayout(layout, options), text: renderLayoutText(layout) };
}
