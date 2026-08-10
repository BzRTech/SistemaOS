require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'sistema-os-dev-secret-altere-em-producao';
const JWT_EXPIRY = '8h';

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
      ocorrencias     INTEGER DEFAULT 1,
      primeira_ocorrencia DATE,
      tag             TEXT DEFAULT '',
      foto_abertura   TEXT,
      foto_conclusao  TEXT,
      historico       JSONB DEFAULT '[]',
      criado_em       TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em   TIMESTAMPTZ DEFAULT NOW(),
      concluido_em    TIMESTAMPTZ
    )
  `);

  // Migração: colunas novas em bancos existentes
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS ocorrencias INTEGER DEFAULT 1`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS primeira_ocorrencia DATE`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tag TEXT DEFAULT ''`);

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
      -- Fotos no esquema antigo eram arrays JSONB (fotos_abertura etc.);
      -- converte para TEXT preservando a primeira foto
      FOR r IN
        SELECT attname AS col, format_type(atttypid, atttypmod) AS tipo
        FROM pg_attribute
        WHERE attrelid = 'ordens_servico'::regclass
          AND attname IN ('foto_abertura', 'foto_conclusao')
          AND NOT attisdropped
          AND format_type(atttypid, atttypmod) IN ('json', 'jsonb')
      LOOP
        RAISE NOTICE 'Migrando % de % para text', r.col, r.tipo;
        EXECUTE format('ALTER TABLE ordens_servico ALTER COLUMN %I DROP DEFAULT', r.col);
        EXECUTE format(
          'ALTER TABLE ordens_servico ALTER COLUMN %I TYPE text USING (
             CASE
               WHEN %I IS NULL THEN NULL
               WHEN jsonb_typeof(%I::jsonb) = ''array''  THEN %I::jsonb ->> 0
               WHEN jsonb_typeof(%I::jsonb) = ''string'' THEN %I::jsonb #>> ''{}''
               ELSE NULL
             END)',
          r.col, r.col, r.col, r.col, r.col, r.col);
      END LOOP;

      SELECT format_type(atttypid, atttypmod) INTO coltype
      FROM pg_attribute
      WHERE attrelid = 'ordens_servico'::regclass
        AND attname = 'historico' AND NOT attisdropped;

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

  // Buracos do Waze (BigQuery) persistidos no Neon: acumula histórico além
  // da janela de 7 dias do BigQuery. Chave natural = coordenada + data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waze_buracos (
      coordenadas     TEXT NOT NULL,
      data            DATE NOT NULL,
      lat             DOUBLE PRECISION,
      lon             DOUBLE PRECISION,
      rua             TEXT,
      relatos         INTEGER DEFAULT 0,
      confirmacoes    INTEGER DEFAULT 0,
      score           INTEGER DEFAULT 0,
      sincronizado_em TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (coordenadas, data)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_waze_data ON waze_buracos (data DESC)`);

  // Tabela de usuários do sistema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id            TEXT PRIMARY KEY,
      nome          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      senha_hash    TEXT NOT NULL,
      perfil        TEXT NOT NULL DEFAULT 'operador',
      ativo         BOOLEAN NOT NULL DEFAULT true,
      criado_em     TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Cria o admin padrão se não houver nenhum usuário cadastrado
  const { rows: contagemUsuarios } = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (contagemUsuarios[0].n === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@infraestrutura.pmjp.pb.gov.br';
    const adminSenha = process.env.ADMIN_SENHA || 'Infra@2025';
    const adminNome  = process.env.ADMIN_NOME  || 'Administrador';
    const hash = await bcrypt.hash(adminSenha, 12);
    await pool.query(
      `INSERT INTO usuarios (id, nome, email, senha_hash, perfil) VALUES ($1, $2, $3, $4, 'admin')`,
      [uuidv4(), adminNome, adminEmail, hash]
    );
    console.log(`Usuário admin criado: ${adminEmail}`);
    console.log('ATENÇÃO: altere a senha padrão via ADMIN_SENHA ou pelo painel de usuários.');
  }

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

// fotos: a coluna TEXT guarda um data URI único (legado) ou um array JSON
// de data URIs (várias fotos). Sempre devolve array.
function parseFotos(v) {
  if (!v) return [];
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(Boolean) : []; }
    catch { return []; }
  }
  return [v];
}

// normaliza para gravação: 0 fotos → NULL, 1 → texto puro, 2+ → JSON
function serializarFotos(v) {
  const fotos = Array.isArray(v) ? v.filter(Boolean) : parseFotos(v);
  if (!fotos.length) return null;
  return fotos.length === 1 ? fotos[0] : JSON.stringify(fotos);
}

function mapRow(r, incluirFotos) {
  const fotosAbertura = parseFotos(r.foto_abertura);
  const fotosConclusao = parseFotos(r.foto_conclusao);
  return {
    id: r.id, numero: r.numero, tipo: r.tipo, descricao: r.descricao,
    endereco: r.endereco, bairro: r.bairro, referencia: r.referencia,
    solicitante: r.solicitante, responsavel: r.responsavel, equipe: r.equipe,
    prioridade: r.prioridade, prazo: r.prazo, status: r.status,
    ocorrencias: r.ocorrencias || 1,
    primeiraOcorrencia: r.primeira_ocorrencia,
    tag: r.tag || '',
    temFotoAbertura: fotosAbertura.length > 0,
    temFotoConclusao: fotosConclusao.length > 0,
    fotoAbertura: incluirFotos ? (fotosAbertura[0] || null) : undefined,
    fotosAbertura: incluirFotos ? fotosAbertura : undefined,
    fotoConclusao: incluirFotos ? (fotosConclusao[0] || null) : undefined,
    historico: parseHistorico(r.historico),
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em, concluidoEm: r.concluido_em,
  };
}

// ─── Autenticação ─────────────────────────────────────────────────────────────

function autenticar(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Autenticação necessária' });
  }
  try {
    req.usuario = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido ou expirado. Faça login novamente.' });
  }
}

function exigirPerfil(...perfis) {
  return (req, res, next) => {
    if (!req.usuario || !perfis.includes(req.usuario.perfil)) {
      return res.status(403).json({ erro: 'Permissão insuficiente para esta ação' });
    }
    next();
  };
}

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [String(email).toLowerCase().trim()]
    );
    if (!rows.length) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
    }
    const user = rows[0];
    if (!user.ativo) {
      return res.status(401).json({ erro: 'Conta desativada. Contate o administrador.' });
    }
    const senhaCorreta = await bcrypt.compare(String(senha), user.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
    }
    const payload = { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ ok: true, token, usuario: payload });
  } catch (e) {
    console.error('POST /api/auth/login:', e.message);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

app.get('/api/auth/me', autenticar, (req, res) => {
  res.json({ ok: true, usuario: req.usuario });
});

// ─── Gestão de usuários (somente admin) ────────────────────────────────────────

app.get('/api/usuarios', autenticar, exigirPerfil('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome, email, perfil, ativo, criado_em FROM usuarios ORDER BY criado_em'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/usuarios', autenticar, exigirPerfil('admin'), async (req, res) => {
  const { nome, email, senha, perfil } = req.body || {};
  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });
  }
  const perfis = ['admin', 'operador', 'visualizador'];
  const perfilFinal = perfis.includes(perfil) ? perfil : 'operador';
  try {
    const hash = await bcrypt.hash(String(senha), 12);
    const { rows } = await pool.query(
      `INSERT INTO usuarios (id, nome, email, senha_hash, perfil)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, perfil, ativo, criado_em`,
      [uuidv4(), String(nome).trim(), String(email).toLowerCase().trim(), hash, perfilFinal]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'E-mail já cadastrado' });
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/usuarios/:id', autenticar, exigirPerfil('admin'), async (req, res) => {
  const { id } = req.params;
  const { nome, email, senha, perfil, ativo } = req.body || {};
  try {
    const { rows: cur } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (!cur.length) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const senhaHash = senha ? await bcrypt.hash(String(senha), 12) : cur[0].senha_hash;
    const perfis = ['admin', 'operador', 'visualizador'];
    const perfilFinal = perfis.includes(perfil) ? perfil : cur[0].perfil;

    const { rows } = await pool.query(
      `UPDATE usuarios SET nome=$1, email=$2, senha_hash=$3, perfil=$4, ativo=$5, atualizado_em=NOW()
       WHERE id=$6
       RETURNING id, nome, email, perfil, ativo, criado_em`,
      [
        nome ? String(nome).trim() : cur[0].nome,
        email ? String(email).toLowerCase().trim() : cur[0].email,
        senhaHash,
        perfilFinal,
        ativo !== undefined ? Boolean(ativo) : cur[0].ativo,
        id,
      ]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'E-mail já cadastrado' });
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/usuarios/:id', autenticar, exigirPerfil('admin'), async (req, res) => {
  const { id } = req.params;
  if (id === req.usuario.id) {
    return res.status(400).json({ erro: 'Você não pode excluir sua própria conta' });
  }
  try {
    const result = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    if (!result.rowCount) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── Rotas públicas e protegidas ──────────────────────────────────────────────

app.get('/api/ping', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, mensagem: 'Conectado!' }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Inspeção do esquema real do banco (depuração de produção)
app.get('/api/diagnostico', autenticar, exigirPerfil('admin'), async (req, res) => {
  try {
    const colunas = await pool.query(`
      SELECT attname AS coluna, format_type(atttypid, atttypmod) AS tipo
      FROM pg_attribute
      WHERE attrelid = 'ordens_servico'::regclass AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum
    `);
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM ordens_servico');
    res.json({ ok: true, totalOrdens: total.rows[0].n, colunas: colunas.rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/proximo-numero', autenticar, async (req, res) => {
  try {
    const ano = new Date().getFullYear();
    res.json({ numero: fmtNumero(ano, await gerarNumeroOS(pool, ano)) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens', autenticar, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, numero, tipo, descricao, endereco, bairro, referencia,
             solicitante, responsavel, equipe, prioridade, prazo, status,
             ocorrencias, primeira_ocorrencia, tag,
             (foto_abertura  IS NOT NULL AND foto_abertura::text  NOT IN ('', '[]')) AS tem_abertura,
             (foto_conclusao IS NOT NULL AND foto_conclusao::text NOT IN ('', '[]')) AS tem_conclusao,
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

app.get('/api/ordens/:id', autenticar, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Nao encontrada' });
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('GET /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

const COLUNAS_INSERT = `
  id, numero, tipo, descricao, endereco, bairro, referencia,
  solicitante, responsavel, equipe, prioridade, prazo, status,
  ocorrencias, primeira_ocorrencia, tag, foto_abertura, historico, criado_em`;

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
    Math.max(1, parseInt(o.ocorrencias, 10) || 1),
    validarData(o.primeiraOcorrencia) ? o.primeiraOcorrencia : null,
    (o.tag || '').toString().trim().slice(0, 40),
    serializarFotos(o.fotoAbertura), historico, data,
  ];
}

app.post('/api/ordens', autenticar, exigirPerfil('admin', 'operador'), async (req, res) => {
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
    const vals = valoresInsert(o, numero);
    const { rows } = await client.query(
      `INSERT INTO ordens_servico (${COLUNAS_INSERT})
       VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')})
       RETURNING *`,
      vals
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
app.post('/api/ordens/importar', autenticar, exigirPerfil('admin', 'operador'), async (req, res) => {
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

    const validas = lista.filter(o => o.endereco || o.descricao); // descarta linha vazia
    const numeros = [];
    // inserção em lotes: 868 linhas viram ~9 round-trips ao banco em vez de 868
    const LOTE = 100;
    for (let i = 0; i < validas.length; i += LOTE) {
      const chunk = validas.slice(i, i + LOTE);
      const params = [];
      const tuplas = chunk.map(o => {
        const numero = fmtNumero(ano, seq++);
        numeros.push(numero);
        const item = {
          ...o,
          solicitante: (o.solicitante && String(o.solicitante).trim()) || 'Importação CSV',
          obsAbertura: 'Importada via CSV' + (o.tag ? ` — ${String(o.tag).trim()}` : ''),
        };
        const vals = valoresInsert(item, numero, validarData(o.criadoEm));
        const base = params.length;
        params.push(...vals);
        return '(' + vals.map((_, k) => '$' + (base + k + 1)).join(',') + ')';
      });
      await client.query(
        `INSERT INTO ordens_servico (${COLUNAS_INSERT}) VALUES ${tuplas.join(',')}`,
        params
      );
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

app.put('/api/ordens/:id', autenticar, exigirPerfil('admin', 'operador'), async (req, res) => {
  try {
    const { id } = req.params;
    const o = req.body;
    const atual = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Nao encontrada' });
    const cur = atual.rows[0];
    const manter = (novo, antigo) => (novo !== undefined ? novo : antigo);
    const fotoAbertura  = o.fotoAbertura  !== undefined ? serializarFotos(o.fotoAbertura)  : cur.foto_abertura;
    const fotoConclusao = o.fotoConclusao !== undefined ? serializarFotos(o.fotoConclusao) : cur.foto_conclusao;
    const { rows } = await pool.query(
      `UPDATE ordens_servico SET
         status = $1, responsavel = $2, equipe = $3, historico = $4,
         foto_abertura = $5, foto_conclusao = $6, bairro = $7, referencia = $8,
         tipo = $9, descricao = $10, endereco = $11, solicitante = $12,
         prioridade = $13, prazo = $14,
         atualizado_em = NOW(), concluido_em = $15
       WHERE id = $16 RETURNING *`,
      [manter(o.status, cur.status), manter(o.responsavel, cur.responsavel),
       manter(o.equipe, cur.equipe),
       o.historico !== undefined ? JSON.stringify(o.historico) : JSON.stringify(cur.historico),
       fotoAbertura, fotoConclusao,
       manter(o.bairro, cur.bairro), manter(o.referencia, cur.referencia),
       manter(o.tipo, cur.tipo), manter(o.descricao, cur.descricao),
       manter(o.endereco, cur.endereco),
       o.solicitante !== undefined ? (o.solicitante || cur.solicitante) : cur.solicitante,
       manter(o.prioridade, cur.prioridade),
       o.prazo !== undefined ? (o.prazo || null) : cur.prazo,
       manter(o.concluidoEm, cur.concluido_em), id]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('PUT /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

app.delete('/api/ordens/:id', autenticar, exigirPerfil('admin', 'operador'), async (req, res) => {
  try {
    await pool.query('DELETE FROM ordens_servico WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

// ─── Waze / BigQuery ──────────────────────────────────────────────────────────
// Configure via env vars: WAZE_BQ_PROJECT, WAZE_BQ_DATASET, WAZE_BQ_TABLE, WAZE_BQ_LOCATION
const BQ_PROJECT  = process.env.WAZE_BQ_PROJECT  || 'testes-waze';
const BQ_DATASET  = process.env.WAZE_BQ_DATASET  || '';
const BQ_TABLE    = process.env.WAZE_BQ_TABLE    || '';
const BQ_LOCATION = process.env.WAZE_BQ_LOCATION || 'US';

// Token OAuth (expira a cada ~1h; renovar via POST /api/waze/token)
let wazeToken = process.env.WAZE_TOKEN || '';

function bqQuery(sql, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 30000,
      location: BQ_LOCATION,
      queryParameters: params || [],
    });
    const req = https.request({
      hostname: 'bigquery.googleapis.com',
      path: `/bigquery/v2/projects/${BQ_PROJECT}/queries`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${wazeToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ httpStatus: res.statusCode, data: JSON.parse(d) }); }
        catch { reject(new Error('Resposta inválida do BigQuery')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Busca TODOS os buracos do BigQuery e faz upsert no Neon. Acumula histórico:
// dias novos são inseridos, dias já existentes têm os números atualizados.
async function sincronizarBuracos() {
  if (!BQ_DATASET || !BQ_TABLE) {
    throw new Error('Tabela BigQuery não configurada. Defina WAZE_BQ_DATASET e WAZE_BQ_TABLE nas variáveis de ambiente.');
  }

  const sql = `
    SELECT clmn1_ AS coordenadas, clmn2_ AS data,
           COALESCE(clmn4_, '') AS rua,
           CAST(t0_qt_fvgeseri4d AS INT64) AS relatos,
           CAST(t0_qt_jtzijkri4d AS INT64) AS confirmacoes,
           CAST(clmn0_           AS INT64) AS score
    FROM \`${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}\`
    WHERE clmn1_ IS NOT NULL AND clmn2_ IS NOT NULL
    ORDER BY clmn2_ DESC
    LIMIT 50000`;

  const { data } = await bqQuery(sql, []);
  if (data.error) {
    const e = new Error(data.error.message || 'Erro no BigQuery');
    e.code = data.error.code;
    throw e;
  }

  const cols = (data.schema?.fields || []).map(f => f.name);
  const linhas = (data.rows || []).map(row => {
    const v = Object.fromEntries(cols.map((c, i) => [c, row.f[i].v]));
    const parts = v.coordenadas ? String(v.coordenadas).split(',') : [];
    const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    return {
      coordenadas:  v.coordenadas || '',
      data:         v.data || null,
      lat:          isNaN(lat) ? null : lat,
      lon:          isNaN(lon) ? null : lon,
      rua:          v.rua || '',
      relatos:      parseInt(v.relatos)      || 0,
      confirmacoes: parseInt(v.confirmacoes) || 0,
      score:        parseInt(v.score)        || 0,
    };
  }).filter(l => l.coordenadas && l.data);

  let gravados = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < linhas.length; i += 500) {
      const lote = linhas.slice(i, i + 500);
      const vals = [];
      const ph = lote.map((l, k) => {
        const b = k * 8;
        vals.push(l.coordenadas, l.data, l.lat, l.lon, l.rua, l.relatos, l.confirmacoes, l.score);
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
      }).join(',');
      await client.query(`
        INSERT INTO waze_buracos (coordenadas, data, lat, lon, rua, relatos, confirmacoes, score)
        VALUES ${ph}
        ON CONFLICT (coordenadas, data) DO UPDATE SET
          lat = EXCLUDED.lat, lon = EXCLUDED.lon, rua = EXCLUDED.rua,
          relatos = EXCLUDED.relatos, confirmacoes = EXCLUDED.confirmacoes,
          score = EXCLUDED.score, sincronizado_em = NOW()
      `, vals);
      gravados += lote.length;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM waze_buracos');
  return { gravados, totalBanco: rows[0].total, sincronizadoEm: new Date().toISOString() };
}

// Recebe o token, sincroniza o BigQuery → Neon e devolve o resultado.
// O token é usado apenas para esta sincronização; os dados ficam no banco.
app.post('/api/waze/token', autenticar, exigirPerfil('admin'), async (req, res) => {
  const { token } = req.body;
  if (!token || !String(token).trim())
    return res.status(400).json({ erro: 'Token obrigatório' });
  wazeToken = String(token).trim();
  console.log('Waze token atualizado em', new Date().toISOString());

  try {
    const r = await sincronizarBuracos();
    console.log(`Waze: ${r.gravados} registros sincronizados (${r.totalBanco} no banco)`);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('Sincronização Waze falhou:', e.message);
    if (e.code === 401 || e.code === 403)
      return res.status(401).json({ erro: 'Token inválido ou expirado', tokenExpirado: true });
    res.status(500).json({ erro: 'Token salvo, mas a sincronização falhou: ' + e.message });
  }
});

// Retorna a configuração BigQuery atual (sem expor o token).
app.get('/api/waze/config', (req, res) => {
  res.json({
    projeto:  BQ_PROJECT,
    dataset:  BQ_DATASET  || null,
    tabela:   BQ_TABLE    || null,
    location: BQ_LOCATION,
    configurado: !!(BQ_DATASET && BQ_TABLE),
  });
});

// Explora o BigQuery com um token para listar projetos → datasets → tabelas.
// Útil para descobrir o ID correto da tabela quando o projeto não tem datasets visíveis.
app.post('/api/waze/explorar', autenticar, exigirPerfil('admin'), async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ erro: 'Token obrigatório' });

  function bqGet(path, tok) {
    return new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'bigquery.googleapis.com',
        path,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${tok}` },
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Resposta inválida')); } });
      });
      req2.on('error', reject);
      req2.end();
    });
  }

  try {
    const tk = String(token).trim();

    // 1. Lista projetos
    const projData = await bqGet('/bigquery/v2/projects?maxResults=50', tk);
    const projetos = (projData.projects || []).map(p => p.id);

    const resultado = [];
    for (const proj of projetos) {
      const dsData = await bqGet(`/bigquery/v2/projects/${proj}/datasets?all=true&maxResults=100`, tk);
      const datasets = dsData.datasets || [];
      const dsList = [];

      for (const ds of datasets) {
        const dsId = ds.datasetReference.datasetId;
        if (dsId.startsWith('_')) continue; // ignora anônimos
        const tbData = await bqGet(`/bigquery/v2/projects/${proj}/datasets/${dsId}/tables?maxResults=100`, tk);
        const tabelas = (tbData.tables || []).map(t => ({
          tabela:   t.tableReference.tableId,
          tipo:     t.type,
          linhas:   t.numRows ? parseInt(t.numRows).toLocaleString('pt-BR') : '?',
          fullId:   `${proj}.${dsId}.${t.tableReference.tableId}`,
        }));
        dsList.push({ dataset: dsId, tabelas });
      }
      if (dsList.length) resultado.push({ projeto: proj, datasets: dsList });
    }

    res.json({ ok: true, resultado, projetos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Lê os buracos do banco (Neon) com os filtros — não depende do token.
app.get('/api/waze/buracos', autenticar, async (req, res) => {
  const validDate = v => v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null;
  const di  = validDate(req.query.dataInicio);
  const df  = validDate(req.query.dataFim);
  const mr  = Math.max(1, parseInt(req.query.minRelatos) || 1);
  const rua = req.query.rua
    ? String(req.query.rua).replace(/['"\\;%]/g, '').trim().slice(0, 100)
    : null;

  const conds  = ['relatos >= $1'];
  const params = [mr];
  if (di)  { params.push(di);  conds.push(`data >= $${params.length}`); }
  if (df)  { params.push(df);  conds.push(`data <= $${params.length}`); }
  if (rua) { params.push(`%${rua}%`); conds.push(`LOWER(COALESCE(rua, '')) LIKE LOWER($${params.length})`); }

  try {
    const { rows } = await pool.query(`
      SELECT coordenadas, lat, lon, to_char(data, 'YYYY-MM-DD') AS data,
             rua, relatos, confirmacoes, score
      FROM waze_buracos
      WHERE ${conds.join(' AND ')}
      ORDER BY data DESC, relatos DESC
      LIMIT 20000
    `, params);

    const dados = rows.map(r => ({
      coordenadas:  r.coordenadas || '',
      lat:          r.lat,
      lon:          r.lon,
      data:         r.data || '',
      rua:          r.rua || '',
      relatos:      r.relatos || 0,
      confirmacoes: r.confirmacoes || 0,
      score:        r.score || 0,
    }));

    const { rows: meta } = await pool.query(
      'SELECT MAX(sincronizado_em) AS ultima, COUNT(*)::int AS total FROM waze_buracos'
    );

    res.json({
      ok: true, total: dados.length, dados,
      sincronizadoEm: meta[0].ultima,
      totalBanco: meta[0].total,
      bancoVazio: meta[0].total === 0,
    });
  } catch (e) {
    console.error('GET /api/waze/buracos:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
// ─── fim Waze ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
iniciarBanco().then(() => {
  app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
}).catch(err => {
  console.error('Erro ao conectar no banco:', err.message);
  process.exit(1);
});
