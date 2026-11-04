import * as archiverModule from 'archiver';
import { PassThrough } from 'stream';
import { NotaCsv, StatusNota } from './csvParser.ts';

const criarArchiver = ((archiverModule as any).default ||
  archiverModule) as (
  format: 'zip',
  options?: archiverModule.ArchiverOptions
) => archiverModule.Archiver;

export interface ItemZipXml {
  chave: string;
  xml: string;
}

function traduzirStatusRelatorio(status: StatusNota): string {
  switch (status) {
    case 'baixado':
      return 'baixado';
    case 'nao_encontrado':
      return 'não encontrado';
    case 'apenas_resumo':
      return 'apenas resumo';
    case 'ignorada':
      return 'ignorada';
    case 'erro':
    default:
      return 'erro';
  }
}

function formatarValorCsv(valor: number): string {
  return valor.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escaparCampoCsv(texto: string): string {
  return (texto || '').replace(/;/g, ',').replace(/\r?\n/g, ' ').trim();
}

/**
 * Gera o conteúdo do arquivo relatorio.csv (separado por ;) para ser incluído no .zip.
 */
export function gerarRelatorioCsvFinal(notas: NotaCsv[]): string {
  const cabecalho = 'Numero;Chave;Destinatario;Valor;Status;Mensagem SEFAZ';
  const linhas = notas.map((n) => {
    const statusLabel = traduzirStatusRelatorio(n.status);
    const msg = n.avisoCnpj
      ? `${n.mensagemSefaz} [${n.avisoCnpj}]`
      : n.mensagemSefaz;

    return [
      escaparCampoCsv(n.numero),
      escaparCampoCsv(n.chave || n.chaveOriginal),
      escaparCampoCsv(n.razaoSocialDestinatario),
      formatarValorCsv(n.valor),
      statusLabel,
      escaparCampoCsv(msg),
    ].join(';');
  });

  // Adiciona BOM UTF-8 (\uFEFF) para abertura correta de acentos no Excel
  return '\uFEFF' + [cabecalho, ...linhas].join('\r\n') + '\r\n';
}

/**
 * Monta o nome padronizado do arquivo ZIP:
 * XML_NFe_{CNPJ}_{data-mais-antiga}_a_{data-mais-recente}.zip
 */
export function gerarNomeArquivoZip(
  cnpj: string,
  dataMaisAntiga: string,
  dataMaisRecente: string
): string {
  const cnpjLimpo = cnpj.replace(/\D/g, '') || '00000000000000';
  const dAntiga = dataMaisAntiga || new Date().toISOString().slice(0, 10);
  const dRecente = dataMaisRecente || new Date().toISOString().slice(0, 10);
  return `XML_NFe_${cnpjLimpo}_${dAntiga}_a_${dRecente}.zip`;
}

/**
 * Gera o arquivo .zip em memória contendo todos os XMLs {chave}-procNFe.xml e o relatorio.csv.
 */
export async function gerarBufferZip(
  xmls: ItemZipXml[],
  notas: NotaCsv[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = criarArchiver('zip', {
      zlib: { level: 9 },
    });

    const passThrough = new PassThrough();
    const chunks: Buffer[] = [];

    passThrough.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    passThrough.on('end', () => resolve(Buffer.concat(chunks)));
    passThrough.on('error', (err: Error) => reject(err));
    archive.on('error', (err: Error) => reject(err));

    archive.pipe(passThrough);

    // Adiciona cada XML completo com o nome {chave}-procNFe.xml
    for (const item of xmls) {
      if (item.chave && item.xml) {
        archive.append(Buffer.from(item.xml, 'utf8'), {
          name: `${item.chave}-procNFe.xml`,
        });
      }
    }

    // Adiciona o relatorio.csv na raiz do zip
    const relatorioCsv = gerarRelatorioCsvFinal(notas);
    archive.append(Buffer.from(relatorioCsv, 'utf8'), {
      name: 'relatorio.csv',
    });

    archive.finalize();
  });
}
