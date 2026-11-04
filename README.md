# Baixador de XML NF-e

Aplicação web full-stack (React + TypeScript no frontend e Node.js + Express no backend) para consulta e download em lote de arquivos XML completos (`procNFe`) de Notas Fiscais Eletrônicas diretamente no webservice `NFeDistribuicaoDFe` (versão `1.01`) do Ambiente Nacional da SEFAZ, utilizando autenticação TLS mútua com certificado digital A1 (`.pfx` / `.p12`).

---

## Funcionalidades Principais

- **Autenticação mTLS A1 em Memória**:
  - Leitura em memória de arquivos `.pfx`/`.p12` via `node-forge` e extração de CNPJ do titular (OID `2.16.76.1.3.3` ou CN no formato `RAZAO SOCIAL:CNPJ`), razão social e data de validade.
  - Certificado e senha nunca são gravados em disco, banco de dados ou logs.
- **Parser CSV Inteligente**:
  - Decodificação UTF-8 com fallback automático para Windows-1252/Latin-1.
  - Limpeza de espaços (`trim()`), remoção de apóstrofo e caracteres não numéricos da chave de 44 dígitos.
  - Validação estrita do dígito verificador por **Módulo 11**.
  - Remoção de chaves duplicadas e separação automática de notas autorizadas versus ignoradas (canceladas/denegadas).
- **Controle de Download: Pausa e Retomada**:
  - **Botão de Pausa**: Permite pausar o lote de downloads a qualquer momento sem perder o que já foi processado.
  - **Botão de Retomada**: Retoma o processamento sequencial exatamente a partir da próxima nota pendente.
  - **Botão de Download do ZIP para o Computador**: Permite baixar para o computador o arquivo `.zip` com os XMLs `{chave}-procNFe.xml` e o `relatorio.csv` consolidado a qualquer momento (parcial ou finalizado).
- **Respeito aos Limites da SEFAZ**:
  - Intervalo configurável entre requisições (padrão 2 segundos).
  - Timeout de 30s por nota e até 2 novas tentativas em falhas de conexão.
  - Pausa imediata e aviso ao usuário se a SEFAZ retornar `cStat 656` (Consumo Indevido).

---

## Estrutura do Projeto

- `server.ts`: Ponto de entrada Express integrado com middlewares do Vite em desenvolvimento e arquivos estáticos em produção.
- `routes/nfeRoutes.ts`: Rotas da API para validação de certificado, prévia do CSV, início/pausa/retomada de lote, Server-Sent Events (SSE) e download do `.zip`.
- `services/certificado.ts`: Leitura e validação de certificados A1 e geração de certificados de teste.
- `services/csvParser.ts`: Parser do CSV, desduplicação e cálculo do dígito verificador Módulo 11.
- `services/sefaz.ts`: Montagem SOAP 1.2, cliente TLS mútuo, descompactação Base64/GZIP (`docZip`) e extração do schema `procNFe`.
- `services/zip.ts`: Empacotamento em memória dos XMLs e geração do `relatorio.csv` com BOM UTF-8 para Excel.
- `src/App.tsx`: Interface completa em React com tabela de notas, filtros, barra de progresso, botões de Pausa, Retomar e Download do ZIP.
- `tests/csvParser.test.ts`: Testes unitários com Vitest para validação da chave e do CSV.

---

## Como Executar Localmente

1. Instalar as dependências:
   ```bash
   npm install
   ```

2. Executar os testes unitários:
   ```bash
   npm test
   ```

3. Iniciar o servidor full-stack (porta 3000):
   ```bash
   npm run dev
   ```

4. Acesse no navegador:
   ```
   http://localhost:3000
   ```

---

## Como Publicar no Google Cloud Run

```bash
gcloud run deploy baixador-xml-nfe \
  --source . \
  --region southamerica-east1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 900 \
  --session-affinity
```
