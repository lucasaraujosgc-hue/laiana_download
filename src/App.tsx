import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  FileSpreadsheet,
  KeyRound,
  Download,
  Play,
  Pause,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  FileArchive,
  Eye,
  EyeOff,
  Search,
  RefreshCw,
  Info,
  FileCode2,
} from 'lucide-react';

type StatusNota =
  | 'aguardando'
  | 'processando'
  | 'baixado'
  | 'nao_encontrado'
  | 'apenas_resumo'
  | 'erro'
  | 'ignorada';

interface DadosCertificado {
  cnpj: string;
  cnpjFormatado: string;
  razaoSocial: string;
  emissor: string;
  validoDe: string;
  validoAte: string;
  diasRestantes: number;
  vencido: boolean;
  isCertificadoTeste?: boolean;
}

interface NotaCsv {
  id: string;
  linha: number;
  numero: string;
  cnpjCpfDestinatario: string;
  razaoSocialDestinatario: string;
  dataEmissao: string;
  dataEmissaoIso: string;
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

interface ResultadoParseCsv {
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

interface ProgressoLote {
  processadas: number;
  totalParaProcessar: number;
  baixadas: number;
  naoEncontradas: number;
  apenasResumo: number;
  erros: number;
  ignoradas: number;
  concluido: boolean;
  pausado: boolean;
  pausadoPor656: boolean;
  mensagemGeral: string;
  chaveAtual?: string;
}

type FiltroTabela = 'todas' | 'autorizadas' | 'baixadas' | 'ignoradas' | 'erros';

function formatarMoeda(valor: number): string {
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatarChaveAgrupada(chave: string): string {
  if (!chave) return '—';
  return chave.replace(/(\d{4})(?=\d)/g, '$1 ');
}

export default function App() {
  // Estado do Certificado A1
  const [arquivoCertificado, setArquivoCertificado] = useState<File | null>(null);
  const [senhaCertificado, setSenhaCertificado] = useState<string>('');
  const [mostrarSenha, setMostrarSenha] = useState<boolean>(false);
  const [validandoCert, setValidandoCert] = useState<boolean>(false);
  const [dadosCertificado, setDadosCertificado] = useState<DadosCertificado | null>(null);
  const [erroCertificado, setErroCertificado] = useState<string | null>(null);

  // Estado do Relatório CSV
  const [arquivoCsv, setArquivoCsv] = useState<File | null>(null);
  const [carregandoCsv, setCarregandoCsv] = useState<boolean>(false);
  const [resumoCsv, setResumoCsv] = useState<ResultadoParseCsv | null>(null);
  const [notas, setNotas] = useState<NotaCsv[]>([]);
  const [erroCsv, setErroCsv] = useState<string | null>(null);

  // Configurações de Consulta SEFAZ
  const [ambiente, setAmbiente] = useState<'1' | '2'>('1'); // 1 = Produção (padrão), 2 = Homologação
  const [intervaloSegundos, setIntervaloSegundos] = useState<number>(2);
  const [simularSefaz, setSimularSefaz] = useState<boolean>(false);
  const [versaoApp, setVersaoApp] = useState<string>('');
  useEffect(() => {
    fetch('/api/versao').then((r) => r.json()).then((d) => setVersaoApp(d.versao || '')).catch(() => {});
  }, []);

  // Estado de Execução do Lote e SSE
  const [processandoLote, setProcessandoLote] = useState<boolean>(false);
  const [pausando, setPausando] = useState<boolean>(false);
  const [retomando, setRetomando] = useState<boolean>(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [nomeArquivoZip, setNomeArquivoZip] = useState<string>('');
  const [progresso, setProgresso] = useState<ProgressoLote | null>(null);
  const [erroGeral, setErroGeral] = useState<string | null>(null);

  // Filtros da Tabela
  const [filtroStatus, setFiltroStatus] = useState<FiltroTabela>('todas');
  const [buscaTexto, setBuscaTexto] = useState<string>('');

  const certInputRef = useRef<HTMLInputElement | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Valida o certificado automaticamente quando arquivo e senha estão preenchidos
  const validarCertificadoNoBackend = async (file: File, senha: string) => {
    if (!file || !senha) return;
    setValidandoCert(true);
    setErroCertificado(null);

    try {
      const formData = new FormData();
      formData.append('certificado', file);
      formData.append('senha', senha);

      const resp = await fetch('/api/certificado/validar', {
        method: 'POST',
        body: formData,
      });

      const data = await resp.json();
      if (!resp.ok) {
        setDadosCertificado(null);
        setErroCertificado(data.erro || 'Não foi possível validar o certificado.');
        return;
      }

      setDadosCertificado(data.certificado);
      setSimularSefaz(Boolean(data.certificado?.isCertificadoTeste));

      if (arquivoCsv) {
        await carregarPreviaCsv(arquivoCsv, data.certificado.cnpj);
      }
    } catch {
      setDadosCertificado(null);
      setErroCertificado('Erro de comunicação ao validar o certificado no servidor.');
    } finally {
      setValidandoCert(false);
    }
  };

  const carregarPreviaCsv = async (file: File, cnpjCert?: string) => {
    setCarregandoCsv(true);
    setErroCsv(null);

    try {
      const formData = new FormData();
      formData.append('csv', file);
      const cnpjParaComparar = cnpjCert ?? dadosCertificado?.cnpj ?? '';
      if (cnpjParaComparar) {
        formData.append('cnpjCertificado', cnpjParaComparar);
      }

      const resp = await fetch('/api/csv/previa', {
        method: 'POST',
        body: formData,
      });

      const data = await resp.json();
      if (!resp.ok) {
        setResumoCsv(null);
        setNotas([]);
        setErroCsv(data.erro || 'Erro ao ler o arquivo CSV.');
        return;
      }

      setResumoCsv(data);
      setNotas(data.notas || []);
      setProgresso(null);
      setJobId(null);
    } catch {
      setResumoCsv(null);
      setNotas([]);
      setErroCsv('Falha ao enviar o arquivo CSV para leitura.');
    } finally {
      setCarregandoCsv(false);
    }
  };

  const handleSelecionarCertificado = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setArquivoCertificado(file);
    setDadosCertificado(null);
    setErroCertificado(null);
    if (file && senhaCertificado) {
      validarCertificadoNoBackend(file, senhaCertificado);
    }
  };

  const handleSelecionarCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setArquivoCsv(file);
    if (file) {
      carregarPreviaCsv(file);
    } else {
      setResumoCsv(null);
      setNotas([]);
    }
  };

  const carregarDadosExemplo = async () => {
    setErroGeral(null);
    setErroCertificado(null);
    setErroCsv(null);

    try {
      const resp = await fetch('/api/exemplo/arquivos');
      const data = await resp.json();
      if (!resp.ok) {
        setErroGeral(data.erro || 'Erro ao carregar arquivos de exemplo.');
        return;
      }

      const binStr = atob(data.certificadoBase64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      const pfxFile = new File([bytes], data.nomeArquivoCertificado, {
        type: 'application/x-pkcs12',
      });

      const csvFile = new File([data.csvConteudo], data.nomeArquivoCsv, {
        type: 'text/csv;charset=utf-8',
      });

      setArquivoCertificado(pfxFile);
      setSenhaCertificado(data.senhaCertificado);
      setArquivoCsv(csvFile);
      setSimularSefaz(true);

      await validarCertificadoNoBackend(pfxFile, data.senhaCertificado);
      await carregarPreviaCsv(csvFile, '63210993000146');
    } catch {
      setErroGeral('Não foi possível gerar os arquivos de demonstração.');
    }
  };

  const iniciarDownloadXmls = async () => {
    if (!arquivoCertificado || !senhaCertificado || !arquivoCsv) {
      setErroGeral('Envie o certificado digital (.pfx/.p12), informe a senha e carregue o relatório CSV.');
      return;
    }

    if (erroCertificado || (dadosCertificado && dadosCertificado.vencido)) {
      setErroGeral('Corrija o problema do certificado digital antes de iniciar a consulta.');
      return;
    }

    setErroGeral(null);
    setProcessandoLote(true);

    try {
      const formData = new FormData();
      formData.append('certificado', arquivoCertificado);
      formData.append('senha', senhaCertificado);
      formData.append('csv', arquivoCsv);
      formData.append('ambiente', ambiente);
      formData.append('intervaloSegundos', String(intervaloSegundos));
      formData.append('simularSefaz', String(simularSefaz));

      const resp = await fetch('/api/lote/iniciar', {
        method: 'POST',
        body: formData,
      });

      const data = await resp.json();
      if (!resp.ok) {
        setProcessandoLote(false);
        setErroGeral(data.erro || 'Erro ao iniciar o lote de consultas na SEFAZ.');
        return;
      }

      setJobId(data.jobId);
      setNomeArquivoZip(data.nomeArquivoZip);
      setProgresso(data.progresso);
      if (data.notas) {
        setNotas(data.notas);
      }

      conectarStreamEventos(data.jobId);
    } catch {
      setProcessandoLote(false);
      setErroGeral('Erro de comunicação ao iniciar o lote no servidor.');
    }
  };

  const pausarDownload = async () => {
    if (!jobId || pausando) return;
    setPausando(true);
    try {
      const resp = await fetch(`/api/lote/${jobId}/pausar`, { method: 'POST' });
      const data = await resp.json();
      if (data.progresso) {
        setProgresso(data.progresso);
      }
      setProcessandoLote(false);
    } catch {
      setErroGeral('Não foi possível pausar o download no servidor.');
    } finally {
      setPausando(false);
    }
  };

  const retornarDeOndeParou = async () => {
    if (!jobId || retomando) return;
    setRetomando(true);
    setProcessandoLote(true);
    try {
      const resp = await fetch(`/api/lote/${jobId}/retomar`, { method: 'POST' });
      const data = await resp.json();
      if (data.progresso) {
        setProgresso(data.progresso);
      }
      conectarStreamEventos(jobId);
    } catch {
      setProcessandoLote(false);
      setErroGeral('Não foi possível retomar o download no servidor.');
    } finally {
      setRetomando(false);
    }
  };

  const baixarZipParaComputador = () => {
    if (!jobId) return;
    const url = `/api/lote/${jobId}/download`;
    const link = document.createElement('a');
    link.href = url;
    link.download = nomeArquivoZip || 'XML_NFe.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const conectarStreamEventos = (idTarefa: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/lote/${idTarefa}/eventos`);
    eventSourceRef.current = es;

    es.addEventListener('estado_inicial', (ev: MessageEvent) => {
      const payload = JSON.parse(ev.data);
      setProgresso(payload.progresso);
      if (payload.notas) setNotas(payload.notas);
      if (payload.nomeArquivoZip) setNomeArquivoZip(payload.nomeArquivoZip);
      if (payload.progresso?.pausado || payload.progresso?.concluido) {
        setProcessandoLote(false);
      }
    });

    es.addEventListener('progresso', (ev: MessageEvent) => {
      const payload = JSON.parse(ev.data);
      setProgresso(payload.progresso);
      if (payload.notaAtualizada) {
        setNotas((prev) =>
          prev.map((n) => (n.id === payload.notaAtualizada.id ? payload.notaAtualizada : n))
        );
      }
      if (payload.progresso?.pausado) {
        setProcessandoLote(false);
      }
    });

    es.addEventListener('concluido', (ev: MessageEvent) => {
      const payload = JSON.parse(ev.data);
      setProgresso(payload.progresso);
      if (payload.nomeArquivoZip) setNomeArquivoZip(payload.nomeArquivoZip);
      setProcessandoLote(false);
      es.close();
    });

    es.onerror = () => {
      es.close();
    };
  };

  useEffect(() => {
    if (!processandoLote || !jobId) return;
    const timer = setInterval(async () => {
      try {
        const resp = await fetch(`/api/lote/${jobId}/status`);
        if (!resp.ok) return;
        const data = await resp.json();
        setProgresso(data.progresso);
        if (data.notas) setNotas(data.notas);
        if (data.progresso?.concluido || data.progresso?.pausado) {
          setProcessandoLote(false);
        }
      } catch {
        // Ignora falha transitória
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [processandoLote, jobId]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const notasFiltradas = useMemo(() => {
    return notas.filter((n) => {
      if (filtroStatus === 'autorizadas' && !n.processar) return false;
      if (filtroStatus === 'baixadas' && n.status !== 'baixado') return false;
      if (filtroStatus === 'ignoradas' && n.status !== 'ignorada') return false;
      if (
        filtroStatus === 'erros' &&
        n.status !== 'erro' &&
        n.status !== 'nao_encontrado' &&
        n.status !== 'apenas_resumo' &&
        !n.cnpjDivergente
      ) {
        return false;
      }

      if (buscaTexto.trim()) {
        const termo = buscaTexto.trim().toLowerCase();
        return (
          n.numero.toLowerCase().includes(termo) ||
          n.razaoSocialDestinatario.toLowerCase().includes(termo) ||
          n.cnpjCpfDestinatario.toLowerCase().includes(termo) ||
          n.chave.toLowerCase().includes(termo) ||
          n.situacao.toLowerCase().includes(termo)
        );
      }

      return true;
    });
  }, [notas, filtroStatus, buscaTexto]);

  const percentualProgresso = useMemo(() => {
    if (!progresso || progresso.totalParaProcessar === 0) return 0;
    if (progresso.concluido) return 100;
    return Math.min(
      100,
      Math.round((progresso.processadas / progresso.totalParaProcessar) * 100)
    );
  }, [progresso]);

  const totalAvisosCnpj = useMemo(
    () => notas.filter((n) => n.cnpjDivergente).length,
    [notas]
  );

  const podeIniciarDownload =
    Boolean(arquivoCertificado) &&
    Boolean(senhaCertificado) &&
    Boolean(dadosCertificado) &&
    !dadosCertificado?.vencido &&
    !erroCertificado &&
    Boolean(resumoCsv) &&
    (resumoCsv?.totalAutorizadas || 0) > 0 &&
    !processandoLote;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-20">
        <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-8">
          <a
            href="#configuracao"
            className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Baixador de XML NF-e
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a
              href="#configuracao"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Configuração
            </a>
            <a
              href="#previa-notas"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Prévia de Notas
            </a>
            <a
              href="#especificacoes"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Regras SEFAZ
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={carregarDadosExemplo}
              disabled={processandoLote}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200/70 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer"
            >
              Carregar Dados de Exemplo
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1360px] w-full mx-auto px-6 py-8 space-y-8">
        {/* Cabeçalho */}
        <section id="configuracao" className="space-y-2">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500">
                Webservice Nacional · NFeDistribuicaoDFe v1.01 · Autenticação mTLS A1
              </p>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mt-1">
                Consulta e Download em Lote de XMLs (procNFe)
              </h1>
              {versaoApp && <p className="text-xs text-slate-400 font-mono mt-1">versão {versaoApp}</p>}
            </div>
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>Certificado e senha processados exclusivamente em memória RAM</span>
            </div>
          </div>
        </section>

        {erroGeral && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3 text-sm text-red-900"
          >
            <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">Aviso do Sistema</p>
              <p className="text-red-800 mt-0.5">{erroGeral}</p>
            </div>
          </div>
        )}

        {/* Grade de Configuração */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* 1. Certificado Digital */}
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">
                  01. Certificado Digital A1
                </h2>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  .pfx / .p12 · máx. 5 MB
                </span>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Arquivo do Certificado (.pfx ou .p12)
                </label>
                <input
                  ref={certInputRef}
                  type="file"
                  accept=".pfx,.p12,application/x-pkcs12"
                  onChange={handleSelecionarCertificado}
                  disabled={processandoLote}
                  className="hidden"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => certInputRef.current?.click()}
                    disabled={processandoLote}
                    className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    Selecionar Certificado
                  </button>
                  <span className="text-xs text-slate-600 truncate font-mono">
                    {arquivoCertificado
                      ? arquivoCertificado.name
                      : 'Nenhum arquivo selecionado'}
                  </span>
                </div>
              </div>

              <div>
                <label
                  htmlFor="senha-certificado"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Senha do Certificado
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="senha-certificado"
                      type={mostrarSenha ? 'text' : 'password'}
                      value={senhaCertificado}
                      onChange={(e) => setSenhaCertificado(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && arquivoCertificado && senhaCertificado) {
                          validarCertificadoNoBackend(arquivoCertificado, senhaCertificado);
                        }
                      }}
                      disabled={processandoLote}
                      placeholder="Digite a senha do certificado A1"
                      className="w-full pl-9 pr-9 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setMostrarSenha((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                      aria-label={mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'}
                    >
                      {mostrarSenha ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      arquivoCertificado &&
                      validarCertificadoNoBackend(arquivoCertificado, senhaCertificado)
                    }
                    disabled={!arquivoCertificado || !senhaCertificado || validandoCert || processandoLote}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {validandoCert ? 'Lendo...' : 'Validar'}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100">
              {erroCertificado ? (
                <div className="flex items-start gap-2.5 text-xs text-red-700 bg-red-50/80 border border-red-200 rounded-lg p-3">
                  <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Certificado bloqueado</p>
                    <p className="mt-0.5">{erroCertificado}</p>
                  </div>
                </div>
              ) : dadosCertificado ? (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 truncate">
                      {dadosCertificado.razaoSocial}
                    </span>
                    <span className="text-emerald-700 font-medium flex items-center gap-1 shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Válido ({dadosCertificado.diasRestantes} dias)
                    </span>
                  </div>
                  <div className="text-slate-600 font-mono tabular-nums flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>CNPJ: {dadosCertificado.cnpjFormatado}</span>
                    <span aria-hidden="true">·</span>
                    <span>Validade: {dadosCertificado.validoAte}</span>
                  </div>
                  {dadosCertificado.isCertificadoTeste && (
                    <p className="text-amber-700 text-[11px] pt-1">
                      Certificado de demonstração detectado — modo de simulação SOAP SEFAZ ativado.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Selecione o certificado A1 e informe a senha para extrair o CNPJ do titular (OID 2.16.76.1.3.3 / CN) e verificar a validade.
                </p>
              )}
            </div>
          </div>

          {/* 2. Upload do CSV */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">
                  02. Relatório CSV de NF-e
                </h2>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  .csv (;) · máx. 10 MB
                </span>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Arquivo CSV Emitidas (UTF-8 ou Latin-1)
                </label>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv,.txt,text/csv"
                  onChange={handleSelecionarCsv}
                  disabled={processandoLote}
                  className="hidden"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => csvInputRef.current?.click()}
                    disabled={processandoLote}
                    className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    Selecionar CSV
                  </button>
                  <span className="text-xs text-slate-600 truncate font-mono">
                    {arquivoCsv ? arquivoCsv.name : 'Nenhum relatório enviado'}
                  </span>
                </div>
              </div>

              <div className="text-xs text-slate-500 space-y-1">
                <p>
                  Colunas esperadas: <span className="font-mono text-[11px]">Numero NF-e; CNPJ/CPF; Razao Social; Data de Emissao; Data de Autorizacao; Valor; Chave; UF; Situacao; Tipo Operacao;</span>
                </p>
                <p>
                  Remove apóstrofo inicial da chave, valida 44 dígitos (Módulo 11) e ignora duplicadas ou canceladas.
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100">
              {erroCsv ? (
                <div className="flex items-start gap-2.5 text-xs text-red-700 bg-red-50/80 border border-red-200 rounded-lg p-3">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">CSV fora do formato</p>
                    <p className="mt-0.5">{erroCsv}</p>
                  </div>
                </div>
              ) : resumoCsv ? (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900">
                      {resumoCsv.totalNotas} nota(s) única(s) lida(s)
                    </span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {formatarMoeda(resumoCsv.valorTotal)}
                    </span>
                  </div>
                  <div className="text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                    <span className="text-emerald-700 font-medium">
                      {resumoCsv.totalAutorizadas} Autorizada(s) ({formatarMoeda(resumoCsv.valorTotalAutorizadas)})
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{resumoCsv.totalIgnoradas} Ignorada(s)</span>
                    {resumoCsv.totalDuplicadasRemovidas > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{resumoCsv.totalDuplicadasRemovidas} Duplicada(s) removida(s)</span>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  {carregandoCsv
                    ? 'Processando linhas e validando dígitos verificadores...'
                    : 'Envie o arquivo CSV para visualizar a tabela de prévia e os valores somados.'}
                </p>
              )}
            </div>
          </div>

          {/* 3. Ambiente SEFAZ e Controles de Execução */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              <h2 className="text-base font-semibold text-slate-900">
                03. Ambiente e Execução
              </h2>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Ambiente Nacional SEFAZ
                </label>
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setAmbiente('1')}
                    disabled={processandoLote}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      ambiente === '1'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Produção (1)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAmbiente('2')}
                    disabled={processandoLote}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      ambiente === '2'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Homologação (2)
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="intervalo-sefaz"
                  className="text-xs font-medium text-slate-700"
                >
                  Intervalo entre consultas
                </label>
                <select
                  id="intervalo-sefaz"
                  value={intervaloSegundos}
                  onChange={(e) => setIntervaloSegundos(Number(e.target.value))}
                  disabled={processandoLote}
                  className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                >
                  <option value={1}>1 segundo</option>
                  <option value={2}>2 segundos (Padrão)</option>
                  <option value={3}>3 segundos</option>
                  <option value={5}>5 segundos</option>
                </select>
              </div>

              {dadosCertificado?.isCertificadoTeste && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 leading-snug">
                  Certificado de demonstração: as respostas da SEFAZ serão simuladas e os XMLs gerados são fictícios (não importe na contabilidade).
                </p>
              )}
            </div>

            {/* Painel de Botões: Iniciar / Pausar / Retomar / Baixar ZIP para Computador */}
            <div className="pt-3 border-t border-slate-100 space-y-2.5">
              {!jobId || (!processandoLote && !progresso?.pausado && !progresso?.concluido) ? (
                <button
                  type="button"
                  onClick={iniciarDownloadXmls}
                  disabled={!podeIniciarDownload}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>Baixar XMLs</span>
                </button>
              ) : (
                <div className="space-y-2">
                  {processandoLote && (
                    <button
                      type="button"
                      onClick={pausarDownload}
                      disabled={pausando}
                      className="w-full py-2.5 px-4 text-sm font-semibold text-slate-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                    >
                      <Pause className="w-4 h-4 fill-current" />
                      <span>{pausando ? 'Pausando...' : 'Pausar Download'}</span>
                    </button>
                  )}

                  {!processandoLote && progresso?.pausado && !progresso?.concluido && (
                    <button
                      type="button"
                      onClick={retornarDeOndeParou}
                      disabled={retomando}
                      className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                    >
                      <RotateCw className={`w-4 h-4 ${retomando ? 'animate-spin' : ''}`} />
                      <span>{retomando ? 'Retomando...' : 'Retornar de Onde Parou'}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Botão para iniciar o download do .zip para o computador (disponível quando houver tarefa ativa ou concluída) */}
              {jobId && (
                <button
                  type="button"
                  onClick={baixarZipParaComputador}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer shadow-xs"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {progresso?.concluido
                      ? 'Baixar ZIP para meu Computador'
                      : `Baixar ZIP (${progresso?.baixadas || 0} baixados até agora)`}
                  </span>
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Barra de Progresso e Painel de Controle de Execução */}
        {progresso && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {progresso.concluido
                      ? 'Processamento do Lote Finalizado'
                      : progresso.pausado
                      ? 'Download Pausado'
                      : 'Processando Lote junto ao Ambiente Nacional SEFAZ'}
                  </span>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    ({progresso.processadas}/{progresso.totalParaProcessar} consultadas · {percentualProgresso}%)
                  </span>
                  {progresso.pausado && !progresso.concluido && (
                    <span className="text-[11px] font-medium text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                      Pausa ativa
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-600">{progresso.mensagemGeral}</p>
              </div>

              {/* Controles rápidos no cabeçalho do progresso */}
              <div className="flex items-center gap-2.5 shrink-0">
                {processandoLote && (
                  <button
                    type="button"
                    onClick={pausarDownload}
                    disabled={pausando}
                    className="px-3.5 py-1.5 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    <span>Pausar</span>
                  </button>
                )}

                {!processandoLote && progresso.pausado && !progresso.concluido && (
                  <button
                    type="button"
                    onClick={retornarDeOndeParou}
                    disabled={retomando}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${retomando ? 'animate-spin' : ''}`} />
                    <span>Retornar de Onde Parou</span>
                  </button>
                )}

                {jobId && (
                  <button
                    type="button"
                    onClick={baixarZipParaComputador}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FileArchive className="w-3.5 h-3.5" />
                    <span>Baixar .ZIP</span>
                  </button>
                )}
              </div>
            </div>

            {/* Barra visual */}
            <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-200 ${
                  progresso.pausadoPor656 || progresso.pausado
                    ? 'bg-amber-500'
                    : progresso.concluido
                    ? 'bg-emerald-600'
                    : 'bg-blue-600'
                }`}
                style={{ width: `${percentualProgresso}%` }}
              />
            </div>

            {/* Contadores */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600 pt-1 tabular-nums">
              <span>
                <strong className="text-emerald-700 font-semibold">{progresso.baixadas}</strong> Baixada(s) (procNFe)
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-amber-700 font-semibold">{progresso.apenasResumo}</strong> Apenas Resumo (resNFe)
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-slate-800 font-semibold">{progresso.naoEncontradas}</strong> Não encontrada(s) (137)
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-red-700 font-semibold">{progresso.erros}</strong> Erro(s)
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-slate-700 font-semibold">{progresso.ignoradas}</strong> Ignorada(s)
              </span>
            </div>
          </section>
        )}

        {/* Aviso de Divergência de CNPJ */}
        {totalAvisosCnpj > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">
                Aviso de divergência de CNPJ em {totalAvisosCnpj} nota(s):
              </span>{' '}
              O CNPJ contido na chave difere do CNPJ do certificado. As notas ainda serão consultadas normalmente.
            </div>
          </div>
        )}

        {/* Prévia em Tabela e Status por Nota */}
        <section id="previa-notas" className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-6 border-b border-slate-200 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Relação de Notas Fiscais do CSV
                </h2>
                {resumoCsv ? (
                  <p className="text-xs text-slate-600 mt-0.5 tabular-nums">
                    Total de notas: <strong className="text-slate-900">{resumoCsv.totalNotas}</strong>
                    {' · '}
                    Autorizadas para download: <strong className="text-emerald-700">{resumoCsv.totalAutorizadas}</strong>
                    {' · '}
                    Valor Total Somado: <strong className="text-slate-900 font-mono">{formatarMoeda(resumoCsv.valorTotal)}</strong>
                    {' · '}
                    Período: <span className="font-mono">{resumoCsv.dataMaisAntiga}</span> a <span className="font-mono">{resumoCsv.dataMaisRecente}</span>
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 mt-0.5">
                    Nenhuma nota carregada no momento. Envie um arquivo CSV ou clique em "Carregar Dados de Exemplo".
                  </p>
                )}
              </div>

              {notas.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    {(
                      [
                        { id: 'todas', label: `Todas (${notas.length})` },
                        {
                          id: 'autorizadas',
                          label: `Autorizadas (${notas.filter((n) => n.processar).length})`,
                        },
                        {
                          id: 'baixadas',
                          label: `Baixadas (${notas.filter((n) => n.status === 'baixado').length})`,
                        },
                        {
                          id: 'ignoradas',
                          label: `Ignoradas (${notas.filter((n) => n.status === 'ignorada').length})`,
                        },
                        {
                          id: 'erros',
                          label: `Alertas/Erros (${
                            notas.filter(
                              (n) =>
                                n.status === 'erro' ||
                                n.status === 'nao_encontrado' ||
                                n.status === 'apenas_resumo' ||
                                n.cnpjDivergente
                            ).length
                          })`,
                        },
                      ] as { id: FiltroTabela; label: string }[]
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setFiltroStatus(tab.id)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                          filtroStatus === tab.id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={buscaTexto}
                      onChange={(e) => setBuscaTexto(e.target.value)}
                      placeholder="Buscar número, chave ou destinatário..."
                      className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white w-64"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tabela de Notas */}
          {notas.length === 0 ? (
            <div className="py-16 px-6 text-center space-y-3">
              <FileSpreadsheet className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="max-w-md mx-auto space-y-1">
                <p className="text-sm font-semibold text-slate-800">
                  Aguardando upload do relatório CSV
                </p>
                <p className="text-xs text-slate-500">
                  Assim que o arquivo CSV for selecionado, a prévia das NF-e com Número, Destinatário, Data de Emissão, Valor, Chave de 44 dígitos e Situação será exibida aqui.
                </p>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={carregarDadosExemplo}
                  className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Testar com Certificado e CSV de Exemplo
                </button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4 whitespace-nowrap">Número</th>
                    <th className="py-3 px-4 whitespace-nowrap">Destinatário</th>
                    <th className="py-3 px-4 whitespace-nowrap">Data de Emissão</th>
                    <th className="py-3 px-4 whitespace-nowrap text-right">Valor (R$)</th>
                    <th className="py-3 px-4 whitespace-nowrap">Chave de Acesso (44 dígitos)</th>
                    <th className="py-3 px-4 whitespace-nowrap">Situação CSV</th>
                    <th className="py-3 px-4 whitespace-nowrap">Status / Retorno SEFAZ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {notasFiltradas.map((nota) => (
                    <tr
                      key={nota.id}
                      className={`hover:bg-slate-50/90 transition-colors ${
                        nota.status === 'processando'
                          ? 'bg-blue-50/40'
                          : nota.status === 'ignorada'
                          ? 'bg-slate-50/50 text-slate-500'
                          : ''
                      }`}
                    >
                      <td className="py-2.5 px-4 font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                        {nota.numero}
                      </td>
                      <td className="py-2.5 px-4 max-w-[240px]">
                        <div className="font-medium text-slate-900 truncate" title={nota.razaoSocialDestinatario}>
                          {nota.razaoSocialDestinatario}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          {nota.cnpjCpfDestinatario} · UF: {nota.ufDest}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {nota.dataEmissao}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums font-semibold text-slate-900 text-right whitespace-nowrap">
                        {formatarMoeda(nota.valor)}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[11px] text-slate-700 whitespace-nowrap">
                        <div>{formatarChaveAgrupada(nota.chave || nota.chaveOriginal)}</div>
                        {nota.cnpjDivergente && (
                          <div className="text-amber-700 flex items-center gap-1 mt-0.5">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            <span>CNPJ emitente ({nota.cnpjEmitente}) diverge do certificado</span>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <span
                          className={`font-medium ${
                            nota.situacao.toLowerCase() === 'autorizada'
                              ? 'text-emerald-700'
                              : 'text-slate-500'
                          }`}
                        >
                          {nota.situacao}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 min-w-[240px]">
                        <div className="flex items-start gap-1.5">
                          {nota.status === 'baixado' && (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                          )}
                          {nota.status === 'processando' && (
                            <RefreshCw className="w-4 h-4 text-blue-600 animate-spin shrink-0 mt-0.5" />
                          )}
                          {nota.status === 'aguardando' && (
                            <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                          )}
                          {(nota.status === 'apenas_resumo' ||
                            nota.status === 'nao_encontrado') && (
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          )}
                          {nota.status === 'erro' && (
                            <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                          )}
                          {nota.status === 'ignorada' && (
                            <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                          )}
                          <div className="leading-snug">
                            <span
                              className={`font-semibold ${
                                nota.status === 'baixado'
                                  ? 'text-emerald-700'
                                  : nota.status === 'processando'
                                  ? 'text-blue-700'
                                  : nota.status === 'erro'
                                  ? 'text-red-700'
                                  : nota.status === 'apenas_resumo' ||
                                    nota.status === 'nao_encontrado'
                                  ? 'text-amber-700'
                                  : 'text-slate-600'
                              }`}
                            >
                              {nota.status === 'baixado' && 'Baixado · '}
                              {nota.status === 'processando' && 'Consultando · '}
                              {nota.status === 'aguardando' && 'Aguardando · '}
                              {nota.status === 'apenas_resumo' && 'Apenas resumo · '}
                              {nota.status === 'nao_encontrado' && 'Não encontrado · '}
                              {nota.status === 'ignorada' && 'Ignorada · '}
                              {nota.status === 'erro' && 'Erro · '}
                            </span>
                            <span className="text-slate-600">{nota.mensagemSefaz}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t border-slate-200 text-xs font-semibold text-slate-900">
                    <td colSpan={3} className="py-3 px-4">
                      Total Geral ({resumoCsv?.totalNotas || 0} notas · {resumoCsv?.totalAutorizadas || 0} autorizadas)
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {formatarMoeda(resumoCsv?.valorTotal || 0)}
                    </td>
                    <td colSpan={3} className="py-3 px-4 text-slate-600 font-normal">
                      Valor somado das notas autorizadas:{' '}
                      <strong className="font-mono tabular-nums text-slate-900">
                        {formatarMoeda(resumoCsv?.valorTotalAutorizadas || 0)}
                      </strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>

        {/* Informações da Integração */}
        <section
          id="especificacoes"
          className="bg-white border border-slate-200 rounded-xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-600"
        >
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-slate-900 font-semibold">
              <FileCode2 className="w-4 h-4 text-blue-600" />
              <span>NFeDistribuicaoDFe (v1.01)</span>
            </div>
            <p className="leading-relaxed">
              Consulta individual por chave (<code className="font-mono">consChNFe</code>) via SOAP 1.2 no Ambiente Nacional. Descompacta lotes <code className="font-mono">&lt;docZip&gt;</code> em Base64 + GZIP e armazena apenas arquivos com schema <code className="font-mono">procNFe</code>.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-slate-900 font-semibold">
              <Clock className="w-4 h-4 text-blue-600" />
              <span>Pausa, Retomada e Limites SEFAZ</span>
            </div>
            <p className="leading-relaxed">
              Permite pausar e retomar o lote a qualquer momento de onde parou. Respeita o intervalo configurável (padrão 2s), timeout de 30s e pausa imediata se receber <code className="font-mono">cStat 656</code> (Consumo Indevido).
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-slate-900 font-semibold">
              <FileArchive className="w-4 h-4 text-blue-600" />
              <span>Download Direto do ZIP</span>
            </div>
            <p className="leading-relaxed">
              O botão de download do .zip permite salvar no seu computador a qualquer momento o pacote com os XMLs <code className="font-mono">{'{chave}'}-procNFe.xml</code> já baixados e o <code className="font-mono">relatorio.csv</code> consolidado.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white py-4 px-6 text-xs text-slate-500">
        <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Baixador de XML NF-e · Comunicação mTLS SEFAZ</span>
          <span>Nenhum certificado digital, senha ou XML é persistido em disco</span>
        </div>
      </footer>
    </div>
  );
}
