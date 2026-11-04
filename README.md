# Baixador de XML NF-e

Aplicação web full-stack (React + TypeScript no frontend e Node.js + Express no backend) para consulta e download em lote de arquivos XML completos (`procNFe`) de Notas Fiscais Eletrônicas diretamente no webservice `NFeDistribuicaoDFe` (versão `1.01`) do Ambiente Nacional da SEFAZ, utilizando autenticação TLS mútua com certificado digital A1 (`.pfx` / `.p12`).

---

## Arquitetura do Projeto

- `server.ts`: Servidor HTTP Express integrado ao Vite (em desenvolvimento) e servindo o bundle estático em produção.
- `routes/nfeRoutes.ts`: Rotas de validação de certificado, prévia de CSV, processamento em lote com Server-Sent Events (SSE) e download do arquivo `.zip`.
- `services/certificado.ts`: Leitura em memória do arquivo `.pfx`/`.p12` com `node-forge`, extração do CNPJ do titular (via OID `2.16.76.1.3.3` da ICP-Brasil ou `CN` no padrão `RAZAO SOCIAL:CNPJ`), razão social e validação de vigência.
- `services/csvParser.ts`: Parser do relatório CSV separado por `;` com suporte a UTF-8 e fallback automático para Windows-1252/Latin-1, limpeza de espaços (`trim`), validação de chave de acesso de 44 dígitos com cálculo do dígito verificador (Módulo 11), remoção de duplicatas e filtro por situação (`Autorizada`).
- `services/sefaz.ts`: Cliente SOAP 1.2 com `https.Agent({ pfx, passphrase })` para o webservice `NFeDistribuicaoDFe`, descompactação de `<docZip>` (`Base64` -> `zlib.gunzipSync`), filtro exclusivo de `procNFe`, tratamento dos códigos `cStat` (`138`, `137`, `656`) e retentativas de rede.
- `services/zip.ts`: Geração em memória do pacote `XML_NFe_{CNPJ}_{data-mais-antiga}_a_{data-mais-recente}.zip` com os arquivos `{chave}-procNFe.xml` e `relatorio.csv`.
- `tests/csvParser.test.ts`: Testes unitários automatizados (Vitest) para o parser do CSV e validação Módulo 11 da chave de acesso.

---

## Como Rodar Localmente

### Pré-requisitos
- **Node.js** 20+ (recomendado Node 22 LTS)
- **npm** 10+

### Passo a passo

1. Instale as dependências:
   ```bash
   npm install
   ```

2. Execute os testes unitários (parser do CSV e validação do dígito verificador Módulo 11):
   ```bash
   npm test
   ```

3. Inicie o servidor de desenvolvimento (porta `3000`):
   ```bash
   npm run dev
   ```

4. Acesse no navegador:
   ```
   http://localhost:3000
   ```

---

## Como Publicar no Google Cloud Run

A aplicação mantém o certificado digital, senha e lotes apenas em memória RAM durante a requisição/sessão. Para publicar no **Google Cloud Run**:

### 1. Crie um `Dockerfile` na raiz do projeto (caso ainda não exista):

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/services ./services
EXPOSE 8080
CMD ["npx", "tsx", "server.ts"]
```

### 2. Faça o deploy via Google Cloud CLI (`gcloud`):

```bash
gcloud run deploy baixador-xml-nfe \
  --source . \
  --region southamerica-east1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 900 \
  --max-instances 5 \
  --session-affinity
```

> **Observações importantes para o Cloud Run:**
> - Utilize `--region southamerica-east1` (São Paulo) para menor latência e melhor conectividade com os webservices da SEFAZ.
> - Utilize `--session-affinity` para garantir que a conexão Server-Sent Events (SSE) e o download final do `.zip` em memória sejam roteados para a mesma instância durante a sessão do usuário.
> - Configure `--timeout 900` (15 minutos) para suportar lotes maiores respeitando o intervalo de 2 segundos entre cada consulta na SEFAZ.
