import express, { Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import {
  lerCertificadoPfx,
  gerarCertificadoTestePfx,
  DadosCertificado,
} from '../services/certificado.ts';
import {
  parseRelatorioCsv,
  NotaCsv,
  ResultadoParseCsv,
  calcularDigitoVerificador,
} from '../services/csvParser.ts';
import {
  AmbienteSefaz,
  criarAgenteTlsSefaz,
  consultarChaveSefaz,
} from '../services/sefaz.ts';
import {
  gerarBufferZip,
  gerarNomeArquivoZip,
  ItemZipXml,
} from '../services/zip.ts';

const router = express.Router();

// Armazenamento estritamente em memória (NUNCA grava certificado, senha ou notas em disco)
const uploadCert = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB máximo para certificado
});

const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB máximo para CSV
});

const uploadLote = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

export interface TarefaDownload {
  id: string;
  criadoEm: number;
  ambiente: AmbienteSefaz;
  simularSefaz: boolean;
  intervaloMs: number;
  certificado: DadosCertificado;
  resumoCsv: ResultadoParseCsv;
  notas: NotaCsv[];
  progresso: {
    processadas: number;
    totalParaProcessar: number;
    baixadas: number;
    naoEncontradas: number;
    apenasResumo: number;
    erros: number;
    ignoradas: number;
    concluido: boolean;
    pausadoPor656: boolean;
    mensagemGeral: string;
    chaveAtual?: string;
  };
  xmlsBaixados: ItemZipXml[];
  zipBuffer?: Buffer;
  nomeArquivoZip: string;
  clientesSse: Set<Response>;
  cancelado: boolean;
}

const tarefasAtivas = new Map<string, TarefaDownload>();

// Limpeza periódica de tarefas antigas em memória (após 30 minutos)
setInterval(() => {
  const agora = Date.now();
  for (const [id, tarefa] of tarefasAtivas.entries()) {
    if (agora - tarefa.criadoEm > 30 * 60 * 1000) {
      tarefasAtivas.delete(id);
    }
  }
}, 5 * 60 * 1000);

function emitirEventoSse(tarefa: TarefaDownload, tipo: string, payload: unknown) {
  const mensagem = `event: ${tipo}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of tarefa.clientesSse) {
    try {
      res.write(mensagem);
    } catch {
      tarefa.clientesSse.delete(res);
    }
  }
}

function validarExtensaoCertificado(nomeArquivo: string): boolean {
  const lower = (nomeArquivo || '').toLowerCase();
  return lower.endsWith('.pfx') || lower.endsWith('.p12');
}

function validarExtensaoCsv(nomeArquivo: string): boolean {
  const lower = (nomeArquivo || '').toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.txt');
}

/**
 * POST /api/certificado/validar
 * Valida o arquivo .pfx/.p12 e a senha em memória e retorna CNPJ, razão social e validade.
 */
router.post(
  '/certificado/validar',
  uploadCert.single('certificado'),
  (req: Request, res: Response) => {
    const file = req.file;
    const senha = String(req.body?.senha || '');

    try {
      if (!file) {
        res.status(400).json({
          erro: 'Envie o arquivo do certificado digital (.pfx ou .p12).',
        });
        return;
      }

      if (!validarExtensaoCertificado(file.originalname)) {
        res.status(400).json({
          erro: 'Formato de arquivo inválido. Envie apenas arquivos .pfx ou .p12.',
        });
        return;
      }

      const dados = lerCertificadoPfx(file.buffer, senha);
      res.json({ certificado: dados });
    } catch (err: any) {
      res.status(400).json({
        erro: err?.message || 'Erro ao validar o certificado digital.',
      });
    } finally {
      // Limpa o buffer do certificado da memória imediatamente após a validação
      if (file?.buffer) {
        file.buffer.fill(0);
      }
    }
  }
);

/**
 * POST /api/csv/previa
 * Faz o parse do arquivo CSV em memória e retorna a prévia das notas e totalizadores.
 */
router.post(
  '/csv/previa',
  uploadCsv.single('csv'),
  (req: Request, res: Response) => {
    const file = req.file;
    const cnpjCertificado = String(req.body?.cnpjCertificado || '');

    try {
      if (!file) {
        res.status(400).json({
          erro: 'Envie o arquivo de relatório CSV.',
        });
        return;
      }

      if (!validarExtensaoCsv(file.originalname)) {
        res.status(400).json({
          erro: 'Extensão inválida. Envie um arquivo .csv separado por ponto e vírgula (;).',
        });
        return;
      }

      const resultado = parseRelatorioCsv(file.buffer, cnpjCertificado);
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({
        erro: err?.message || 'Erro ao processar o arquivo CSV.',
      });
    } finally {
      if (file?.buffer) {
        file.buffer.fill(0);
      }
    }
  }
);

/**
 * GET /api/exemplo/arquivos
 * Gera um certificado .pfx de demonstração + relatório CSV de exemplo (contendo a linha oficial da especificação)
 * para que o usuário possa testar toda a aplicação imediatamente.
 */
router.get('/exemplo/arquivos', (_req: Request, res: Response) => {
  try {
    const certDemo = gerarCertificadoTestePfx({
      cnpj: '63210993000146',
      razaoSocial: 'COMERCIAL BAHIA DISTRIBUIDORA LTDA',
      senha: '123456',
    });

    // Gera chaves válidas adicionais com DV calculado pelo Módulo 11
    const base2 = '2926106321099300014655002000000569101212627';
    const chave2 = `${base2}${calcularDigitoVerificador(base2)}`;

    const base3 = '2926106321099300014655002000000570101212628';
    const chave3 = `${base3}${calcularDigitoVerificador(base3)}`;

    const base4Cancelada = '2926106321099300014655002000000571101212629';
    const chave4Cancelada = `${base4Cancelada}${calcularDigitoVerificador(base4Cancelada)}`;

    const base5OutroCnpj = '2926101122233300018155002000000572101212630';
    const chave5OutroCnpj = `${base5OutroCnpj}${calcularDigitoVerificador(base5OutroCnpj)}`;

    const csvExemplo = [
      'Numero NF-e;CNPJ/CPF Destinatario;Razao Social Destinatario;Data de Emissao;Data de Autorizacao;Valor (R$);Chave de Acesso;UF Dest.;Situacao;Tipo Operacao;',
      " 000.000.568; 140.044.599-07; vitoria helena crul; 02/10/2026 09:51:06 ; 02/10/2026 09:53:00 ;52,50;'29261063210993000146550020000005681012126269; PR; Autorizada; Saida;",
      ` 000.000.569; 33.444.555/0001-09; METALURGICA HORIZONTE SUL LTDA; 04/10/2026 11:15:22 ; 04/10/2026 11:16:05 ;3.080,00;'${chave2}; SP; Autorizada; Saida;`,
      ` 000.000.570; 77.888.999/0001-20; SUPERMERCADO CENTRAL DO BRASIL S/A; 08/10/2026 16:40:10 ; 08/10/2026 16:41:00 ;1.420,90;'${chave3}; MG; Autorizada; Saida;`,
      ` 000.000.571; 19.283.746/0001-55; DISTRIBUIDORA ALFA COMERCIO; 09/10/2026 10:05:00 ; 09/10/2026 10:06:12 ;890,00;'${chave4Cancelada}; BA; Cancelada; Saida;`,
      ` 000.000.572; 45.678.912/0001-33; LOGISTICA INTEGRADA NORDESTE LTDA; 12/10/2026 15:22:45 ; 12/10/2026 15:23:10 ;645,00;'${chave5OutroCnpj}; PE; Autorizada; Saida;`,
    ].join('\r\n');

    res.json({
      certificadoBase64: certDemo.buffer.toString('base64'),
      nomeArquivoCertificado: 'certificado_a1_demonstracao.pfx',
      senhaCertificado: certDemo.senha,
      csvConteudo: csvExemplo,
      nomeArquivoCsv: 'relatorio_nfe_emitidas.csv',
    });
  } catch (err: any) {
    res.status(500).json({
      erro: err?.message || 'Erro ao gerar arquivos de demonstração.',
    });
  }
});

/**
 * POST /api/lote/iniciar
 * Recebe o certificado (.pfx/.p12), senha, arquivo CSV, ambiente ('1' ou '2') e intervalo,
 * valida tudo em memória e inicia o processamento sequencial das chaves junto à SEFAZ.
 */
router.post(
  '/lote/iniciar',
  uploadLote.fields([
    { name: 'certificado', maxCount: 1 },
    { name: 'csv', maxCount: 1 },
  ]),
  (req: Request, res: Response) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const certFile = files?.certificado?.[0];
    const csvFile = files?.csv?.[0];

    const senha = String(req.body?.senha || '');
    const ambiente: AmbienteSefaz = req.body?.ambiente === '2' ? '2' : '1';
    const intervaloSegundos = Math.max(
      1,
      Math.min(15, Number(req.body?.intervaloSegundos || 2))
    );
    const simularSefaz = req.body?.simularSefaz === 'true';

    if (!certFile || !csvFile) {
      res.status(400).json({
        erro: 'É obrigatório enviar o certificado digital (.pfx/.p12) e o arquivo CSV.',
      });
      return;
    }

    if (certFile.size > 5 * 1024 * 1024) {
      res.status(400).json({
        erro: 'O certificado digital excede o limite máximo de 5 MB.',
      });
      return;
    }

    if (csvFile.size > 10 * 1024 * 1024) {
      res.status(400).json({
        erro: 'O arquivo CSV excede o limite máximo de 10 MB.',
      });
      return;
    }

    try {
      const dadosCert = lerCertificadoPfx(certFile.buffer, senha);
      const resultadoCsv = parseRelatorioCsv(csvFile.buffer, dadosCert.cnpj);

      // Copia o buffer do PFX apenas para criar o https.Agent em memória
      const pfxCopiaMemoria = Buffer.from(certFile.buffer);
      certFile.buffer.fill(0);
      csvFile.buffer.fill(0);

      const jobId = crypto.randomUUID();
      const nomeArquivoZip = gerarNomeArquivoZip(
        dadosCert.cnpj,
        resultadoCsv.dataMaisAntiga,
        resultadoCsv.dataMaisRecente
      );

      const tarefa: TarefaDownload = {
        id: jobId,
        criadoEm: Date.now(),
        ambiente,
        simularSefaz: simularSefaz || Boolean(dadosCert.isCertificadoTeste),
        intervaloMs: intervaloSegundos * 1000,
        certificado: dadosCert,
        resumoCsv: resultadoCsv,
        notas: resultadoCsv.notas,
        progresso: {
          processadas: 0,
          totalParaProcessar: resultadoCsv.totalAutorizadas,
          baixadas: 0,
          naoEncontradas: 0,
          apenasResumo: 0,
          erros: resultadoCsv.notas.filter((n) => n.status === 'erro').length,
          ignoradas: resultadoCsv.notas.filter((n) => n.status === 'ignorada').length,
          concluido: false,
          pausadoPor656: false,
          mensagemGeral: 'Iniciando comunicação TLS mútua com a SEFAZ...',
        },
        xmlsBaixados: [],
        nomeArquivoZip,
        clientesSse: new Set(),
        cancelado: false,
      };

      tarefasAtivas.set(jobId, tarefa);

      // Dispara o processamento assíncrono em memória
      processarLoteEmMemoria(tarefa, pfxCopiaMemoria, senha).catch(() => {
        // Garantir descarte seguro em caso de exceção inesperada
        pfxCopiaMemoria.fill(0);
      });

      res.json({
        jobId,
        nomeArquivoZip,
        simularSefazAtivo: tarefa.simularSefaz,
        progresso: tarefa.progresso,
        notas: tarefa.notas,
      });
    } catch (err: any) {
      if (certFile?.buffer) certFile.buffer.fill(0);
      if (csvFile?.buffer) csvFile.buffer.fill(0);
      res.status(400).json({
        erro: err?.message || 'Não foi possível iniciar o processamento do lote.',
      });
    }
  }
);

async function processarLoteEmMemoria(
  tarefa: TarefaDownload,
  pfxBuffer: Buffer,
  senha: string
): Promise<void> {
  const agent = criarAgenteTlsSefaz(pfxBuffer, senha);

  try {
    const notasParaConsultar = tarefa.notas.filter((n) => n.processar);

    for (let i = 0; i < notasParaConsultar.length; i++) {
      if (tarefa.cancelado) break;

      const nota = notasParaConsultar[i];
      nota.status = 'processando';
      nota.mensagemSefaz = 'Consultando NFeDistribuicaoDFe na SEFAZ...';
      tarefa.progresso.chaveAtual = nota.chave;
      tarefa.progresso.mensagemGeral = `Consultando NF-e ${nota.numero} (${i + 1} de ${
        notasParaConsultar.length
      })...`;

      emitirEventoSse(tarefa, 'progresso', {
        progresso: tarefa.progresso,
        notaAtualizada: nota,
      });

      const resultado = await consultarChaveSefaz({
        chave: nota.chave,
        cnpjCertificado: tarefa.certificado.cnpj,
        cUFAutor: nota.cUF || '29',
        tpAmb: tarefa.ambiente,
        agent,
        timeoutMs: 30000,
        maxTentativas: 3, // Até 2 novas tentativas em caso de erro de rede
        simularSefaz: tarefa.simularSefaz,
        dadosNotaSimulacao: {
          numero: nota.numero,
          destinatario: nota.razaoSocialDestinatario,
          cnpjCpfDest: nota.cnpjCpfDestinatario,
          valor: nota.valor,
          dataEmissao: nota.dataEmissao,
          ufDest: nota.ufDest,
        },
      });

      // Tratamento especial para cStat 656 (Consumo Indevido): pausa o lote imediatamente
      if (resultado.status === 'consumo_indevido' || resultado.cStat === '656') {
        nota.status = 'erro';
        nota.mensagemSefaz = `656 - ${resultado.xMotivo} (Lote interrompido para evitar bloqueio)`;
        tarefa.progresso.erros++;
        tarefa.progresso.pausadoPor656 = true;
        tarefa.progresso.mensagemGeral =
          'Alerta SEFAZ (cStat 656 - Consumo Indevido): O lote foi pausado automaticamente. Aguarde cerca de 1 hora antes de tentar consultar novamente.';

        emitirEventoSse(tarefa, 'progresso', {
          progresso: tarefa.progresso,
          notaAtualizada: nota,
        });
        break;
      }

      if (resultado.status === 'baixado' && resultado.xmlProcNFe) {
        nota.status = 'baixado';
        nota.mensagemSefaz = resultado.xMotivo || '138 - Documento localizado (procNFe)';
        tarefa.progresso.baixadas++;
        tarefa.xmlsBaixados.push({
          chave: nota.chave,
          xml: resultado.xmlProcNFe,
        });
      } else if (resultado.status === 'apenas_resumo') {
        nota.status = 'apenas_resumo';
        nota.mensagemSefaz = resultado.xMotivo;
        tarefa.progresso.apenasResumo++;
      } else if (resultado.status === 'nao_encontrado') {
        nota.status = 'nao_encontrado';
        nota.mensagemSefaz = `137 - ${resultado.xMotivo}`;
        tarefa.progresso.naoEncontradas++;
      } else {
        nota.status = 'erro';
        nota.mensagemSefaz = resultado.xMotivo;
        tarefa.progresso.erros++;
      }

      tarefa.progresso.processadas++;

      emitirEventoSse(tarefa, 'progresso', {
        progresso: tarefa.progresso,
        notaAtualizada: nota,
      });

      // Aguarda o intervalo configurável entre consultas (padrão 2 segundos), exceto após a última nota
      if (i < notasParaConsultar.length - 1 && !tarefa.cancelado) {
        await new Promise((r) => setTimeout(r, tarefa.intervaloMs));
      }
    }

    // Gera o arquivo .zip em memória ao final do processamento
    tarefa.zipBuffer = await gerarBufferZip(tarefa.xmlsBaixados, tarefa.notas);
    tarefa.progresso.concluido = true;
    tarefa.progresso.chaveAtual = undefined;

    if (!tarefa.progresso.pausadoPor656) {
      tarefa.progresso.mensagemGeral = `Processamento concluído: ${tarefa.progresso.baixadas} XML(s) completo(s) baixado(s). Arquivo ZIP pronto.`;
    }

    emitirEventoSse(tarefa, 'concluido', {
      progresso: tarefa.progresso,
      nomeArquivoZip: tarefa.nomeArquivoZip,
    });
  } finally {
    // Descarta de forma segura o certificado e destrói conexões TLS abertas
    pfxBuffer.fill(0);
    agent.destroy();
  }
}

/**
 * GET /api/lote/:jobId/eventos
 * Stream de Server-Sent Events (SSE) com o progresso em tempo real de cada nota.
 */
router.get('/lote/:jobId/eventos', (req: Request, res: Response) => {
  const tarefa = tarefasAtivas.get(String(req.params.jobId));
  if (!tarefa) {
    res.status(404).json({ erro: 'Tarefa de download não encontrada ou expirada.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Envia o estado inicial imediatamente
  res.write(
    `event: estado_inicial\ndata: ${JSON.stringify({
      progresso: tarefa.progresso,
      notas: tarefa.notas,
      nomeArquivoZip: tarefa.nomeArquivoZip,
    })}\n\n`
  );

  tarefa.clientesSse.add(res);

  req.on('close', () => {
    tarefa.clientesSse.delete(res);
  });
});

/**
 * GET /api/lote/:jobId/status
 * Endpoint de polling como fallback caso SSE sofra buffering.
 */
router.get('/lote/:jobId/status', (req: Request, res: Response) => {
  const tarefa = tarefasAtivas.get(String(req.params.jobId));
  if (!tarefa) {
    res.status(404).json({ erro: 'Tarefa não encontrada.' });
    return;
  }

  res.json({
    progresso: tarefa.progresso,
    notas: tarefa.notas,
    nomeArquivoZip: tarefa.nomeArquivoZip,
  });
});

/**
 * GET /api/lote/:jobId/download
 * Devolve o arquivo .zip gerado em memória contendo os XMLs ({chave}-procNFe.xml) e o relatorio.csv.
 */
router.get('/lote/:jobId/download', (req: Request, res: Response) => {
  const tarefa = tarefasAtivas.get(String(req.params.jobId));
  if (!tarefa || !tarefa.zipBuffer) {
    res.status(404).json({
      erro: 'Arquivo ZIP ainda não está disponível ou a sessão expirou.',
    });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${tarefa.nomeArquivoZip}"`
  );
  res.setHeader('Content-Length', tarefa.zipBuffer.length);
  res.send(tarefa.zipBuffer);
});

export default router;
