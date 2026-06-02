require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');

const app = express();
const sql = neon(process.env.DATABASE_URL);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── BANCO ─────────────────────────────────────────────────────────────────────
async function iniciarBanco() {
  await sql`
    CREATE TABLE IF NOT EXISTS ordens_servico (
      id              TEXT PRIMARY KEY,
      numero          TEXT UNIQUE NOT NULL,
      tipo            TEXT,
      descricao       TEXT,
      endereco        TEXT,
      bairro          TEXT,
      referencia      TEXT,
      solicitante     TEXT NOT NULL,
      responsavel     TEXT,
      equipe          TEXT,
      prioridade      TEXT DEFAULT 'media',
      prazo           DATE,
      status          TEXT DEFAULT 'aberta',
      foto_abertura   TEXT,
      foto_conclusao  TEXT,
      historico       JSONB DEFAULT '[]',
      criado_em       TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em   TIMESTAMPTZ DEFAULT NOW(),
      concluido_em    TIMESTAMPTZ
    )
  `;
  console.log('✅ Banco de dados pronto!');
}

async function gerarNumeroOS() {
  const ano = new Date().getFullYear();
  const rows = await sql`
    SELECT numero FROM ordens_servico
    WHERE numero LIKE ${'OS-' + ano + '-%'}
    ORDER BY numero DESC LIMIT 1
  `;
  if (!rows.length) return `OS-${ano}-0001`;
  const seq = parseInt(rows[0].numero.split('-')[2]) + 1;
  return `OS-${ano}-${String(seq).padStart(4, '0')}`;
}

// ── HELPER ────────────────────────────────────────────────────────────────────
function mapRow(r, incluirFotos = true) {
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
    temFotoAbertura: !!r.foto_abertura,
    temFotoConclusao: !!r.foto_conclusao,
    ...(incluirFotos && {
      fotoAbertura: r.foto_abertura || null,
      fotoConclusao: r.foto_conclusao || null,
    }),
    historico: r.historico || [],
    criadoEm: r.criado_em,
    atualizadoEm: r.atualizado_em,
    concluidoEm: r.concluido_em,
  };
}

// ── ROTAS ─────────────────────────────────────────────────────────────────────

app.get('/api/ping', async (req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ ok: true, mensagem: 'Conectado ao Neon com sucesso!' });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/api/proximo-numero', async (req, res) => {
  try {
    const numero = await gerarNumeroOS();
    res.json({ numero });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Listar todas (sem base64 das fotos)
app.get('/api/ordens', async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, numero, tipo, descricao, endereco, bairro, referencia,
             solicitante, responsavel, equipe, prioridade, prazo, status,
             (foto_abertura IS NOT NULL AND foto_abertura != '') AS foto_abertura,
             (foto_conclusao IS NOT NULL AND foto_conclusao != '') AS foto_conclusao,
             historico, criado_em, atualizado_em, concluido_em
      FROM ordens_servico ORDER BY criado_em DESC
    `;
    res.json(rows.map(r => ({
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
      temFotoAbertura: r.foto_abertura === true,
      temFotoConclusao: r.foto_conclusao === true,
      historico: r.historico || [],
      criadoEm: r.criado_em,
      atualizadoEm: r.atualizado_em,
      concluidoEm: r.concluido_em,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// Buscar uma OS completa (com fotos)
app.get('/api/ordens/:id', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM ordens_servico WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ erro: 'Não encontrada' });
    res.json(mapRow(rows[0], true));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// Criar nova OS
app.post('/api/ordens', async (req, res) => {
  try {
    const o = req.body;
    const id = uuidv4();
    const numero = await gerarNumeroOS();
    const historico = JSON.stringify([{
      status: 'aberta',
      data: new Date().toISOString(),
      obs: 'Ordem de serviço aberta'
    }]);

    const rows = await sql`
      INSERT INTO ordens_servico (
        id, numero, tipo, descricao, endereco, bairro, referencia,
        solicitante, responsavel, equipe, prioridade, prazo, status,
        foto_abertura, historico
      ) VALUES (
        ${id}, ${numero}, ${o.tipo || ''}, ${o.descricao || ''},
        ${o.endereco || ''}, ${o.bairro || ''}, ${o.referencia || ''},
        ${o.solicitante}, ${o.responsavel || ''}, ${o.equipe || ''},
        ${o.prioridade || 'media'}, ${o.prazo || null}, 'aberta',
        ${o.fotoAbertura || null}, ${historico}
      )
      RETURNING *
    `;
    res.json(mapRow(rows[0], true));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// Atualizar OS
app.put('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const o = req.body;

    // Build update selectively to avoid overwriting photos with null when not sent
    const sets = [
      sql`status = ${o.status}`,
      sql`responsavel = ${o.responsavel || ''}`,
      sql`equipe = ${o.equipe || ''}`,
      sql`historico = ${JSON.stringify(o.historico || [])}`,
      sql`atualizado_em = NOW()`,
      sql`concluido_em = ${o.concluidoEm || null}`,
    ];
    if (o.fotoAbertura !== undefined) sets.push(sql`foto_abertura = ${o.fotoAbertura}`);
    if (o.fotoConclusao !== undefined) sets.push(sql`foto_conclusao = ${o.fotoConclusao}`);

    // neon serverless supports sql.join for dynamic SET clauses
    await sql`UPDATE ordens_servico SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`;

    const rows = await sql`SELECT * FROM ordens_servico WHERE id = ${id}`;
    res.json(mapRow(rows[0], true));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// Excluir OS
app.delete('/api/ordens/:id', async (req, res) => {
  try {
    await sql`DELETE FROM ordens_servico WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});

// ── INICIAR ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

iniciarBanco().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('🏗️  Sistema de O.S. — Secretaria de Infraestrutura');
    console.log('─────────────────────────────────────────────────');
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
    console.log('─────────────────────────────────────────────────');
  });
}).catch(err => {
  console.error('❌ Erro ao conectar no banco:', err.message);
  process.exit(1);
});
