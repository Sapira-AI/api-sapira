INSERT INTO public.currencies (code, name, name_es, symbol, decimal_places, is_active, country)
VALUES
	('CLP', 'Chilean Peso', 'Peso chileno', '$', 0, TRUE, 'Chile'),
	('USD', 'US Dollar', 'Dólar estadounidense', '$', 2, TRUE, 'Estados Unidos'),
	('EUR', 'Euro', 'Euro', '€', 2, TRUE, 'Unión Europea'),
	('CLF', 'Unidad de Fomento', 'Unidad de Fomento', 'UF', 2, TRUE, 'Chile'),
	('ARS', 'Argentine Peso', 'Peso argentino', '$', 2, TRUE, 'Argentina'),
	('COP', 'Colombian Peso', 'Peso colombiano', '$', 2, TRUE, 'Colombia'),
	('MXN', 'Mexican Peso', 'Peso mexicano', '$', 2, TRUE, 'México'),
	('UYU', 'Uruguayan Peso', 'Peso uruguayo', '$', 2, TRUE, 'Uruguay'),
	('BRL', 'Brazilian Real', 'Real brasileño', '$', 2, TRUE, 'Brasil'),
	('PEN', 'Peruvian Sol', 'Sol peruano', 'S/', 2, TRUE, 'Perú')
ON CONFLICT (code) DO NOTHING;
