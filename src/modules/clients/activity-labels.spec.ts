import {
	collectionChannelLabel,
	CONTRACT_EVENT_TYPES,
	CONTRACT_FIELDS,
	contractChangeTitle,
	contractEventTitle,
	describeContractChange,
	formatFieldValue,
	humanizeText,
	paymentMethodLabel,
} from './activity-labels';
import { noteExcerpt, parseNoteTokens, renderNoteText } from './client-note-tokens';

const SNAKE = /\b[a-z]+_[a-z_]+\b/;

describe('textos de la Actividad del Cliente 360 (sin nombres internos)', () => {
	it('cambio de estado y precio con antes → después', () => {
		expect(
			describeContractChange({
				change_type: 'UPDATE',
				fields: ['status', 'total_value'],
				before: { status: 'En revisión', total_value: 100 },
				after: { status: 'Activo', total_value: 120.5 },
				currency: 'USD',
			})
		).toBe('Estado: En revisión → Activo · Valor total: USD 100 → USD 120,5');
	});

	it('fechas, monedas, sí/no, referencias y textos largos sin ids ni HTML; campos desconocidos agrupados', () => {
		const detail = describeContractChange({
			change_type: 'UPDATE',
			fields: ['contract_end_date', 'invoice_currency', 'auto_invoice', 'quote_id', 'invoice_terms_and_conditions', 'legacy_status', 'x_y'],
			before: {
				contract_end_date: '2026-12-31',
				invoice_currency: 'usd',
				auto_invoice: false,
				quote_id: 'a',
				invoice_terms_and_conditions: '<p>a</p>',
			},
			after: {
				contract_end_date: '2027-01-31',
				invoice_currency: 'clp',
				auto_invoice: true,
				quote_id: 'b',
				invoice_terms_and_conditions: '<p>b</p>',
			},
		})!;

		expect(detail).toBe(
			'Fecha de término: 31-12-2026 → 31-01-2027 · Moneda de facturación: USD → CLP · Facturación automática: No → Sí · ' +
				'Cotización asociada: actualizado · Términos y condiciones de la factura: actualizado · 2 datos más actualizados'
		);
		expect(detail).not.toMatch(SNAKE);
		expect(detail).not.toContain('<p>');
	});

	it('sin antes/después (registros viejos) dice "actualizado"; sin cambios visibles → null; motivo al final', () => {
		expect(describeContractChange({ change_type: 'UPDATE', fields: ['status'], before: null, after: null })).toBe('Estado: actualizado');
		expect(
			describeContractChange({
				change_type: 'UPDATE',
				fields: ['total_value'],
				before: { total_value: 9999.999996 },
				after: { total_value: 9999.999996 },
			})
		).toBeNull();
		expect(
			describeContractChange({
				change_type: 'UPDATE',
				fields: ['status'],
				before: { status: 'draft' },
				after: { status: 'active' },
				reason: 'pending_renewal',
			})
		).toBe('Estado: Borrador → Activo · Motivo: por renovar');
		expect(describeContractChange({ change_type: 'DELETE', fields: [], reason: null })).toBeNull();
		expect(contractChangeTitle('UPDATE', 'CTR-2026-226')).toBe('Contrato modificado · CTR-2026-226');
		expect(contractChangeTitle('CREATE', null)).toBe('Contrato registrado');
	});

	it('eventos del contrato, medios de pago y canales en español; textos guardados limpios', () => {
		expect(contractEventTitle(null, 'INVOICE_CANCELLED')).toBe('Factura anulada');
		expect(contractEventTitle('', 'ALGO_NUEVO')).toBe('Evento del contrato');
		expect(contractEventTitle('Renovación Aplicada', 'renewal')).toBe('Renovación aplicada');
		expect(paymentMethodLabel('transfer')).toBe('Transferencia');
		expect(paymentMethodLabel('Transferencia')).toBe('Transferencia');
		expect(collectionChannelLabel('email')).toBe('Correo');
		expect(humanizeText('NC cancellation sobre factura 960')).toBe('NC de anulación sobre factura 960');
		expect(humanizeText('NC manual por reschedule')).toBe('NC manual por reprogramación');
		expect(humanizeText('Factura emitida por 9999.9999999999999996')).toBe('Factura emitida por 10.000');
		expect(humanizeText('Se activó CTR-1 por CLF 2.040,00')).toBe('Se activó CTR-1 por CLF 2.040,00');
		expect(humanizeText('UPSELL aplicado desde cotización')).toBe('Upsell aplicado desde cotización');
		expect(formatFieldValue('fx_invoice_policy', 'spot')).toBe('Al emitir');
		// Diccionario único: ninguna etiqueta es un nombre interno.
		for (const info of Object.values(CONTRACT_FIELDS)) expect(info.label).not.toMatch(SNAKE);
		for (const label of Object.values(CONTRACT_EVENT_TYPES)) expect(label).not.toMatch(/[A-Z]{2,}_/);
	});
});

describe('tokens de las notas (@ menciones y # referencias)', () => {
	const user = '11111111-1111-4111-8111-111111111111';
	const invoice = '22222222-2222-4222-8222-222222222222';

	it('deriva menciones y referencias sin repetidos', () => {
		expect(parseNoteTokens(`Hola @[user:${user}] mira #[invoice:${invoice}] y #[invoice:${invoice}] @[user:${user}] #[otro:${invoice}]`)).toEqual(
			{
				mentioned_user_ids: [user],
				references: [{ type: 'invoice', id: invoice }],
			}
		);
	});

	it('texto legible con nombres y etiquetas; lo eliminado se dice y los tokens mal formados no se ven', () => {
		const text = renderNoteText(
			`@[user:${user}] revisa #[invoice:${invoice}] y #[quote:${user}] @[user:basura]`,
			new Map([[user, 'Leon']]),
			new Map([[`invoice:${invoice}`, 'Factura F-1']])
		);

		expect(text).toBe('@Leon revisa #Factura F-1 y #elemento ya no disponible');
		expect(noteExcerpt('a'.repeat(300))).toHaveLength(280);
	});
});
