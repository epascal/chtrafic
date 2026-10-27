const DX = 'http://datex2.eu/schema/2/2_0';
const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';

/**
 * Enveloppe SOAP générique avec exchange (supplierIdentification).
 */
function envelope(body: string, clientId: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_ENV}"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:dx223="${DX}">
  <SOAP-ENV:Body>
    <dx223:d2LogicalModel modelBaseVersion="2">
      <dx223:exchange>
        <dx223:supplierIdentification>
          <dx223:country>ch</dx223:country>
          <dx223:nationalIdentifier>${escapeXml(clientId)}</dx223:nationalIdentifier>
        </dx223:supplierIdentification>
      </dx223:exchange>
      ${body}
    </dx223:d2LogicalModel>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Corps pour pullMeasuredData : MeasuredDataFilter avec siteRequestReference CH:#
 */
export function measuredDataFilterBody(clientId: string, siteFilter = 'CH:#'): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = `<dx223:payloadPublication xsi:type="dx223:GenericPublication" lang="en">
        <dx223:publicationTime>${now}</dx223:publicationTime>
        <dx223:publicationCreator>
          <dx223:country>ch</dx223:country>
          <dx223:nationalIdentifier>${escapeXml(clientId)}</dx223:nationalIdentifier>
        </dx223:publicationCreator>
        <dx223:genericPublicationName>MeasuredDataFilter</dx223:genericPublicationName>
        <dx223:genericPublicationExtension>
          <dx223:measuredDataFilter>
            <dx223:measurementSiteTableReference targetClass="MeasurementSiteTable"
                                                 id="OTD:TrafficData"
                                                 version="0"/>
            <dx223:siteRequestReference targetClass="MeasurementSiteRecord" id="${escapeXml(siteFilter)}" version="0"/>
          </dx223:measuredDataFilter>
        </dx223:genericPublicationExtension>
      </dx223:payloadPublication>`;
  return envelope(body, clientId);
}

/**
 * Corps pour pullMeasurementSiteTable : requête minimale (exchange seul).
 * L’API renvoie la table des sites (MST) complète.
 */
export function measurementSiteTableBody(clientId: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = `<dx223:payloadPublication xsi:type="dx223:GenericPublication" lang="en">
        <dx223:publicationTime>${now}</dx223:publicationTime>
        <dx223:publicationCreator>
          <dx223:country>ch</dx223:country>
          <dx223:nationalIdentifier>${escapeXml(clientId)}</dx223:nationalIdentifier>
        </dx223:publicationCreator>
        <dx223:genericPublicationName>MeasurementSiteTableRequest</dx223:genericPublicationName>
        <dx223:genericPublicationExtension>
          <dx223:measurementSiteTableReference targetClass="MeasurementSiteTable" id="OTD:TrafficData" version="0"/>
        </dx223:genericPublicationExtension>
      </dx223:payloadPublication>`;
  return envelope(body, clientId);
}
