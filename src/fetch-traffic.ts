#!/usr/bin/env node
/**
 * Récupère les données OTD :
 * 1) Table des sites de mesure (MST) — pullMeasurementSiteTable
 * 2) Mesures en temps réel — pullMeasuredData (filter CH:#)
 *
 * Usage:
 *   OTD_BEARER_TOKEN=xxx npx tsx src/fetch-traffic.ts
 *   OTD_BEARER_TOKEN=xxx node dist/fetch-traffic.js
 *
 * Fichiers générés : sites.xml (MST), response.xml (mesures).
 *
 * Options:
 *   --filter ID    Filtre des sites (défaut: CH:#). Ex: CH:0026.#
 *   --sites        Écrire uniquement sites.xml
 *   --measures     Écrire uniquement response.xml
 *   --no-write     Ne pas écrire de fichiers (test uniquement)
 */

import { config } from './config.js';
import {
  measuredDataFilterBody,
  measurementSiteTableBody,
} from './soap-templates.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const { otd } = config;
const API_URL = otd.apiUrl;

async function soapRequest(
  body: string,
  soapAction: string
): Promise<string> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      SOAPAction: soapAction,
      Authorization: `Bearer ${otd.bearerToken}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`
    );
  }

  return res.text();
}

async function fetchMeasurementSiteTable(): Promise<string> {
  const body = measurementSiteTableBody(otd.clientId);
  console.log('Requête pullMeasurementSiteTable (MST)...');
  const xml = await soapRequest(body, otd.soapAction.pullMeasurementSiteTable);
  console.log('MST reçue, taille:', xml.length, 'octets');
  return xml;
}

async function fetchMeasuredData(siteFilter = 'CH:#'): Promise<string> {
  const body = measuredDataFilterBody(otd.clientId, siteFilter);
  console.log('Requête pullMeasuredData (filter:', siteFilter, ')...');
  const xml = await soapRequest(body, otd.soapAction.pullMeasuredData);
  console.log('Mesures reçues, taille:', xml.length, 'octets');
  return xml;
}

async function main(): Promise<void> {
  const outDir = process.cwd();
  const writeSites = process.argv.includes('--sites');
  const writeMeasures = process.argv.includes('--measures');
  const defaultWrite = !process.argv.includes('--no-write');
  const filterIndex = process.argv.indexOf('--filter');
  const siteFilter =
    filterIndex >= 0 && process.argv[filterIndex + 1]
      ? process.argv[filterIndex + 1]
      : 'CH:#';

  try {
    const [sitesXml, measuresXml] = await Promise.all([
      fetchMeasurementSiteTable(),
      fetchMeasuredData(siteFilter),
    ]);

    if (writeSites || defaultWrite) {
      const sitesPath = join(outDir, 'sites.xml');
      await writeFile(sitesPath, sitesXml, 'utf-8');
      console.log('Écrit:', sitesPath);
    }

    if (writeMeasures || defaultWrite) {
      const measuresPath = join(outDir, 'response.xml');
      await writeFile(measuresPath, measuresXml, 'utf-8');
      console.log('Écrit:', measuresPath);
    }

    if (!defaultWrite && !writeSites && !writeMeasures) {
      console.log('Aucun fichier écrit (utilisez --sites et/ou --measures pour écrire).');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
