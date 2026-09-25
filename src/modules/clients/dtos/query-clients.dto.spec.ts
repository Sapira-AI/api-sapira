import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { QueryClientsDto } from './query-clients.dto';

describe('QueryClientsDto', () => {
	it('acepta holding_id por compatibilidad con el buscador de clientes comerciales del front viejo (Integraciones › Salesforce)', () => {
		const errors = validateSync(
			plainToInstance(QueryClientsDto, { holding_id: 'f6e3cb81-8b4a-451e-8402-573e47688d45', search: 'and', page: '1', limit: '20' }),
			{
				whitelist: true,
				forbidNonWhitelisted: true,
			}
		);

		expect(errors).toEqual([]);
	});
});
