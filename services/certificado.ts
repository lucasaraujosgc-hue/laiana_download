import forge from 'node-forge';

export interface DadosCertificado {
  cnpj: string;
  cnpjFormatado: string;
  razaoSocial: string;
  emissor: string;
  validoDe: string;
  validoAte: string;
  validoDeIso: string;
  validoAteIso: string;
  diasRestantes: number;
  vencido: boolean;
  isCertificadoTeste?: boolean;
}

export function formatarCnpj(cnpj: string): string {
  const limpo = cnpj.replace(/\D/g, '');
  if (limpo.length !== 14) return cnpj;
  return limpo.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5'
  );
}

export function formatarDataBr(data: Date): string {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const ano = data.getFullYear();
  const hora = String(data.getHours()).padStart(2, '0');
  const min = String(data.getMinutes()).padStart(2, '0');
  return `${dia}/${mes}/${ano} ${hora}:${min}`;
}

/**
 * Percorre recursivamente uma estrutura ASN.1 em busca do OID 2.16.76.1.3.3 (CNPJ ICP-Brasil).
 */
function extrairCnpjDeAsn1(node: forge.asn1.Asn1): string | null {
  if (!node) return null;

  if (Array.isArray(node.value)) {
    for (let i = 0; i < node.value.length; i++) {
      const child = node.value[i];
      if (
        child.type === forge.asn1.Type.OID &&
        typeof child.value === 'string'
      ) {
        const oid = forge.asn1.derToOid(child.value);
        // OID ICP-Brasil para CNPJ da Pessoa Jurídica: 2.16.76.1.3.3
        if (oid === '2.16.76.1.3.3' && i + 1 < node.value.length) {
          const valorNode = node.value[i + 1];
          const extraido = extrairTextoAsn1(valorNode);
          const digitos = extraido.replace(/\D/g, '');
          if (digitos.length === 14) {
            return digitos;
          }
        }
      }
      const resultadoFilho = extrairCnpjDeAsn1(child);
      if (resultadoFilho) return resultadoFilho;
    }
  }

  return null;
}

function extrairTextoAsn1(node: forge.asn1.Asn1): string {
  if (!node) return '';
  if (typeof node.value === 'string') {
    return node.value;
  }
  if (Array.isArray(node.value)) {
    return node.value.map(extrairTextoAsn1).join('');
  }
  return '';
}

/**
 * Lê um arquivo .pfx ou .p12 em memória com node-forge, extrai CNPJ (OID 2.16.76.1.3.3 ou CN),
 * razão social e validade. Bloqueia se a senha estiver incorreta ou se estiver vencido.
 */
export function lerCertificadoPfx(
  pfxBuffer: Buffer,
  senha: string
): DadosCertificado {
  if (!pfxBuffer || pfxBuffer.length === 0) {
    throw new Error('O arquivo do certificado digital está vazio.');
  }
  if (!senha) {
    throw new Error('Informe a senha do certificado digital.');
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const binaryStr = pfxBuffer.toString('binary');
    const p12Asn1 = forge.asn1.fromDer(binaryStr);
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);
  } catch (err: any) {
    const msg = String(err?.message || '').toLowerCase();
    if (
      msg.includes('invalid password') ||
      msg.includes('mac could not be verified') ||
      msg.includes('pkcs#12 mac')
    ) {
      throw new Error(
        'Senha do certificado digital incorreta. Verifique a senha informada e tente novamente.'
      );
    }
    throw new Error(
      'Não foi possível ler o certificado digital (.pfx/.p12). Verifique se a senha está correta e se o arquivo é válido.'
    );
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[
    forge.pki.oids.certBag
  ];

  if (!certBags || certBags.length === 0) {
    throw new Error(
      'Nenhum certificado X.509 foi encontrado dentro do arquivo .pfx/.p12.'
    );
  }

  // Seleciona o certificado do titular (aquele que possui chave privada ou que não é CA intermediária)
  const certificados = certBags
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));

  let certTitular = certificados[0];
  for (const cert of certificados) {
    const basicConstraints = cert.getExtension('basicConstraints') as any;
    if (!basicConstraints || !basicConstraints.cA) {
      certTitular = cert;
      break;
    }
  }

  // Extrai Common Name (CN) e Organization (O)
  const cnAttr = certTitular.subject.getField('CN');
  const orgAttr = certTitular.subject.getField('O');
  const serialAttr = certTitular.subject.getField('serialNumber');
  const issuerCnAttr = certTitular.issuer.getField('CN');

  const cn = cnAttr ? String(cnAttr.value).trim() : '';
  const emissor = issuerCnAttr ? String(issuerCnAttr.value).trim() : 'ICP-Brasil';

  let cnpj = '';
  let razaoSocial = cn;

  // 1. Tenta extrair do CN no formato "RAZAO SOCIAL:CNPJ"
  if (cn.includes(':')) {
    const partes = cn.split(':');
    razaoSocial = partes[0].trim();
    const possivelCnpj = partes.slice(1).join(':').replace(/\D/g, '');
    if (possivelCnpj.length === 14) {
      cnpj = possivelCnpj;
    }
  }

  // 2. Tenta extrair da extensão subjectAltName via OID 2.16.76.1.3.3
  if (!cnpj) {
    const sanExt = certTitular.getExtension('subjectAltName') as any;
    if (sanExt && sanExt.value) {
      try {
        const sanAsn1 = forge.asn1.fromDer(sanExt.value);
        const cnpjOid = extrairCnpjDeAsn1(sanAsn1);
        if (cnpjOid) {
          cnpj = cnpjOid;
        }
      } catch {
        // Ignora erro de parse ASN.1 na extensão opcional
      }
    }
  }

  // 3. Tenta extrair do serialNumber do Subject ou qualquer sequência de 14 dígitos no CN
  if (!cnpj && serialAttr) {
    const digitosSerial = String(serialAttr.value).replace(/\D/g, '');
    if (digitosSerial.length === 14) {
      cnpj = digitosSerial;
    }
  }

  if (!cnpj) {
    const match14 = cn.match(/(\d{14})/);
    if (match14) {
      cnpj = match14[1];
    }
  }

  if (!razaoSocial && orgAttr) {
    razaoSocial = String(orgAttr.value).trim();
  }

  if (!cnpj || cnpj.length !== 14) {
    throw new Error(
      'Não foi possível localizar o CNPJ de 14 dígitos no certificado digital (OID 2.16.76.1.3.3 ou CN).'
    );
  }

  const validoDe = certTitular.validity.notBefore;
  const validoAte = certTitular.validity.notAfter;
  const agora = new Date();

  const diffMs = validoAte.getTime() - agora.getTime();
  const diasRestantes = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const vencido = agora.getTime() > validoAte.getTime();

  const isCertificadoTeste = emissor.includes('Autoridade Certificadora de Homologacao Local');

  if (vencido) {
    throw new Error(
      `Certificado digital vencido em ${formatarDataBr(validoAte)}. Utilize um certificado A1 dentro da validade.`
    );
  }

  return {
    cnpj,
    cnpjFormatado: formatarCnpj(cnpj),
    razaoSocial: razaoSocial || 'Empresa Titular',
    emissor,
    validoDe: formatarDataBr(validoDe),
    validoAte: formatarDataBr(validoAte),
    validoDeIso: validoDe.toISOString(),
    validoAteIso: validoAte.toISOString(),
    diasRestantes,
    vencido,
    isCertificadoTeste,
  };
}

/**
 * Gera em memória um certificado .pfx de demonstração/teste com OID 2.16.76.1.3.3 e CN "RAZAO SOCIAL:CNPJ"
 * para permitir testes locais completos sem expor certificados reais.
 */
export function gerarCertificadoTestePfx(params?: {
  cnpj?: string;
  razaoSocial?: string;
  senha?: string;
}): { buffer: Buffer; senha: string; cnpj: string; razaoSocial: string } {
  const cnpj = (params?.cnpj || '63210993000146').replace(/\D/g, '');
  const razaoSocial = params?.razaoSocial || 'COMERCIAL BAHIA DISTRIBUIDORA LTDA';
  const senha = params?.senha || '123456';

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';

  const agora = new Date();
  cert.validity.notBefore = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(agora.getTime() + 365 * 24 * 60 * 60 * 1000);

  const attrs = [
    { name: 'commonName', value: `${razaoSocial}:${cnpj}` },
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'ICP-Brasil' },
    { name: 'organizationalUnitName', value: 'Certificado PJ A1' },
  ];

  const issuerAttrs = [
    { name: 'commonName', value: 'Autoridade Certificadora de Homologacao Local' },
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'ICP-Brasil' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(issuerAttrs);

  // Inclui SubjectAltName com OID 2.16.76.1.3.3 (CNPJ ICP-Brasil)
  const sanAsn1 = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer('2.16.76.1.3.3').getBytes()
        ),
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OCTETSTRING,
            false,
            cnpj
          ),
        ]),
      ]),
    ]
  );

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false,
    },
    {
      name: 'subjectAltName',
      value: forge.asn1.toDer(sanAsn1).getBytes(),
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, {
    algorithm: '3des',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const buffer = Buffer.from(p12Der, 'binary');

  return {
    buffer,
    senha,
    cnpj,
    razaoSocial,
  };
}
