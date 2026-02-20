# Módulo Banco Central de Chile

Este módulo proporciona integración con la API del Banco Central de Chile para consultar y almacenar indicadores económicos.

## Configuración

### Variables de Entorno

Agrega las siguientes variables a tu archivo `.env`:

```env
# Credenciales API Banco Central
BANCO_CENTRAL_USER=tu_email@ejemplo.com
BANCO_CENTRAL_PASS=tu_password_aqui

# Emails del Sistema (SendGrid)
SYSTEM_EMAIL_FROM=cobranza@blixter.cl
SYSTEM_EMAIL_FROM_NAME=Sistema Sapira - Banco Central

# Sincronización Automática de Tipos de Cambio
BANCO_CENTRAL_SYNC_ENABLED=true  # true/false - Activar/desactivar scheduler
BANCO_CENTRAL_SYNC_HOUR=8  # Hora de ejecución diaria (0-23), default: 8 AM
BANCO_CENTRAL_ADMIN_EMAILS=domi@aisapira.com,lrmontero@gmail.com  # Emails separados por coma
BANCO_CENTRAL_SEND_SUCCESS_REPORT=true  # true/false - Enviar reportes diarios de éxito
```

### Credenciales

Para obtener credenciales de acceso a la API del Banco Central:

1. Visita: https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/doc_es.htm
2. Regístrate con tu email
3. Usa las credenciales proporcionadas

## Indicadores Disponibles

El módulo incluye los siguientes indicadores económicos principales:

-   **UF (Unidad de Fomento)**: `F073.UFF.PRE.Z.D`
-   **Dólar Observado (Peso Chileno)**: `F073.TCO.PRE.Z.D`
-   **Dólar/Peso Argentino**: `F072.ARS.USD.N.O.D`
-   **Dólar/Peso Colombiano**: `F072.COP.USD.N.O.D`
-   **Dólar/Peso Mexicano**: `F072.MXN.USD.N.O.D`
-   **Dólar/Peso Uruguayo**: `F072.UYU.USD.N.O.D`
-   **Dólar/Real Brasileño**: `F072.BRL.USD.N.O.D`
-   **Dólar/Sol Peruano**: `F072.PEN.USD.N.O.D`
-   **Euro**: `F072.EUR.USD.N.O.D`
-   **IPC (Índice de Precios al Consumidor)**: `F07.IPC.IND.Z.Z.EP18.Z.Z.Z.M`
-   **TPM (Tasa de Política Monetaria)**: `F022.TPM.TIN.D001.NO.Z.D`

## Funcionalidades

Este módulo proporciona dos funcionalidades principales:

1. **Indicadores Económicos**: Sincronización y consulta de indicadores como UF, IPC, TPM
2. **Exchange Rates (Tipos de Cambio)**: Sincronización y gestión de tipos de cambio para cálculos contables multi-moneda

## Endpoints Disponibles

### Indicadores Económicos

#### 1. Obtener Serie de Tiempo

**GET** `/banco-central/series`

Consulta una serie de tiempo específica del Banco Central.

**Query Parameters:**

-   `timeseries` (obligatorio): Código de la serie (enum: UF, DOLAR_OBSERVADO, EURO, IPC, TPM)
-   `firstdate` (opcional): Fecha desde (YYYY-MM-DD)
-   `lastdate` (opcional): Fecha hasta (YYYY-MM-DD)

**Ejemplo:**

```bash
GET /banco-central/series?timeseries=F073.UFF.PRE.Z.D&firstdate=2024-01-01&lastdate=2024-12-31
```

**Respuesta:**

```json
{
	"Codigo": 0,
	"Descripcion": "Success",
	"Series": {
		"descripEsp": "Unidad de fomento (pesos)",
		"descripIng": "Unidad de fomento (Chilean pesos)",
		"seriesId": "F073.UFF.PRE.Z.D",
		"Obs": [
			{
				"indexDateString": "01-01-2024",
				"value": "36280.45",
				"statusCode": "OK"
			}
		]
	},
	"SeriesInfos": []
}
```

### 2. Sincronizar Indicadores

**POST** `/banco-central/sync`

Sincroniza los indicadores económicos principales y los guarda en la base de datos.

**Body Parameters:**

-   `firstdate` (opcional): Fecha desde (YYYY-MM-DD). Por defecto: hace 30 días
-   `lastdate` (opcional): Fecha hasta (YYYY-MM-DD). Por defecto: hoy

**Ejemplo:**

```bash
POST /banco-central/sync
Content-Type: application/json

{
  "firstdate": "2024-01-01",
  "lastdate": "2024-12-31"
}
```

**Respuesta:**

```json
{
	"synced": 1825,
	"errors": 0
}
```

### 3. Obtener Últimos Valores

**GET** `/banco-central/indicators/latest`

Retorna el último valor registrado de cada indicador económico.

**Ejemplo:**

```bash
GET /banco-central/indicators/latest
```

**Respuesta:**

```json
[
	{
		"codigo": "F073.UFF.PRE.Z.D",
		"nombre": "Unidad de fomento (pesos)",
		"fecha": "2024-12-31T00:00:00.000Z",
		"valor": 36280.45,
		"unidad": null
	},
	{
		"codigo": "F073.TCO.PRE.Z.D",
		"nombre": "Dólar observado",
		"fecha": "2024-12-31T00:00:00.000Z",
		"valor": 950.25,
		"unidad": null
	}
]
```

### 4. Obtener Historial de Indicador

**GET** `/banco-central/indicators/:codigo/history`

Retorna el historial de valores de un indicador específico.

**Path Parameters:**

-   `codigo`: Código del indicador

**Query Parameters:**

-   `fecha_inicio` (opcional): Fecha desde (YYYY-MM-DD)
-   `fecha_fin` (opcional): Fecha hasta (YYYY-MM-DD)

**Ejemplo:**

```bash
GET /banco-central/indicators/F073.UFF.PRE.Z.D/history?fecha_inicio=2024-01-01&fecha_fin=2024-01-31
```

### Exchange Rates (Tipos de Cambio)

#### 5. Sincronizar Tipos de Cambio

**POST** `/banco-central/exchange-rates/sync`

Sincroniza tipos de cambio desde el Banco Central y los guarda en la tabla `exchange_rates`. Incluye conversiones directas (USD/CLP, USD/COP, etc.) y conversiones indirectas (CLF→CLP→USD). Calcula automáticamente los promedios mensuales después de la sincronización.

**Body Parameters:**

-   `startDate` (obligatorio): Fecha desde (YYYY-MM-DD)
-   `endDate` (obligatorio): Fecha hasta (YYYY-MM-DD)
-   `currencyPairs` (opcional): Array de pares de monedas a sincronizar (ej: ["USD/CLP", "USD/COP"])

**Ejemplo:**

```bash
POST /banco-central/exchange-rates/sync
Content-Type: application/json

{
  "startDate": "2025-01-01",
  "endDate": "2025-01-31"
}
```

**Respuesta:**

```json
{
	"success": true,
	"message": "Sincronización completada exitosamente",
	"stats": {
		"totalProcessed": 217,
		"inserted": 200,
		"updated": 17,
		"errors": 0,
		"indirectConversions": 31
	},
	"monthlyAveragesCalculated": {
		"periods": 1,
		"currencyPairs": 8
	}
}
```

#### 6. Sincronizar Tipos de Cambio Históricos

**POST** `/banco-central/exchange-rates/sync-historical`

Sincroniza todos los tipos de cambio desde el 1 de enero de 2025 hasta hoy.

**Ejemplo:**

```bash
POST /banco-central/exchange-rates/sync-historical
```

#### 7. Calcular Promedios Mensuales

**POST** `/banco-central/exchange-rates/calculate-monthly`

Calcula los promedios mensuales (AVG, MIN, MAX) de tipos de cambio. Si no se especifica año/mes, calcula para todos los períodos disponibles.

**Body Parameters:**

-   `year` (opcional): Año a calcular
-   `month` (opcional): Mes a calcular (1-12)

**Ejemplo:**

```bash
POST /banco-central/exchange-rates/calculate-monthly
Content-Type: application/json

{
  "year": 2025,
  "month": 1
}
```

#### 8. Obtener Últimos Tipos de Cambio

**GET** `/banco-central/exchange-rates/latest`

Retorna el último tipo de cambio registrado para cada par de monedas.

**Query Parameters:**

-   `fromCurrency` (opcional): Moneda origen (ej: USD)
-   `toCurrency` (opcional): Moneda destino (ej: CLP)

**Ejemplo:**

```bash
GET /banco-central/exchange-rates/latest?fromCurrency=USD&toCurrency=CLP
```

**Respuesta:**

```json
[
	{
		"rate_date": "2025-01-31T00:00:00.000Z",
		"from_currency": "USD",
		"to_currency": "CLP",
		"rate": 950.25,
		"source_type": "BANCOCENTRAL",
		"api_source": "Banco Central de Chile",
		"is_indirect_conversion": false,
		"conversion_chain": null
	}
]
```

#### 9. Obtener Historial de Tipos de Cambio

**GET** `/banco-central/exchange-rates/history`

Retorna el historial de tipos de cambio con filtros opcionales.

**Query Parameters:**

-   `fromCurrency` (opcional): Moneda origen
-   `toCurrency` (opcional): Moneda destino
-   `startDate` (opcional): Fecha desde (YYYY-MM-DD)
-   `endDate` (opcional): Fecha hasta (YYYY-MM-DD)
-   `limit` (opcional): Número máximo de resultados (default: 100)

**Ejemplo:**

```bash
GET /banco-central/exchange-rates/history?fromCurrency=USD&toCurrency=CLP&startDate=2025-01-01&limit=50
```

#### 10. Obtener Promedios Mensuales

**GET** `/banco-central/exchange-rates/monthly-averages`

Retorna los promedios mensuales calculados de tipos de cambio.

**Query Parameters:**

-   `year` (opcional): Filtrar por año
-   `month` (opcional): Filtrar por mes (1-12)

**Ejemplo:**

```bash
GET /banco-central/exchange-rates/monthly-averages?year=2025&month=1
```

**Respuesta:**

```json
[
	{
		"from_currency": "USD",
		"to_currency": "CLP",
		"year": 2025,
		"month": 1,
		"avg_rate": 945.67,
		"min_rate": 935.5,
		"max_rate": 955.8,
		"data_points": 21,
		"calculated_at": "2025-02-01T10:30:00.000Z"
	}
]
```

El módulo mapea automáticamente los códigos del Banco Central a pares de monedas:

| Código Banco Central | Par de Monedas | Descripción           |
| -------------------- | -------------- | --------------------- |
| `F073.TCO.PRE.Z.D`   | USD/CLP        | Dólar Observado       |
| `F072.ARS.USD.N.O.D` | USD/ARS        | Dólar Peso Argentino  |
| `F072.COP.USD.N.O.D` | USD/COP        | Dólar Peso Colombiano |
| `F072.MXN.USD.N.O.D` | USD/MXN        | Dólar Peso Mexicano   |
| `F072.UYU.USD.N.O.D` | USD/UYU        | Dólar Peso Uruguayo   |
| `F072.BRL.USD.N.O.D` | USD/BRL        | Dólar Real Brasileño  |
| `F072.PEN.USD.N.O.D` | USD/PEN        | Dólar Sol Peruano     |
| `F072.EUR.USD.N.O.D` | EUR/USD        | Euro                  |
| `F073.UFF.PRE.Z.D`   | CLF/CLP        | Unidad de Fomento     |

### Conversiones Indirectas

El servicio calcula automáticamente conversiones indirectas:

-   **CLF → USD**: Se calcula usando la cadena CLF→CLP→USD
    -   Ejemplo: Si CLF/CLP = 36,280 y USD/CLP = 950, entonces CLF/USD = 36,280 / 950 = 38.19

## Estructura del Módulo

```
banco-central/
├── dtos/
│   ├── calculate-monthly-avg.dto.ts    # DTO para calcular promedios mensuales
│   ├── get-exchange-rates.dto.ts       # DTOs para consultar exchange rates
│   ├── get-series.dto.ts               # DTO para consultar series
│   ├── sync-exchange-rates.dto.ts      # DTO para sincronizar exchange rates
│   └── sync-indicators.dto.ts          # DTO para sincronizar indicadores
├── entities/
│   ├── exchange-rate.entity.ts         # Entidad para tipos de cambio
│   ├── exchange-rate-monthly-avg.entity.ts # Entidad para promedios mensuales
│   └── indicador-economico.entity.ts   # Entidad para indicadores económicos
├── services/
│   └── exchange-rates.service.ts       # Servicio para tipos de cambio
├── interfaces/
│   └── banco-central.interface.ts      # Interfaces y enums
├── banco-central.controller.ts         # Controlador con 10 endpoints
├── banco-central.module.ts             # Módulo de NestJS
├── banco-central.service.ts            # Servicio para indicadores económicos
└── README.md                           # Documentación
```

## Base de Datos

### Tabla: `indicadores_economicos`

```sql
CREATE TABLE indicadores_economicos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  codigo VARCHAR(100) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  fecha DATE NOT NULL,
  valor DECIMAL(18, 6) NOT NULL,
  unidad VARCHAR(50),
  status_code VARCHAR(20) DEFAULT 'OK',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(codigo, fecha)
);

CREATE INDEX idx_indicadores_codigo ON indicadores_economicos(codigo);
CREATE INDEX idx_indicadores_fecha ON indicadores_economicos(fecha);
```

### Tabla: `exchange_rates`

```sql
CREATE TABLE exchange_rates (
  rate_date DATE NOT NULL,
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  rate NUMERIC(20, 8) NOT NULL,
  source_type VARCHAR(50) DEFAULT 'BANCOCENTRAL',
  api_source VARCHAR(100),
  is_indirect_conversion BOOLEAN DEFAULT false,
  conversion_chain JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_date, from_currency, to_currency)
);

CREATE INDEX idx_exchange_rates_currencies ON exchange_rates(from_currency, to_currency);
CREATE INDEX idx_exchange_rates_date ON exchange_rates(rate_date);
```

### Tabla: `exchange_rates_monthly_avg`

```sql
CREATE TABLE exchange_rates_monthly_avg (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  avg_rate NUMERIC(20, 8) NOT NULL,
  min_rate NUMERIC(20, 8) NOT NULL,
  max_rate NUMERIC(20, 8) NOT NULL,
  data_points INTEGER NOT NULL,
  calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_currency, to_currency, year, month)
);

CREATE INDEX idx_monthly_avg_currencies ON exchange_rates_monthly_avg(from_currency, to_currency);
CREATE INDEX idx_monthly_avg_period ON exchange_rates_monthly_avg(year, month);
```

**Nota**: Los triggers automáticos para calcular promedios mensuales fueron eliminados. Los promedios se calculan mediante el servicio `ExchangeRatesService`.

## Autenticación

Todos los endpoints requieren autenticación mediante Bearer Token (Supabase Auth).

## Uso en Otros Módulos

### Usando Indicadores Económicos

```typescript
import { BancoCentralModule } from '@/modules/banco-central/banco-central.module';
import { BancoCentralService } from '@/modules/banco-central/banco-central.service';

@Module({
	imports: [BancoCentralModule],
})
export class OtroModule {
	constructor(private readonly bancoCentralService: BancoCentralService) {}

	async obtenerUF() {
		const response = await this.bancoCentralService.getSeries({
			timeseries: IndicadorEconomico.UF,
			firstdate: '2024-01-01',
			lastdate: '2024-01-31',
		});

		return response.Series.Obs;
	}

	async sincronizarIndicadores() {
		const result = await this.bancoCentralService.syncIndicators({
			firstdate: '2024-01-01',
		});

		console.log(`Sincronizados: ${result.synced}, Errores: ${result.errors}`);
	}

	async obtenerHistorialDolar() {
		const historial = await this.bancoCentralService.getIndicatorHistory('F073.TCO.PRE.Z.D', '2024-01-01', '2024-12-31');

		return historial;
	}
}
```

### Usando Exchange Rates

```typescript
import { BancoCentralModule } from '@/modules/banco-central/banco-central.module';
import { ExchangeRatesService } from '@/modules/banco-central/services/exchange-rates.service';

@Module({
	imports: [BancoCentralModule],
})
export class ContabilidadModule {
	constructor(private readonly exchangeRatesService: ExchangeRatesService) {}

	async sincronizarTiposCambio() {
		// Sincronizar tipos de cambio del mes actual
		const result = await this.exchangeRatesService.syncExchangeRates({
			startDate: '2025-01-01',
			endDate: '2025-01-31',
		});

		console.log(`Sincronizados: ${result.stats.totalProcessed}`);
		console.log(`Conversiones indirectas: ${result.stats.indirectConversions}`);
	}

	async obtenerTipoCambioActual(fromCurrency: string, toCurrency: string) {
		const rates = await this.exchangeRatesService.getLatestExchangeRates({
			fromCurrency,
			toCurrency,
		});

		return rates[0]?.rate;
	}

	async obtenerPromedioMensual(year: number, month: number) {
		const averages = await this.exchangeRatesService.getMonthlyAverages(year, month);

		return averages;
	}

	async calcularConversionCLFaUSD(montoClf: number) {
		// Obtener último tipo de cambio CLF/USD (conversión indirecta)
		const rates = await this.exchangeRatesService.getLatestExchangeRates({
			fromCurrency: 'CLF',
			toCurrency: 'USD',
		});

		if (rates.length === 0) {
			throw new Error('No se encontró tipo de cambio CLF/USD');
		}

		const rate = rates[0];
		const montoUsd = montoClf * rate.rate;

		return {
			montoClf,
			montoUsd,
			rate: rate.rate,
			fecha: rate.rate_date,
			esConversionIndirecta: rate.is_indirect_conversion,
			cadenaConversion: rate.conversion_chain,
		};
	}
}
```

## Programación de Sincronización

Para sincronizar automáticamente los indicadores, puedes crear un cron job:

```typescript
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BancoCentralService } from '@/modules/banco-central/banco-central.service';

@Injectable()
export class IndicadoresScheduler {
	constructor(private readonly bancoCentralService: BancoCentralService) {}

	@Cron(CronExpression.EVERY_DAY_AT_6AM)
	async syncDailyIndicators() {
		await this.bancoCentralService.syncIndicators({});
	}
}
```

## Documentación API Banco Central

Para más información sobre la API del Banco Central:

-   Documentación: https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/doc_es.htm
-   Catálogo de Series: https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/Webservices/series.xlsx
