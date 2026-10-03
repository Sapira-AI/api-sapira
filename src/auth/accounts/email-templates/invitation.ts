import { EmailLayout, oneLine, RenderedEmail, renderLayout, renderLayoutText } from './layout';

export interface InvitationEmailValues {
	inviterName: string;
	holdingName: string;
	inviteeName: string | null;
	link: string;
	logoUrl?: string;
}

/** Invitación a un holding (contrato Configuración §10.1–10.2). Datos desde la base, nunca del body. */
export function renderInvitationEmail(values: InvitationEmailValues): RenderedEmail {
	const inviter = oneLine(values.inviterName);
	const holding = oneLine(values.holdingName);
	const subject = `${inviter} te invita a ${holding} en Sapira`;
	const layout: EmailLayout = {
		title: subject,
		preheader: `${inviter} te invitó a ${holding} en Sapira.`,
		heading: 'Te invitaron a Sapira',
		paragraphs: [
			values.inviteeName ? `Hola, ${oneLine(values.inviteeName)}:` : 'Hola:',
			`${inviter} te invitó a trabajar en ${holding} en Sapira.`,
		],
		button: { label: 'Aceptar invitación', url: values.link },
		notes: ['El enlace vence en 24 horas.', 'Si no esperabas esta invitación, puedes ignorar este correo.'],
		logoUrl: values.logoUrl,
	};

	return { subject, html: renderLayout(layout), text: renderLayoutText(layout) };
}
