require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');

const app = express();
const sql = neon(process.env.DATABASE_URL);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── CRIAR TABELA AO INICIAR ───────────────────────────────────────────────────
async function iniciarBanco() {
  await sql`
    CREATE TABLE IF NOT EXISTS ordens_servico (
      id TEXT PRIMARY KEY,
      numero TEXT UNIQUE NOT NULL,
      tipo TEXT,
      descricao TEXT,
      endereco TEXT,
      bairro TEXT,
      referencia TEXT,
      solicitante TEXT,
      responsavel TEXT,
      equipe TEXT,
      prioridade TEXT DEFAULT 'media',
      prazo DATE,
      status TEXT DEFAULT 'aberta',
      fotos_abertura JSONB DEFAULT '[]',
      fotos_conclusao JSONB DEFAULT '[]',
      historico JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW(),
      concluido_em TIMESTAMPTZ
    )
  `;
  console.log('✅ Banco de dados pronto!');
}

// ── HELPER ────────────────────────────────────────────────────────────────────
function mapRow(r) {
  return {
    id: r.id,
    numero: r.numero,
    tipo: r.tipo,
    descricao: r.descricao,
    endereco: r.endereco,
    bairro: r.bairro,
    referencia: r.referencia,
    solicitante: r.solicitante,
    responsavel: r.responsavel,
    equipe: r.equipe,
    prioridade: r.prioridade,
    prazo: r.prazo,
    status: r.status,
    fotosAbertura: r.fotos_abertura || [],
    fotosConclusao: r.fotos_conclusao || [],
    historico: r.historico || [],
    criadoEm: r.criado_em,
    atualizadoEm: r.atualizado_em,
    concluidoEm: r.concluido_em,
  };
}

// ── ROTAS ─────────────────────────────────────────────────────────────────────

// GET /api/ordens — listar todas
app.get('/api/ordens', async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM ordens_servico ORDER BY criado_em DESC
    `;
    res.json(rows.map(mapRow));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// POST /api/ordens — criar nova
app.post('/api/ordens', async (req, res) => {
  try {
    const o = req.body;
    const rows = await sql`
      INSERT INTO ordens_servico (
        id, numero, tipo, descricao, endereco, bairro, referencia,
        solicitante, responsavel, equipe, prioridade, prazo, status,
        fotos_abertura, fotos_conclusao, historico, criado_em, atualizado_em
      ) VALUES (
        ${o.id}, ${o.numero}, ${o.tipo}, ${o.descricao}, ${o.endereco},
        ${o.bairro || ''}, ${o.referencia || ''}, ${o.solicitante},
        ${o.responsavel || ''}, ${o.equipe || ''}, ${o.prioridade || 'media'},
        ${o.prazo || null}, ${o.status || 'aberta'},
        ${JSON.stringify(o.fotosAbertura || [])},
        ${JSON.stringify(o.fotosConclusao || [])},
        ${JSON.stringify(o.historico || [])},
        ${o.criadoEm}, ${o.atualizadoEm}
      )
      RETURNING *
    `;
    res.json(mapRow(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// PUT /api/ordens/:id — atualizar
app.put('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const o = req.body;
    await sql`
      UPDATE ordens_servico SET
        status        = ${o.status},
        responsavel   = ${o.responsavel || ''},
        equipe        = ${o.equipe || ''},
        fotos_abertura  = ${JSON.stringify(o.fotosAbertura || [])},
        fotos_conclusao = ${JSON.stringify(o.fotosConclusao || [])},
        historico     = ${JSON.stringify(o.historico || [])},
        atualizado_em = NOW(),
        concluido_em  = ${o.concluidoEm || null}
      WHERE id = ${id}
    `;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// DELETE /api/ordens/:id — excluir
app.delete('/api/ordens/:id', async (req, res) => {
  try {
    await sql`DELETE FROM ordens_servico WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// GET /api/ping — testar conexão
app.get('/api/ping', async (req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ ok: true, mensagem: 'Conectado ao Neon com sucesso!' });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── INICIAR ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

iniciarBanco().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('🏗️  Sistema de O.S. — Secretaria de Infraestrutura');
    console.log('─────────────────────────────────────────────────');
    console.log(`🌐 Acesse no navegador: http://localhost:${PORT}`);
    console.log(`📱 Celular (mesma rede): veja o IP da sua máquina`);
    console.log('─────────────────────────────────────────────────');
    console.log('Pressione Ctrl+C para parar o servidor');
    console.log('');
  });
}).catch(err => {
  console.error('❌ Erro ao conectar no banco:', err.message);
  process.exit(1);
});