import https from 'https';
import zlib from 'zlib';
import forge from 'node-forge';
import { XMLParser } from 'fast-xml-parser';

export type AmbienteSefaz = '1' | '2'; // 1 = Produção, 2 = Homologação

export const URLS_SEFAZ_AN: Record<AmbienteSefaz, string> = {
  '1': 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  '2': 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
};

export interface ParametrosConsultaChave {
  chave: string;
  cnpjCertificado: string;
  cUFAutor: string;
  tpAmb: AmbienteSefaz;
  agent: https.Agent;
  timeoutMs?: number;
  maxTentativas?: number;
  simularSefaz?: boolean;
  dadosNotaSimulacao?: {
    numero: string;
    destinatario: string;
    cnpjCpfDest: string;
    valor: number;
    dataEmissao: string;
    ufDest: string;
  };
}

export interface ResultadoConsultaSefaz {
  cStat: string;
  xMotivo: string;
  status: 'baixado' | 'nao_encontrado' | 'apenas_resumo' | 'consumo_indevido' | 'erro';
  xmlProcNFe?: string;
  schemaEncontrado?: string;
}

/**
 * Monta o XML distDFeInt versão 1.01 com consulta por chave de acesso (consChNFe)
 * dentro do envelope SOAP 1.2 exigido pelo webservice NFeDistribuicaoDFe.
 */
export function montarEnvelopeSoapDistDFe(params: {
  tpAmb: AmbienteSefaz;
  cUFAutor: string;
  cnpj: string;
  chave: string;
}): string {
  const cUF = (params.cUFAutor || params.chave.substring(0, 2) || '29').padStart(2, '0');
  const cnpjLimpo = params.cnpj.replace(/\D/g, '');
  const chaveLimpa = params.chave.replace(/\D/g, '');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>${params.tpAmb}</tpAmb>
          <cUFAutor>${cUF}</cUFAutor>
          <CNPJ>${cnpjLimpo}</CNPJ>
          <consChNFe>
            <chNFe>${chaveLimpa}</chNFe>
          </consChNFe>
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>`;
}

/**
 * Cria um https.Agent em memória para conexão TLS mútua com os webservices da SEFAZ.
 */
export function criarAgenteTlsSefaz(pfx: Buffer, passphrase: string): https.Agent {
  // Converte o .pfx para PEM com node-forge. Passar o .pfx direto ao Node 22 (OpenSSL 3)
  // falha com "Unsupported PKCS12 PFX data" em muitos certificados A1 (criptografia RC2/3DES).
  const p12 = forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary'))),
    false,
    passphrase
  );
  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));
  if (!keyBag?.key || certs.length === 0) {
    throw new Error('Certificado sem chave privada ou sem certificado do titular.');
  }
  // O certificado do titular (não-AC) vai primeiro na cadeia.
  const ehAC = (c: forge.pki.Certificate) => Number(Boolean((c.getExtension('basicConstraints') as { cA?: boolean } | null)?.cA));
  certs.sort((a, b) => ehAC(a) - ehAC(b));

  return new https.Agent({
    key: forge.pki.privateKeyToPem(keyBag.key),
    cert: certs.map((c) => forge.pki.certificateToPem(c)).join('\n'),
    rejectUnauthorized: false, // Cadeia ICP-Brasil da SEFAZ requer verificação flexível no cliente Node
    keepAlive: true,
    timeout: 30000,
  });
}

/**
 * Decodifica um conteúdo Base64 compactado com GZIP (<docZip>) e retorna a string XML.
 */
export function decodificarDocZip(base64Gzip: string): string {
  const bufferComprimido = Buffer.from(base64Gzip.trim(), 'base64');
  const bufferDescomprimido = zlib.gunzipSync(bufferComprimido);
  return bufferDescomprimido.toString('utf8');
}

/**
 * Executa a requisição HTTPS SOAP 1.2 para a SEFAZ com timeout configurável.
 */
function executarRequisicaoHttps(
  urlStr: string,
  soapXml: string,
  agent: https.Agent,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const bodyBuffer = Buffer.from(soapXml, 'utf8');

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      agent,
      timeout: timeoutMs,
      headers: {
        'Content-Type':
          'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"',
        'Content-Length': bodyBuffer.length,
        'User-Agent': 'BaixadorXmlNFe/1.0',
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const respostaTexto = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(respostaTexto);
        } else {
          reject(
            new Error(
              `SEFAZ retornou status HTTP ${res.statusCode}: ${respostaTexto.slice(0, 250)}`
            )
          );
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Tempo limite de ${timeoutMs / 1000}s excedido ao conectar na SEFAZ.`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(bodyBuffer);
    req.end();
  });
}

/**
 * Faz o parse do XML SOAP de retorno do NFeDistribuicaoDFe e extrai os documentos de <docZip>.
 */
export function processarRespostaSoapDistDFe(soapResponseXml: string): ResultadoConsultaSefaz {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
  });

  const parsed = parser.parse(soapResponseXml);

  const envelope = parsed?.Envelope;
  const body = envelope?.Body;
  const responseNode =
    body?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult ||
    body?.nfeDistDFeInteresseResult ||
    body;

  const retDistDFeInt = responseNode?.retDistDFeInt || parsed?.retDistDFeInt;

  if (!retDistDFeInt) {
    throw new Error('Resposta da SEFAZ não contém a estrutura <retDistDFeInt> esperada.');
  }

  const cStat = String(retDistDFeInt.cStat || '').trim();
  const xMotivo = String(retDistDFeInt.xMotivo || 'Sem motivo retornado pela SEFAZ').trim();

  // 137 = Nenhum documento localizado
  if (cStat === '137') {
    return {
      cStat,
      xMotivo,
      status: 'nao_encontrado',
    };
  }

  // 656 = Consumo Indevido
  if (cStat === '656') {
    return {
      cStat,
      xMotivo,
      status: 'consumo_indevido',
    };
  }

  // 138 = Documento(s) localizado(s)
  if (cStat === '138') {
    const lote = retDistDFeInt.loteDistDFeInt;
    if (!lote || !lote.docZip) {
      return {
        cStat,
        xMotivo: 'cStat 138 retornado, porém loteDistDFeInt está vazio.',
        status: 'nao_encontrado',
      };
    }

    const docs = Array.isArray(lote.docZip) ? lote.docZip : [lote.docZip];

    let xmlProcNFe: string | undefined;
    let encontrouResumo = false;
    let schemaEncontrado = '';

    for (const docItem of docs) {
      const schemaAttr =
        typeof docItem === 'object' ? String(docItem['@_schema'] || '') : '';
      const base64Conteudo =
        typeof docItem === 'object' ? String(docItem['#text'] || '') : String(docItem || '');

      if (!base64Conteudo) continue;

      const xmlDescomprimido = decodificarDocZip(base64Conteudo);
      schemaEncontrado = schemaAttr;

      const isProcNFe =
        schemaAttr.toLowerCase().includes('procnfe') ||
        xmlDescomprimido.includes('<nfeProc') ||
        xmlDescomprimido.includes('<procNFe');

      const isResNFe =
        schemaAttr.toLowerCase().includes('resnfe') ||
        xmlDescomprimido.includes('<resNFe');

      if (isProcNFe) {
        xmlProcNFe = xmlDescomprimido;
        break;
      } else if (isResNFe) {
        encontrouResumo = true;
      }
    }

    if (xmlProcNFe) {
      return {
        cStat,
        xMotivo: `${cStat} - ${xMotivo}`,
        status: 'baixado',
        xmlProcNFe,
        schemaEncontrado,
      };
    }

    if (encontrouResumo) {
      return {
        cStat,
        xMotivo: 'Apenas resumo disponível (resNFe) — XML completo (procNFe) não liberado pela SEFAZ',
        status: 'apenas_resumo',
        schemaEncontrado,
      };
    }

    return {
      cStat,
      xMotivo: 'Documento retornado não corresponde ao schema procNFe.',
      status: 'nao_encontrado',
      schemaEncontrado,
    };
  }

  // Qualquer outro código de retorno da SEFAZ
  return {
    cStat,
    xMotivo: `${cStat} - ${xMotivo}`,
    status: 'erro',
  };
}

/**
 * Gera uma resposta SOAP 1.2 realista (com GZIP + Base64 em <docZip schema="procNFe_v4.00.xsd">)
 * quando o modo de simulação/homologação local com certificado de teste é utilizado.
 */
export function gerarRespostaSoapSimulada(params: ParametrosConsultaChave): string {
  const { chave, cnpjCertificado, tpAmb, dadosNotaSimulacao } = params;
  const xmlProcNFe = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe${chave}" versao="4.00">
      <ide>
        <cUF>${chave.substring(0, 2)}</cUF>
        <natOp>VENDA DE MERCADORIA</natOp>
        <mod>55</mod>
        <serie>${ parseInt(chave.substring(22, 25), 10) || 1 }</serie>
        <nNF>${ parseInt(chave.substring(25, 34), 10) || 568 }</nNF>
        <dhEmi>${dadosNotaSimulacao?.dataEmissao || new Date().toISOString()}</dhEmi>
        <tpNF>1</tpNF>
        <tpAmb>${tpAmb}</tpAmb>
      </ide>
      <emit>
        <CNPJ>${chave.substring(6, 20)}</CNPJ>
        <xNome>EMITENTE CONSULTADO VIA NFeDistribuicaoDFe</xNome>
      </emit>
      <dest>
        <xNome>${dadosNotaSimulacao?.destinatario || 'DESTINATARIO NF-E'}</xNome>
        <UF>${dadosNotaSimulacao?.ufDest || 'SP'}</UF>
      </dest>
      <total>
        <ICMSTot>
          <vNF>${(dadosNotaSimulacao?.valor || 0).toFixed(2)}</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>${tpAmb}</tpAmb>
      <verAplic>AN_1.01</verAplic>
      <chNFe>${chave}</chNFe>
      <dhRecbto>${new Date().toISOString()}</dhRecbto>
      <nProt>1${chave.substring(0, 2)}260000123456</nProt>
      <digVal>dGVzdGVkaWd2YWxuZmU=</digVal>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;

  const gzipped = zlib.gzipSync(Buffer.from(xmlProcNFe, 'utf8'));
  const base64Doc = gzipped.toString('base64');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDistDFeInteresseResult>
        <retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>${tpAmb}</tpAmb>
          <verAplic>1.01</verAplic>
          <cStat>138</cStat>
          <xMotivo>Documento localizado</xMotivo>
          <dhResp>${new Date().toISOString()}</dhResp>
          <ultNSU>000000000000001</ultNSU>
          <maxNSU>000000000000001</maxNSU>
          <loteDistDFeInt>
            <docZip NSU="000000000000001" schema="procNFe_v4.00.xsd">${base64Doc}</docZip>
          </loteDistDFeInt>
        </retDistDFeInt>
      </nfeDistDFeInteresseResult>
    </nfeDistDFeInteresseResponse>
  </soap:Body>
</soap:Envelope>`;
}

/**
 * Consulta uma chave de acesso no webservice NFeDistribuicaoDFe da SEFAZ
 * com suporte a até 2 novas tentativas em caso de falha de rede/timeout.
 */
export async function consultarChaveSefaz(
  params: ParametrosConsultaChave
): Promise<ResultadoConsultaSefaz> {
  const timeoutMs = params.timeoutMs ?? 30000;
  const maxTentativas = params.maxTentativas ?? 3; // 1 tentativa inicial + até 2 novas tentativas

  const cUFAutor = params.cUFAutor || params.chave.substring(0, 2) || '29';
  const soapEnvelope = montarEnvelopeSoapDistDFe({
    tpAmb: params.tpAmb,
    cUFAutor,
    cnpj: params.cnpjCertificado,
    chave: params.chave,
  });

  if (params.simularSefaz) {
    await new Promise((r) => setTimeout(r, 250));
    const soapSimulado = gerarRespostaSoapSimulada(params);
    return processarRespostaSoapDistDFe(soapSimulado);
  }

  const url = URLS_SEFAZ_AN[params.tpAmb];
  let ultimoErro: Error | null = null;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      const respostaXml = await executarRequisicaoHttps(
        url,
        soapEnvelope,
        params.agent,
        timeoutMs
      );
      return processarRespostaSoapDistDFe(respostaXml);
    } catch (err: any) {
      ultimoErro = err instanceof Error ? err : new Error(String(err));
      if (tentativa < maxTentativas) {
        // Aguarda 1.5s antes da próxima tentativa de rede
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  return {
    cStat: 'ERRO_REDE',
    xMotivo: `Falha de comunicação com a SEFAZ após ${maxTentativas} tentativas: ${
      ultimoErro?.message || 'Serviço indisponível'
    }`,
    status: 'erro',
  };
}
