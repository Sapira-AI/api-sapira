import { FALLBACK_EMAIL_SENDER, resolveEffectiveConfig, resolveEmailSender } from './agent-config.helper';

const dataSource = (...responses: unknown[][]) => {
	const query = jest.fn();

	for (const response of responses) query.mockResolvedValueOnce(response);
	query.mockResolvedValue([]);

	return { query } as never as { query: jest.Mock };
};

describe('resolveEffectiveConfig', () => {
	it('prefiere la fila del cliente (ORDER BY client_id NULLS LAST) y devuelve su config', async () => {
		const ds = dataSource([{ client_id: 'c1', is_enabled: true, config_json: { days_before_issue: 5 } }]);

		await expect(resolveEffectiveConfig(ds as never, 'c1', 'proforma', 'h-1')).resolves.toEqual({ days_before_issue: 5 });
		expect(ds.query.mock.calls[0][0]).toContain('ORDER BY client_id NULLS LAST');
		expect(ds.query.mock.calls[0][1]).toEqual(['h-1', 'proforma', 'c1']);
	});

	it('deshabilitada o inexistente → null (el cliente se omite)', async () => {
		await expect(
			resolveEffectiveConfig(dataSource([{ client_id: null, is_enabled: false, config_json: {} }]) as never, 'c1', 'proforma', 'h-1')
		).resolves.toBeNull();
		await expect(resolveEffectiveConfig(dataSource([]) as never, 'c1', 'proforma', 'h-1')).resolves.toBeNull();
	});
});

describe('resolveEmailSender', () => {
	it('usa el remitente elegido si es del holding y está activo', async () => {
		const ds = dataSource([{ from_name: 'Elegido', from_email: 'e@acme.cl' }]);

		await expect(resolveEmailSender(ds as never, { email_sender_address_id: 's-1' }, 'h-1')).resolves.toEqual({
			from_name: 'Elegido',
			from_email: 'e@acme.cl',
		});
		expect(ds.query.mock.calls[0][1]).toEqual(['h-1', 's-1']);
	});

	it('si el elegido no sirve cae al por defecto del holding, y si no hay ninguno al de Sapira', async () => {
		const ds = dataSource([], [{ from_name: 'Por defecto', from_email: 'd@acme.cl' }]);

		await expect(resolveEmailSender(ds as never, { email_sender_address_id: 's-x' }, 'h-1')).resolves.toEqual({
			from_name: 'Por defecto',
			from_email: 'd@acme.cl',
		});
		expect(ds.query.mock.calls[1][0]).toContain('esa.domain_config_id = hess.id');
		await expect(resolveEmailSender(dataSource() as never, {}, 'h-1')).resolves.toEqual(FALLBACK_EMAIL_SENDER);
	});
});
