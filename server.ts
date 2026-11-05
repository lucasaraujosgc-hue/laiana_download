import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import multer from 'multer';
import nfeRoutes from './routes/nfeRoutes.ts';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '2mb' }));

  // Versão em execução (Easypanel passa GIT_SHA no build)
  app.get('/api/versao', (_req: Request, res: Response) => {
    res.json({ versao: (process.env.GIT_SHA || 'desconhecida').slice(0, 7) });
  });

  // Rotas da API
  app.use('/api', nfeRoutes);

  // Tratamento de erros do multer
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({
          erro: 'Arquivo excede o tamanho máximo permitido (5 MB para certificado e 10 MB para CSV).',
        });
        return;
      }
      res.status(400).json({
        erro: `Erro no envio do arquivo: ${err.message}`,
      });
      return;
    }
    if (err) {
      res.status(500).json({
        erro: err.message || 'Erro interno no servidor.',
      });
      return;
    }
    next();
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor Baixador de XML NF-e ativo na porta ${PORT}`);
  });
}

startServer();
