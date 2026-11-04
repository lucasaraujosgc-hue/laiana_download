import iconv from 'iconv-lite';

export type StatusNota =
  | 'aguardando'
  | 'processando'
  | 'baixado'
  | 'nao_encontrado'
  | 'apenas_resumo'
  | 'erro'
  | 'ignorada';

export interface NotaCsv {
  id: string;
  linha: number;
  numero: string;
  cnpjCpfDestinatario: string;
  razaoSocialDestinatario: string;
  dataEmissao: string;
  dataEmissaoIso: string; // YYYY-MM-DD
  dataAutorizacao: string;
  valorTexto: string;
  valor: number;
  chaveOriginal: string;
  chave: string;
  ufDest: string;
  situacao: string;
  tipoOperacao: string;
  cUF: string;
  cnpjEmitente: string;
  chaveValida: boolean;
  erroValidacao?: string;
  cnpjDivergente?: boolean;
  avisoCnpj?: string;
  processar: boolean;
  status: StatusNota;
  mensagemSefaz: string;
}

export interface ResultadoParseCsv {
  notas: NotaCsv[];
  totalNotas: number;
  totalAutorizadas: number;
  totalIgnoradas: number;
  totalDuplicadasRemovidas: number;
  valorTotal: number;
  valorTotalAutorizadas: number;
  dataMaisAntiga: string;
  dataMaisRecente: string;
}

/**
 * Calcula o dígito verificador (Módulo 11) dos 43 primeiros dígitos de uma chave de acesso NF-e.
 */
export function calcularDigitoVerificador(chave43: string): number {
  const limpo = chave43.replace(/\D/g, '');
  if (limpo.length !== 43) {
    throw new Error('A base da chave deve conter exatamente 43 dígitos numéricos.');
  }

  let soma = 0;
  let peso = 2;

  for (let i = 42; i >= 0; i--) {
    const digito = parseInt(limpo.charAt(i), 10);
    soma += digito * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  return resto === 0 || resto === 1 ? 0 : 11 - resto;
}

/**
 * Valida se uma chave de acesso NF-e possui 44 dígitos numéricos e se o dígito verificador (Módulo 11) é válido.
 */
export function validarChaveAcesso(chave: string): {
  valida: boolean;
  chaveLimpa: string;
  motivo?: string;
} {
  const chaveLimpa = chave.replace(/^'+/, '').replace(/\D/g, '');

  if (chaveLimpa.length !== 44) {
    return {
      valida: false,
      chaveLimpa,
      motivo: `Chave com tamanho inválido (${chaveLimpa.length} dígitos; esperado 44).`,
    };
  }

  const base43 = chaveLimpa.substring(0, 43);
  const dvInformado = parseInt(chaveLimpa.charAt(43), 10);
  const dvCalculado = calcularDigitoVerificador(base43);

  if (dvInformado !== dvCalculado) {
    return {
      valida: false,
      chaveLimpa,
      motivo: `Dígito verificador inválido (informado ${dvInformado}, esperado ${dvCalculado}).`,
    };
  }

  return {
    valida: true,
    chaveLimpa,
  };
}

/**
 * Converte valor monetário no formato brasileiro (ex: "3.080,00" ou "52,50") para número float.
 */
export function parseValorBrasileiro(valorStr: string): number {
  const limpo = valorStr.trim().replace(/R\$\s*/gi, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(limpo);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Extrai a data no formato YYYY-MM-DD a partir de "dd/mm/aaaa hh:mm:ss" ou "dd/mm/aaaa".
 */
export function extrairDataIso(dataBr: string): string {
  const match = dataBr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return '';
  const [, dia, mes, ano] = match;
  return `${ano}-${mes}-${dia}`;
}

/**
 * Faz o parse de uma única linha de dados do relatório CSV.
 */
export function parseLinhaCsv(linhaBruta: string, numeroLinha = 1, cnpjCertificado?: string): NotaCsv | null {
  const linhaTrim = linhaBruta.trim();
  if (!linhaTrim) return null;

  // Divide por ponto e vírgula e aplica trim em todos os campos
  const partes = linhaBruta.split(';').map((c) => c.trim());

  // Cada linha termina com ";" (coluna vazia extra no final — ignorar se houver >= 10 colunas)
  if (partes.length > 10 && partes[partes.length - 1] === '') {
    partes.pop();
  }

  // Ignora linha de cabeçalho caso seja passada
  const primeiroCampoLower = (partes[0] || '').toLowerCase();
  if (
    primeiroCampoLower.includes('numero nf-e') ||
    primeiroCampoLower.includes('número nf-e') ||
    (partes[6] || '').toLowerCase().includes('chave de acesso')
  ) {
    return null;
  }

  if (partes.length < 10) {
    throw new Error(
      `Linha ${numeroLinha} fora do formato esperado (encontradas ${partes.length} colunas; esperado 10 colunas separadas por ';').`
    );
  }

  const [
    numero,
    cnpjCpfDestinatario,
    razaoSocialDestinatario,
    dataEmissao,
    dataAutorizacao,
    valorTexto,
    chaveOriginal,
    ufDest,
    situacao,
    tipoOperacao,
  ] = partes;

  const validacaoChave = validarChaveAcesso(chaveOriginal);
  const chave = validacaoChave.chaveLimpa;
  const valor = parseValorBrasileiro(valorTexto);
  const dataEmissaoIso = extrairDataIso(dataEmissao);

  const cUF = chave.length >= 2 ? chave.substring(0, 2) : '';
  const cnpjEmitente = chave.length >= 20 ? chave.substring(6, 20) : '';

  const isAutorizada = situacao.toLowerCase() === 'autorizada';

  let cnpjDivergente = false;
  let avisoCnpj: string | undefined;
  const cnpjCertLimpo = cnpjCertificado ? cnpjCertificado.replace(/\D/g, '') : '';
  if (cnpjCertLimpo && cnpjEmitente && cnpjCertLimpo !== cnpjEmitente) {
    cnpjDivergente = true;
    avisoCnpj = `CNPJ do emitente na chave (${cnpjEmitente}) difere do CNPJ do certificado (${cnpjCertLimpo}).`;
  }

  let processar = false;
  let status: StatusNota = 'aguardando';
  let mensagemSefaz = 'Aguardando consulta na SEFAZ';

  if (!validacaoChave.valida) {
    processar = false;
    status = 'erro';
    mensagemSefaz = validacaoChave.motivo || 'Chave de acesso inválida';
  } else if (!isAutorizada) {
    processar = false;
    status = 'ignorada';
    mensagemSefaz = `Ignorada (Situação: ${situacao || 'Não informada'})`;
  } else {
    processar = true;
    status = 'aguardando';
    mensagemSefaz = avisoCnpj ? `Aguardando (${avisoCnpj})` : 'Aguardando consulta';
  }

  return {
    id: `${chave || numeroLinha}-${numeroLinha}`,
    linha: numeroLinha,
    numero,
    cnpjCpfDestinatario,
    razaoSocialDestinatario,
    dataEmissao,
    dataEmissaoIso,
    dataAutorizacao,
    valorTexto,
    valor,
    chaveOriginal,
    chave,
    ufDest,
    situacao,
    tipoOperacao,
    cUF,
    cnpjEmitente,
    chaveValida: validacaoChave.valida,
    erroValidacao: validacaoChave.motivo,
    cnpjDivergente,
    avisoCnpj,
    processar,
    status,
    mensagemSefaz,
  };
}

/**
 * Decodifica o buffer do CSV em UTF-8, usando fallback para Windows-1252 (Latin-1) caso haja caracteres inválidos.
 */
export function decodificarBufferCsv(buffer: Buffer): string {
  // Remove BOM UTF-8 se presente
  let textoUtf8 = buffer.toString('utf8');
  if (textoUtf8.charCodeAt(0) === 0xfeff) {
    textoUtf8 = textoUtf8.slice(1);
  }

  // Se contiver o caractere de substituição Unicode (\uFFFD), faz fallback para Windows-1252 / Latin-1
  if (textoUtf8.includes('\uFFFD')) {
    return iconv.decode(buffer, 'win1252');
  }

  return textoUtf8;
}

/**
 * Faz o parse completo do arquivo CSV (Buffer ou string), removendo duplicatas e linhas vazias.
 */
export function parseRelatorioCsv(
  input: Buffer | string,
  cnpjCertificado?: string
): ResultadoParseCsv {
  const conteudo = Buffer.isBuffer(input) ? decodificarBufferCsv(input) : input;
  const linhas = conteudo.split(/\r?\n/);

  const notas: NotaCsv[] = [];
  const chavesVistas = new Set<string>();
  let totalDuplicadasRemovidas = 0;

  for (let i = 0; i < linhas.length; i++) {
    const linhaBruta = linhas[i];
    if (!linhaBruta || !linhaBruta.trim()) {
      continue;
    }

    const nota = parseLinhaCsv(linhaBruta, i + 1, cnpjCertificado);
    if (!nota) {
      continue; // Cabeçalho ou linha vazia
    }

    // Remove chaves duplicadas
    if (nota.chave && chavesVistas.has(nota.chave)) {
      totalDuplicadasRemovidas++;
      continue;
    }

    if (nota.chave) {
      chavesVistas.add(nota.chave);
    }

    notas.push(nota);
  }

  if (notas.length === 0) {
    throw new Error(
      'Nenhuma nota fiscal encontrada no arquivo CSV. Verifique se o separador é ponto e vírgula (;) e se o arquivo segue o padrão esperado.'
    );
  }

  const datasIso = notas
    .map((n) => n.dataEmissaoIso)
    .filter((d) => d.length === 10)
    .sort();

  const hojeIso = new Date().toISOString().slice(0, 10);
  const dataMaisAntiga = datasIso.length > 0 ? datasIso[0] : hojeIso;
  const dataMaisRecente = datasIso.length > 0 ? datasIso[datasIso.length - 1] : hojeIso;

  const notasAutorizadas = notas.filter((n) => n.processar);
  const notasIgnoradas = notas.filter((n) => !n.processar);

  const valorTotal = notas.reduce((acc, n) => acc + n.valor, 0);
  const valorTotalAutorizadas = notasAutorizadas.reduce((acc, n) => acc + n.valor, 0);

  return {
    notas,
    totalNotas: notas.length,
    totalAutorizadas: notasAutorizadas.length,
    totalIgnoradas: notasIgnoradas.length,
    totalDuplicadasRemovidas,
    valorTotal: Number(valorTotal.toFixed(2)),
    valorTotalAutorizadas: Number(valorTotalAutorizadas.toFixed(2)),
    dataMaisAntiga,
    dataMaisRecente,
  };
}
