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

  // Migração: renomeia colunas antigas se existirem
  try {
    await sql`ALTER TABLE ordens_servico RENAME COLUMN fotos_abertura TO foto_abertura`;
    console.log('Migração: fotos_abertura -> foto_abertura');
  } catch {}
  try {
    await sql`ALTER TABLE ordens_servico RENAME COLUMN fotos_conclusao TO foto_conclusao`;
    console.log('Migração: fotos_conclusao -> foto_conclusao');
  } catch {}

  console.log('Banco de dados pronto!');
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

function mapRow(r, incluirFotos) {
  return {
    id: r.id, numero: r.numero, tipo: r.tipo, descricao: r.descricao,
    endereco: r.endereco, bairro: r.bairro, referencia: r.referencia,
    solicitante: r.solicitante, responsavel: r.responsavel, equipe: r.equipe,
    prioridade: r.prioridade, prazo: r.prazo, status: r.status,
    temFotoAbertura: !!r.foto_abertura,
    temFotoConclusao: !!r.foto_conclusao,
    fotoAbertura: incluirFotos ? (r.foto_abertura || null) : undefined,
    fotoConclusao: incluirFotos ? (r.foto_conclusao || null) : undefined,
    historico: r.historico || [],
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em, concluidoEm: r.concluido_em,
  };
}

app.get('/api/ping', async (req, res) => {
  try { await sql`SELECT 1`; res.json({ ok: true, mensagem: 'Conectado!' }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/proximo-numero', async (req, res) => {
  try { res.json({ numero: await gerarNumeroOS() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens', async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, numero, tipo, descricao, endereco, bairro, referencia,
             solicitante, responsavel, equipe, prioridade, prazo, status,
             CASE WHEN foto_abertura  IS NOT NULL AND foto_abertura  != '' THEN true ELSE false END AS tem_abertura,
             CASE WHEN foto_conclusao IS NOT NULL AND foto_conclusao != '' THEN true ELSE false END AS tem_conclusao,
             historico, criado_em, atualizado_em, concluido_em
      FROM ordens_servico ORDER BY criado_em DESC
    `;
    res.json(rows.map(r => ({
      id: r.id, numero: r.numero, tipo: r.tipo, descricao: r.descricao,
      endereco: r.endereco, bairro: r.bairro, referencia: r.referencia,
      solicitante: r.solicitante, responsavel: r.responsavel, equipe: r.equipe,
      prioridade: r.prioridade, prazo: r.prazo, status: r.status,
      temFotoAbertura: r.tem_abertura === true,
      temFotoConclusao: r.tem_conclusao === true,
      historico: r.historico || [],
      criadoEm: r.criado_em, atualizadoEm: r.atualizado_em, concluidoEm: r.concluido_em,
    })));
  } catch (e) { console.error('GET /api/ordens:', e.message); res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens/:id', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM ordens_servico WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ erro: 'Nao encontrada' });
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('GET /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

app.post('/api/ordens', async (req, res) => {
  try {
    const o = req.body;
    const id = uuidv4();
    const numero = await gerarNumeroOS();
    const historico = JSON.stringify([{
      status: 'aberta', data: new Date().toISOString(), obs: 'Ordem de servico aberta'
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
      ) RETURNING *
    `;
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('POST /api/ordens:', e.message); res.status(500).json({ erro: e.message }); }
});

app.put('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const o = req.body;
    const atual = await sql`SELECT foto_abertura, foto_conclusao FROM ordens_servico WHERE id = ${id}`;
    if (!atual.length) return res.status(404).json({ erro: 'Nao encontrada' });
    const fotoAbertura  = o.fotoAbertura  !== undefined ? o.fotoAbertura  : atual[0].foto_abertura;
    const fotoConclusao = o.fotoConclusao !== undefined ? o.fotoConclusao : atual[0].foto_conclusao;
    await sql`
      UPDATE ordens_servico SET
        status         = ${o.status},
        responsavel    = ${o.responsavel || ''},
        equipe         = ${o.equipe || ''},
        historico      = ${JSON.stringify(o.historico || [])},
        foto_abertura  = ${fotoAbertura},
        foto_conclusao = ${fotoConclusao},
        atualizado_em  = NOW(),
        concluido_em   = ${o.concluidoEm || null}
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM ordens_servico WHERE id = ${id}`;
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('PUT /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

app.delete('/api/ordens/:id', async (req, res) => {
  try {
    await sql`DELETE FROM ordens_servico WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

const PORT = process.env.PORT || 3000;
iniciarBanco().then(() => {
  app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
}).catch(err => {
  console.error('Erro ao conectar no banco:', err.message);
  process.exit(1);
});
