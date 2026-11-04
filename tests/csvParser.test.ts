import { describe, it, expect } from 'vitest';
import {
  calcularDigitoVerificador,
  validarChaveAcesso,
  parseLinhaCsv,
  parseRelatorioCsv,
  parseValorBrasileiro,
} from '../services/csvParser.ts';

describe('Validação do Dígito Verificador da Chave NF-e (Módulo 11)', () => {
  const chaveExemplo = '29261063210993000146550020000005681012126269';

  it('deve calcular corretamente o dígito verificador (9) para os 43 primeiros dígitos da chave de exemplo', () => {
    const base43 = chaveExemplo.substring(0, 43);
    const dv = calcularDigitoVerificador(base43);
    expect(dv).toBe(9);
  });

  it('deve validar uma chave de 44 dígitos autêntica, inclusive com apóstrofo inicial', () => {
    const resultado = validarChaveAcesso(`'${chaveExemplo}`);
    expect(resultado.valida).toBe(true);
    expect(resultado.chaveLimpa).toBe(chaveExemplo);
  });

  it('deve rejeitar chave com dígito verificador incorreto', () => {
    const chaveInvalida = '29261063210993000146550020000005681012126260';
    const resultado = validarChaveAcesso(chaveInvalida);
    expect(resultado.valida).toBe(false);
    expect(resultado.motivo).toContain('Dígito verificador inválido');
  });

  it('deve rejeitar chave com menos ou mais de 44 dígitos', () => {
    const resultado = validarChaveAcesso("'2926106321099300014655");
    expect(resultado.valida).toBe(false);
    expect(resultado.motivo).toContain('tamanho inválido');
  });
});

describe('Parser do Relatório CSV de NF-e', () => {
  const linhaExemploPrompt =
    " 000.000.568; 140.044.599-07; vitoria helena crul; 02/10/2026 09:51:06 ; 02/10/2026 09:53:00 ;52,50;'29261063210993000146550020000005681012126269; PR; Autorizada; Saida;";

  it('deve fazer o parse exato da linha de exemplo especificada no requisito', () => {
    const nota = parseLinhaCsv(linhaExemploPrompt, 1, '63210993000146');
    expect(nota).not.toBeNull();
    if (!nota) return;

    expect(nota.numero).toBe('000.000.568');
    expect(nota.cnpjCpfDestinatario).toBe('140.044.599-07');
    expect(nota.razaoSocialDestinatario).toBe('vitoria helena crul');
    expect(nota.dataEmissao).toBe('02/10/2026 09:51:06');
    expect(nota.dataEmissaoIso).toBe('2026-10-02');
    expect(nota.dataAutorizacao).toBe('02/10/2026 09:53:00');
    expect(nota.valor).toBe(52.5);
    expect(nota.chave).toBe('29261063210993000146550020000005681012126269');
    expect(nota.cUF).toBe('29');
    expect(nota.cnpjEmitente).toBe('63210993000146');
    expect(nota.ufDest).toBe('PR');
    expect(nota.situacao).toBe('Autorizada');
    expect(nota.tipoOperacao).toBe('Saida');
    expect(nota.chaveValida).toBe(true);
    expect(nota.processar).toBe(true);
    expect(nota.status).toBe('aguardando');
    expect(nota.cnpjDivergente).toBe(false);
  });

  it('deve converter valores no formato brasileiro com milhar e decimal (ex: 3.080,00)', () => {
    expect(parseValorBrasileiro('3.080,00')).toBe(3080);
    expect(parseValorBrasileiro(' 12.450,75 ')).toBe(12450.75);
    expect(parseValorBrasileiro('52,50')).toBe(52.5);
  });

  it('deve remover chaves duplicadas, ignorar linhas vazias e marcar notas não autorizadas como ignoradas', () => {
    const baseCancelada43 = '2926106321099300014655002000000569101212627';
    const dvCancelada = calcularDigitoVerificador(baseCancelada43);
    const chaveCancelada = `${baseCancelada43}${dvCancelada}`;

    const csvConteudo = [
      'Numero NF-e;CNPJ/CPF Destinatario;Razao Social Destinatario;Data de Emissao;Data de Autorizacao;Valor (R$);Chave de Acesso;UF Dest.;Situacao;Tipo Operacao;',
      linhaExemploPrompt,
      '', // linha vazia
      linhaExemploPrompt, // duplicada
      ` 000.000.569; 11.222.333/0001-81; Cliente Cancelado LTDA; 05/10/2026 14:20:00 ; 05/10/2026 14:21:00 ;3.080,00;'${chaveCancelada}; SP; Cancelada; Saida;`,
    ].join('\r\n');

    const resultado = parseRelatorioCsv(csvConteudo, '63210993000146');

    expect(resultado.totalNotas).toBe(2);
    expect(resultado.totalDuplicadasRemovidas).toBe(1);
    expect(resultado.totalAutorizadas).toBe(1);
    expect(resultado.totalIgnoradas).toBe(1);
    expect(resultado.valorTotal).toBe(3132.5);
    expect(resultado.valorTotalAutorizadas).toBe(52.5);
    expect(resultado.dataMaisAntiga).toBe('2026-10-02');
    expect(resultado.dataMaisRecente).toBe('2026-10-05');
    expect(resultado.notas[1].status).toBe('ignorada');
  });

  it('deve sinalizar aviso quando o CNPJ do certificado for diferente do CNPJ contido na chave (posições 7 a 20)', () => {
    const nota = parseLinhaCsv(linhaExemploPrompt, 1, '11222333000199');
    expect(nota).not.toBeNull();
    expect(nota?.cnpjDivergente).toBe(true);
    expect(nota?.avisoCnpj).toContain('63210993000146');
    expect(nota?.processar).toBe(true);
  });
});
