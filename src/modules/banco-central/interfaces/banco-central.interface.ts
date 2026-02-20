export interface BancoCentralResponse {
	Codigo: number;
	Descripcion: string;
	Series: BancoCentralSeries;
	SeriesInfos: any[];
}

export interface BancoCentralSeries {
	descripEsp: string;
	descripIng: string;
	seriesId: string;
	Obs: BancoCentralObservation[];
}

export interface BancoCentralObservation {
	indexDateString: string;
	value: string;
	statusCode: string;
}

export enum IndicadorEconomico {
	UF = 'F073.UFF.PRE.Z.D',
	DOLAR_OBSERVADO = 'F073.TCO.PRE.Z.D',
	DOLAR_PESO_ARGENTINO = 'F072.ARS.USD.N.O.D',
	DOLAR_PESO_COLOMBIANO = 'F072.COP.USD.N.O.D',
	DOLAR_PESO_MEXICANO = 'F072.MXN.USD.N.O.D',
	DOLAR_PESO_URUGUAYO = 'F072.UYU.USD.N.O.D',
	DOLAR_REAL_BRASILENO = 'F072.BRL.USD.N.O.D',
	DOLAR_SOL_PERUANO = 'F072.PEN.USD.N.O.D',
	EURO = 'F072.EUR.USD.N.O.D',
	IPC = 'F07.IPC.IND.Z.Z.EP18.Z.Z.Z.M',
	TPM = 'F022.TPM.TIN.D001.NO.Z.D',
}

export interface IndicadorEconomicoData {
	codigo: string;
	nombre: string;
	fecha: Date;
	valor: number;
	unidad?: string;
}
