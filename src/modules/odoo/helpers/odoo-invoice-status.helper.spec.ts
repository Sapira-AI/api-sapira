import { determinarEstadoSapira } from './odoo-invoice-status.helper';

describe('determinarEstadoSapira', () => {
	it('sin publicar en Odoo no hay nada que sincronizar', () => {
		expect(determinarEstadoSapira('draft', 'not_paid')).toBeNull();
		expect(determinarEstadoSapira('cancel', 'paid')).toBeNull();
		expect(determinarEstadoSapira(undefined, 'paid')).toBeNull();
	});

	it('solo `paid` pasa a Pagada', () => {
		expect(determinarEstadoSapira('posted', 'paid')).toBe('Pagada');
	});

	it.each(['not_paid', 'partial', 'in_payment', 'reversed', 'invoicing_legacy'])('`%s` queda en Enviada, no en Pagada', (paymentState) => {
		expect(determinarEstadoSapira('posted', paymentState)).toBe('Enviada');
	});

	it('un payload publicado sin payment_state queda en Enviada, no en Pagada', () => {
		expect(determinarEstadoSapira('posted', undefined)).toBe('Enviada');
		expect(determinarEstadoSapira('posted', '')).toBe('Enviada');
	});
});
