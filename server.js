require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('ERRO: defina DATABASE_URL no arquivo .env (veja .env.example)');
  process.exit(1);
}

// Neon e outros bancos gerenciados exigem SSL; Postgres local não.
const precisaSSL = /sslmode=require|neon\.tech|\.aws\.|\.azure\./i.test(databaseUrl);
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: precisaSSL ? { rejectUnauthorized: false } : false,
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

async function iniciarBanco() {
  await pool.query(`
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
  `);

  // Migração: renomeia colunas antigas se existirem
  const renames = [
    ['fotos_abertura', 'foto_abertura'],
    ['fotos_conclusao', 'foto_conclusao'],
  ];
  for (const [antiga, nova] of renames) {
    try {
      await pool.query(`ALTER TABLE ordens_servico RENAME COLUMN ${antiga} TO ${nova}`);
      console.log(`Migração: ${antiga} -> ${nova}`);
    } catch {}
  }

  // Migração do historico legado (TEXT/JSON com conteúdo inválido: '',
  // 'null', JSON duplamente codificado, lixo) para JSONB saneado.
  // Tudo em UM único comando (DO block): funciona inclusive atrás do
  // pooler do Neon (PgBouncer), que não preserva objetos de sessão.
  await pool.query(`
    DO $mig$
    DECLARE
      coltype text;
      r record;
      v jsonb;
    BEGIN
      SELECT data_type INTO coltype
      FROM information_schema.columns
      WHERE table_name = 'ordens_servico' AND column_name = 'historico';

      IF coltype IS NOT NULL AND coltype <> 'jsonb' THEN
        RAISE NOTICE 'Migrando historico de % para jsonb', coltype;
        ALTER TABLE ordens_servico ALTER COLUMN historico DROP DEFAULT;
        ALTER TABLE ordens_servico ALTER COLUMN historico TYPE text USING historico::text;
        FOR r IN SELECT id, historico AS h FROM ordens_servico LOOP
          BEGIN
            v := r.h::jsonb;
          EXCEPTION WHEN others THEN
            v := '[]'::jsonb;
          END;
          IF v IS NULL THEN v := '[]'::jsonb; END IF;
          UPDATE ordens_servico SET historico = v::text WHERE id = r.id;
        END LOOP;
        ALTER TABLE ordens_servico ALTER COLUMN historico TYPE jsonb USING historico::jsonb;
        ALTER TABLE ordens_servico ALTER COLUMN historico SET DEFAULT '[]'::jsonb;
      END IF;

      -- desembrulha historico gravado como string JSON ('"[{...}]"')
      FOR r IN SELECT id, historico AS h FROM ordens_servico
               WHERE jsonb_typeof(historico) = 'string' LOOP
        BEGIN
          v := (r.h #>> '{}')::jsonb;
        EXCEPTION WHEN others THEN
          v := '[]'::jsonb;
        END;
        IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN v := '[]'::jsonb; END IF;
        UPDATE ordens_servico SET historico = v WHERE id = r.id;
      END LOOP;

      UPDATE ordens_servico SET historico = '[]'::jsonb
      WHERE historico IS NULL OR jsonb_typeof(historico) <> 'array';
    END
    $mig$
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_os_status ON ordens_servico (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_os_criado_em ON ordens_servico (criado_em DESC)`);

  console.log('Banco de dados pronto!');
}

// Próximo número sequencial do ano. Recebe um client para poder rodar
// dentro de uma transação (importação em lote).
async function gerarNumeroOS(client, ano = new Date().getFullYear()) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(split_part(numero, '-', 3), '')::int), 0) AS seq
     FROM ordens_servico WHERE numero LIKE $1`,
    [`OS-${ano}-%`]
  );
  return rows[0].seq + 1;
}

const fmtNumero = (ano, seq) => `OS-${ano}-${String(seq).padStart(4, '0')}`;

// historico pode vir como array (jsonb), string JSON ou até string
// duplamente codificada em bases legadas — nunca deixa quebrar a resposta
function parseHistorico(v) {
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? v : [];
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
    historico: parseHistorico(r.historico),
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em, concluidoEm: r.concluido_em,
  };
}

app.get('/api/ping', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, mensagem: 'Conectado!' }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/proximo-numero', async (req, res) => {
  try {
    const ano = new Date().getFullYear();
    res.json({ numero: fmtNumero(ano, await gerarNumeroOS(pool, ano)) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, numero, tipo, descricao, endereco, bairro, referencia,
             solicitante, responsavel, equipe, prioridade, prazo, status,
             (foto_abertura  IS NOT NULL AND foto_abertura  <> '') AS tem_abertura,
             (foto_conclusao IS NOT NULL AND foto_conclusao <> '') AS tem_conclusao,
             historico, criado_em, atualizado_em, concluido_em
      FROM ordens_servico ORDER BY criado_em DESC
    `);
    res.json(rows.map(r => ({
      ...mapRow(r, false),
      temFotoAbertura: !!r.tem_abertura,
      temFotoConclusao: !!r.tem_conclusao,
    })));
  } catch (e) { console.error('GET /api/ordens:', e.message); res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Nao encontrada' });
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('GET /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

const COLUNAS_INSERT = `
  id, numero, tipo, descricao, endereco, bairro, referencia,
  solicitante, responsavel, equipe, prioridade, prazo, status,
  foto_abertura, historico, criado_em`;

function valoresInsert(o, numero, criadoEm) {
  const data = criadoEm || new Date().toISOString();
  const historico = JSON.stringify([{
    status: 'aberta', data, obs: o.obsAbertura || 'Ordem de servico aberta',
  }]);
  return [
    uuidv4(), numero, o.tipo || '', o.descricao || '',
    o.endereco || '', o.bairro || '', o.referencia || '',
    o.solicitante, o.responsavel || '', o.equipe || '',
    o.prioridade || 'media', o.prazo || null, 'aberta',
    o.fotoAbertura || null, historico, data,
  ];
}

app.post('/api/ordens', async (req, res) => {
  const client = await pool.connect();
  try {
    const o = req.body;
    if (!o.solicitante || !String(o.solicitante).trim()) {
      return res.status(400).json({ erro: 'Solicitante é obrigatório' });
    }
    await client.query('BEGIN');
    await client.query('LOCK TABLE ordens_servico IN SHARE ROW EXCLUSIVE MODE');
    const ano = new Date().getFullYear();
    const numero = fmtNumero(ano, await gerarNumeroOS(client, ano));
    const { rows } = await client.query(
      `INSERT INTO ordens_servico (${COLUNAS_INSERT})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      valoresInsert(o, numero)
    );
    await client.query('COMMIT');
    res.json(mapRow(rows[0], true));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/ordens:', e.message);
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

// Importação em lote (CSV processado no frontend)
app.post('/api/ordens/importar', async (req, res) => {
  const lista = req.body && req.body.ordens;
  if (!Array.isArray(lista) || !lista.length) {
    return res.status(400).json({ erro: 'Envie { ordens: [...] } com pelo menos 1 item' });
  }
  if (lista.length > 2000) {
    return res.status(400).json({ erro: 'Máximo de 2000 ordens por importação' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE ordens_servico IN SHARE ROW EXCLUSIVE MODE');
    const ano = new Date().getFullYear();
    let seq = await gerarNumeroOS(client, ano);

    const numeros = [];
    for (const o of lista) {
      if (!o.endereco && !o.descricao) continue; // linha vazia/inútil
      const numero = fmtNumero(ano, seq++);
      const item = {
        ...o,
        solicitante: (o.solicitante && String(o.solicitante).trim()) || 'Importação CSV',
        obsAbertura: 'Importada via CSV',
      };
      const criadoEm = validarData(o.criadoEm);
      await client.query(
        `INSERT INTO ordens_servico (${COLUNAS_INSERT})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        valoresInsert(item, numero, criadoEm)
      );
      numeros.push(numero);
    }

    await client.query('COMMIT');
    res.json({ ok: true, importadas: numeros.length, ignoradas: lista.length - numeros.length, numeros });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/ordens/importar:', e.message);
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

function validarData(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

app.put('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const o = req.body;
    const atual = await pool.query('SELECT foto_abertura, foto_conclusao FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Nao encontrada' });
    const fotoAbertura  = o.fotoAbertura  !== undefined ? o.fotoAbertura  : atual.rows[0].foto_abertura;
    const fotoConclusao = o.fotoConclusao !== undefined ? o.fotoConclusao : atual.rows[0].foto_conclusao;
    const { rows } = await pool.query(
      `UPDATE ordens_servico SET
         status = $1, responsavel = $2, equipe = $3, historico = $4,
         foto_abertura = $5, foto_conclusao = $6,
         atualizado_em = NOW(), concluido_em = $7
       WHERE id = $8 RETURNING *`,
      [o.status, o.responsavel || '', o.equipe || '', JSON.stringify(o.historico || []),
       fotoAbertura, fotoConclusao, o.concluidoEm || null, id]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('PUT /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

app.delete('/api/ordens/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ordens_servico WHERE id = $1', [req.params.id]);
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
