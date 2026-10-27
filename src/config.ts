/**
 * Configuration OTD (DATEX II) et TomTom Traffic.
 * Charge .env à la racine du projet si présent.
 */
import 'dotenv/config';

const OTD_BEARER_TOKEN = process.env.OTD_BEARER_TOKEN ?? '';

/**
 * Résout la clé TomTom active.
 * Ordre : `TOMTOM_API_KEY` (souvent injectée par le cron d'alternance),
 * puis `TOMTOM_API_KEY_1`, puis `TOMTOM_API_KEY_2`.
 */
function resolveTomTomApiKey(): string {
  return process.env.TOMTOM_API_KEY
    || process.env.TOMTOM_API_KEY_1
    || process.env.TOMTOM_API_KEY_2
    || '';
}

export const config = {
  /** Open Transport Data (DATEX II) */
  otd: {
    apiUrl: 'https://api.opentransportdata.swiss/TDP/Soap_Datex2/Pull',
    soapAction: {
      pullMeasuredData: 'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullMeasuredData',
      pullMeasurementSiteTable: 'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullMeasurementSiteTable',
    },
    get bearerToken(): string {
      if (!OTD_BEARER_TOKEN) {
        throw new Error('OTD_BEARER_TOKEN manquant. Définissez la variable d’environnement.');
      }
      return OTD_BEARER_TOKEN;
    },
    clientId: process.env.OTD_CLIENT_ID ?? 'your_client',
  },

  /** TomTom Traffic API (Flow Segment Data) */
  tomtom: {
    baseUrl: 'https://api.tomtom.com',
    serviceVersion: 4,
    get apiKey(): string {
      const key = resolveTomTomApiKey();
      if (!key) {
        throw new Error(
          'Clé TomTom manquante. Définissez TOMTOM_API_KEY, TOMTOM_API_KEY_1 ou TOMTOM_API_KEY_2.',
        );
      }
      return key;
    },
  },
} as const;
