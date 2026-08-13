require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

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

const JWT_SECRET = process.env.JWT_SECRET || 'mude-isso-em-producao-defina-JWT_SECRET';
const JWT_EXPIRY = '8h';

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const PERFIS_VALIDOS = ['admin', 'seinfra', 'goldman', 'equipe'];
// Empresas são dinâmicas (cadastradas via usuários goldman). Equipes são os 6 slots por empresa.
const EQUIPES_VALIDAS = ['Equipe 1', 'Equipe 2', 'Equipe 3', 'Equipe 4', 'Equipe 5', 'Equipe 6'];
const STATUS_VALIDOS = ['aberta', 'encaminhada', 'direcionada', 'em_execucao', 'aguardando_validacao', 'fechada', 'reaberta'];

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
      solicitante     TEXT,
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

  // Migração: novas colunas de workflow
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS empresa_designada TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS equipe_designada TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS foto_inicio TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS foto_fim TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS gps_inicio TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS gps_fim TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS data_inicio_servico TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS data_fim_servico TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS validado_por TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS validado_em TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS motivo_rejeicao TEXT`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS data_solicitacao DATE`);
  await pool.query(`ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS fotos_pdf TEXT`);

  // Migração: remover NOT NULL de solicitante (para compatibilidade)
  try {
    await pool.query(`ALTER TABLE ordens_servico ALTER COLUMN solicitante DROP NOT NULL`);
  } catch {}

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

  // ── Tabela de usuários ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id            TEXT PRIMARY KEY,
      nome          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      senha_hash    TEXT NOT NULL,
      perfil        TEXT NOT NULL DEFAULT 'goldman'
                    CHECK (perfil IN ('admin', 'seinfra', 'goldman', 'equipe')),
      equipe_nome   TEXT,
      ativo         BOOLEAN NOT NULL DEFAULT true,
      criado_em     TIMESTAMPTZ DEFAULT NOW(),
      ultimo_acesso TIMESTAMPTZ
    )
  `);

  // Migração: remove constraints CHECK antigas incondicionalmente
  await pool.query(`
    DO $drop_ck$
    BEGIN
      ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check;
    EXCEPTION WHEN others THEN NULL;
    END $drop_ck$
  `);
  await pool.query(`
    DO $drop_ck2$
    BEGIN
      ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
    EXCEPTION WHEN others THEN NULL;
    END $drop_ck2$
  `);

  // Migração: coluna 'role' -> 'perfil' e novos valores
  await pool.query(`
    DO $mig_usr$
    DECLARE
      col_exists boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'usuarios'::regclass
          AND attname = 'role' AND NOT attisdropped
      ) INTO col_exists;

      IF col_exists THEN
        UPDATE usuarios SET role = 'admin' WHERE role = 'empresa';
        UPDATE usuarios SET role = 'goldman' WHERE role IN ('operador', 'coordenador');
        UPDATE usuarios SET role = 'equipe' WHERE role = 'visualizador';

        BEGIN
          ALTER TABLE usuarios RENAME COLUMN role TO perfil;
        EXCEPTION WHEN others THEN NULL;
        END;
      END IF;

      -- Migra perfis antigos para novos (caso a coluna ja seja 'perfil')
      UPDATE usuarios SET perfil = 'goldman' WHERE perfil IN ('operador', 'coordenador');
      UPDATE usuarios SET perfil = 'equipe'  WHERE perfil = 'visualizador';
    END
    $mig_usr$
  `);

  // Migração: adicionar coluna equipe_nome se não existir
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS equipe_nome TEXT`);
  // Migração: adicionar coluna empresa para vincular equipe à empresa
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa TEXT`);

  // Cria o primeiro usuário (admin) se o banco estiver vazio
  const { rows: semUsuarios } = await pool.query('SELECT id FROM usuarios LIMIT 1');
  if (!semUsuarios.length) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@sistema.local';
    const adminSenha = process.env.ADMIN_SENHA || 'admin123';
    const hash = await bcrypt.hash(adminSenha, 12);
    await pool.query(
      `INSERT INTO usuarios (id, nome, email, senha_hash, perfil)
       VALUES ($1, 'Administrador', $2, $3, 'admin')`,
      [uuidv4(), adminEmail, hash]
    );
    console.log(`Usuário inicial criado — email: ${adminEmail}`);
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_SENHA) {
      console.warn('⚠  Defina ADMIN_EMAIL e ADMIN_SENHA nas variáveis de ambiente!');
    }
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

// EXIF entrega data/hora como "YYYY:MM:DD HH:MM:SS" — os dois-pontos na data
// não são aceitos pelo Postgres. Converte para um timestamp ISO válido.
function normalizarDataHora(dh) {
  if (!dh) return null;
  const s = String(dh).trim();
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
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
    // Novos campos de workflow
    empresaDesignada: r.empresa_designada || null,
    equipeDesignada: r.equipe_designada || null,
    fotoInicio: incluirFotos ? (r.foto_inicio || null) : undefined,
    fotoFim: incluirFotos ? (r.foto_fim || null) : undefined,
    gpsInicio: r.gps_inicio || null,
    gpsFim: r.gps_fim || null,
    dataInicioServico: r.data_inicio_servico || null,
    dataFimServico: r.data_fim_servico || null,
    validadoPor: r.validado_por || null,
    validadoEm: r.validado_em || null,
    motivoRejeicao: r.motivo_rejeicao || null,
    dataSolicitacao: r.data_solicitacao || null,
    fotosPdf: incluirFotos ? parseFotos(r.fotos_pdf) : undefined,
  };
}

// ─── Auth / usuários ───────────────────────────────────────────────────────────
function autenticar(papeis) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ erro: 'Não autenticado' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const { rows } = await pool.query(
        'SELECT id, nome, email, perfil, equipe_nome, empresa, ativo FROM usuarios WHERE id = $1',
        [payload.sub]
      );
      if (!rows.length || !rows[0].ativo)
        return res.status(401).json({ erro: 'Usuário inválido ou inativo' });
      req.usuario = rows[0];
      if (papeis && papeis.length && !papeis.includes(rows[0].perfil))
        return res.status(403).json({ erro: 'Sem permissão para esta operação' });
      next();
    } catch {
      res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
  };
}
const qualquerUsuario = autenticar([]);
const somenteAdmin   = autenticar(['admin']);
const adminOuSeinfra = autenticar(['admin', 'seinfra']);
const adminOuGoldman = autenticar(['admin', 'goldman']);
const adminOuEquipe  = autenticar(['admin', 'equipe']);

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [String(email).toLowerCase().trim()]
    );
    const u = rows[0];
    if (!u || !u.ativo) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const ok = await bcrypt.compare(String(senha), u.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });
    await pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [u.id]);
    const payload = { sub: u.id, perfil: u.perfil };
    if (u.equipe_nome) payload.equipe_nome = u.equipe_nome;
    if (u.empresa) payload.empresa = u.empresa;
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    const usuario = { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil };
    if (u.equipe_nome) usuario.equipe_nome = u.equipe_nome;
    if (u.empresa) usuario.empresa = u.empresa;
    res.json({ token, usuario });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Usuário atual
app.get('/api/auth/me', qualquerUsuario, (req, res) => {
  res.json({ usuario: req.usuario });
});

// Listar usuários (admin)
app.get('/api/auth/usuarios', somenteAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome, email, perfil, equipe_nome, empresa, ativo, criado_em, ultimo_acesso FROM usuarios ORDER BY criado_em'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar usuário (admin)
app.post('/api/auth/usuarios', somenteAdmin, async (req, res) => {
  const { nome, email, senha, perfil, equipe_nome, empresa } = req.body;
  if (!nome || !email || !senha || !perfil)
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, email, senha, perfil' });
  if (!PERFIS_VALIDOS.includes(perfil))
    return res.status(400).json({ erro: 'Perfil inválido' });
  if (perfil === 'equipe') {
    if (!equipe_nome || !EQUIPES_VALIDAS.includes(equipe_nome))
      return res.status(400).json({ erro: 'equipe_nome obrigatório para perfil equipe (Equipe 1 a Equipe 6)' });
    if (!empresa || !String(empresa).trim())
      return res.status(400).json({ erro: 'empresa obrigatória para perfil equipe' });
  }
  if (perfil === 'goldman' && (!empresa || !String(empresa).trim()))
    return res.status(400).json({ erro: 'empresa (nome da empresa) obrigatória para perfil goldman' });
  try {
    const hash = await bcrypt.hash(String(senha), 12);
    const eqNome = perfil === 'equipe' ? equipe_nome : null;
    const empNome = (perfil === 'equipe' || perfil === 'goldman') ? String(empresa).trim() : null;
    const { rows } = await pool.query(
      `INSERT INTO usuarios (id, nome, email, senha_hash, perfil, equipe_nome, empresa)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, email, perfil, equipe_nome, empresa, ativo, criado_em`,
      [uuidv4(), nome.trim(), String(email).toLowerCase().trim(), hash, perfil, eqNome, empNome]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: e.message });
  }
});

// Editar usuário (admin edita qualquer um; outros editam só a si mesmos)
app.put('/api/auth/usuarios/:id', qualquerUsuario, async (req, res) => {
  const { id } = req.params;
  const u = req.usuario;
  if (u.perfil !== 'admin' && u.id !== id)
    return res.status(403).json({ erro: 'Sem permissão' });
  const { nome, senha, perfil, equipe_nome, empresa, ativo } = req.body;
  try {
    const campos = [], vals = [];
    if (nome)  { vals.push(nome.trim()); campos.push(`nome = $${vals.length}`); }
    if (senha) { vals.push(await bcrypt.hash(String(senha), 12)); campos.push(`senha_hash = $${vals.length}`); }
    if (u.perfil === 'admin') {
      if (perfil !== undefined) {
        if (!PERFIS_VALIDOS.includes(perfil))
          return res.status(400).json({ erro: 'Perfil inválido' });
        vals.push(perfil); campos.push(`perfil = $${vals.length}`);
      }
      const perfilFinal = perfil !== undefined ? perfil : undefined;
      if (equipe_nome !== undefined || perfilFinal === 'equipe') {
        const eqNome = perfilFinal === 'equipe' ? (equipe_nome || null) : null;
        vals.push(eqNome); campos.push(`equipe_nome = $${vals.length}`);
      }
      if (empresa !== undefined || perfilFinal === 'equipe' || perfilFinal === 'goldman') {
        const empNome = (perfilFinal === 'equipe' || perfilFinal === 'goldman')
          ? (empresa ? String(empresa).trim() : null) : null;
        vals.push(empNome); campos.push(`empresa = $${vals.length}`);
      }
      if (ativo !== undefined) { vals.push(!!ativo); campos.push(`ativo = $${vals.length}`); }
    }
    if (!campos.length) return res.status(400).json({ erro: 'Nada para atualizar' });
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE usuarios SET ${campos.join(', ')} WHERE id = $${vals.length}
       RETURNING id, nome, email, perfil, equipe_nome, empresa, ativo`,
      vals
    );
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Desativar usuário (admin)
app.delete('/api/auth/usuarios/:id', somenteAdmin, async (req, res) => {
  if (req.params.id === req.usuario.id)
    return res.status(400).json({ erro: 'Não pode desativar a si mesmo' });
  try {
    await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/ping', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, mensagem: 'Conectado!' }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Inspeção do esquema real do banco (depuração de produção)
app.get('/api/diagnostico', somenteAdmin, async (req, res) => {
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

app.get('/api/proximo-numero', qualquerUsuario, async (req, res) => {
  try {
    const ano = new Date().getFullYear();
    res.json({ numero: fmtNumero(ano, await gerarNumeroOS(pool, ano)) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens', qualquerUsuario, async (req, res) => {
  try {
    let filtro = '';
    const params = [];
    if (req.usuario.perfil === 'equipe') {
      params.push(req.usuario.equipe_nome || '');
      params.push(req.usuario.empresa || '');
      filtro = `WHERE equipe_designada = $${params.length - 1} AND empresa_designada = $${params.length}`;
    } else if (req.usuario.perfil === 'goldman') {
      params.push(req.usuario.empresa || '');
      filtro = `WHERE empresa_designada = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT id, numero, tipo, descricao, endereco, bairro, referencia,
             solicitante, responsavel, equipe, prioridade, prazo, status,
             ocorrencias, primeira_ocorrencia, tag,
             empresa_designada, equipe_designada, gps_inicio, gps_fim,
             data_inicio_servico, data_fim_servico,
             validado_por, validado_em, motivo_rejeicao, data_solicitacao,
             (foto_abertura  IS NOT NULL AND foto_abertura::text  NOT IN ('', '[]')) AS tem_abertura,
             (foto_conclusao IS NOT NULL AND foto_conclusao::text NOT IN ('', '[]')) AS tem_conclusao,
             historico, criado_em, atualizado_em, concluido_em
      FROM ordens_servico ${filtro} ORDER BY criado_em DESC
    `, params);
    res.json(rows.map(r => ({
      ...mapRow(r, false),
      temFotoAbertura: !!r.tem_abertura,
      temFotoConclusao: !!r.tem_conclusao,
    })));
  } catch (e) { console.error('GET /api/ordens:', e.message); res.status(500).json({ erro: e.message }); }
});

app.get('/api/ordens/:id', qualquerUsuario, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Nao encontrada' });
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('GET /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

const COLUNAS_INSERT = `
  id, numero, tipo, descricao, endereco, bairro, referencia,
  solicitante, responsavel, equipe, prioridade, prazo, status,
  ocorrencias, primeira_ocorrencia, tag, foto_abertura, historico, criado_em, data_solicitacao,
  empresa_designada, equipe_designada, fotos_pdf`;

function valoresInsert(o, numero, criadoEm) {
  const data = criadoEm || new Date().toISOString();
  const historico = JSON.stringify([{
    status: 'aberta', data, obs: o.obsAbertura || 'Ordem de servico aberta',
  }]);
  return [
    uuidv4(), numero, o.tipo || '', o.descricao || '',
    o.endereco || '', o.bairro || '', o.referencia || '',
    o.solicitante || '', o.responsavel || '', o.equipe || '',
    o.prioridade || 'media', o.prazo || null, 'aberta',
    Math.max(1, parseInt(o.ocorrencias, 10) || 1),
    validarData(o.primeiraOcorrencia) ? o.primeiraOcorrencia : null,
    (o.tag || '').toString().trim().slice(0, 40),
    serializarFotos(o.fotoAbertura), historico, data,
    o.dataSolicitacao || o.data_solicitacao || null,
    o.empresaDesignada || o.empresa_designada || null,
    o.equipeDesignada || o.equipe_designada || null,
    serializarFotos(o.fotosPdf || o.fotos_pdf),
  ];
}

// Criar OS (admin e seinfra)
app.post('/api/ordens', adminOuSeinfra, async (req, res) => {
  const client = await pool.connect();
  try {
    const o = req.body;
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
app.post('/api/ordens/importar', adminOuSeinfra, async (req, res) => {
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

app.put('/api/ordens/:id', qualquerUsuario, async (req, res) => {
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
         atualizado_em = NOW(), concluido_em = $15,
         empresa_designada = $17, equipe_designada = $18
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
       manter(o.concluidoEm, cur.concluido_em), id,
       o.empresaDesignada !== undefined ? (o.empresaDesignada || null) : cur.empresa_designada,
       o.equipeDesignada !== undefined ? (o.equipeDesignada || null) : cur.equipe_designada]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('PUT /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

app.delete('/api/ordens/:id', adminOuSeinfra, async (req, res) => {
  try {
    await pool.query('DELETE FROM ordens_servico WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/ordens/:id:', e.message); res.status(500).json({ erro: e.message }); }
});

// ─── Workflow Endpoints ───────────────────────────────────────────────────────

// Direcionar OS para uma empresa (seinfra, admin) → status = encaminhada
app.post('/api/ordens/:id/direcionar', adminOuSeinfra, async (req, res) => {
  try {
    const { id } = req.params;
    const { empresa } = req.body;
    if (!empresa || !String(empresa).trim())
      return res.status(400).json({ erro: 'Empresa inválida' });
    // Valida contra as empresas realmente cadastradas
    const { rows: empRows } = await pool.query(
      `SELECT 1 FROM usuarios WHERE empresa = $1 AND ativo = true LIMIT 1`, [empresa]
    );
    if (!empRows.length)
      return res.status(400).json({ erro: 'Empresa não cadastrada no sistema' });

    const { rows: atual } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.length) return res.status(404).json({ erro: 'OS não encontrada' });

    const os = atual[0];
    const historico = parseHistorico(os.historico);
    historico.push({
      status: 'encaminhada',
      data: new Date().toISOString(),
      obs: `Direcionada para empresa ${empresa} por ${req.usuario.nome}`,
      usuario: req.usuario.id,
    });

    const { rows } = await pool.query(
      `UPDATE ordens_servico SET
         empresa_designada = $1, status = 'encaminhada',
         historico = $2, atualizado_em = NOW()
       WHERE id = $3 RETURNING *`,
      [empresa, JSON.stringify(historico), id]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('POST direcionar:', e.message); res.status(500).json({ erro: e.message }); }
});

// Encaminhar OS para uma equipe (goldman, admin) → status = direcionada
app.post('/api/ordens/:id/encaminhar', adminOuGoldman, async (req, res) => {
  try {
    const { id } = req.params;
    const { equipe } = req.body;
    if (!equipe || !EQUIPES_VALIDAS.includes(equipe))
      return res.status(400).json({ erro: 'Equipe inválida. Valores aceitos: Equipe 1 a Equipe 6' });

    const { rows: atual } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.length) return res.status(404).json({ erro: 'OS não encontrada' });

    const os = atual[0];
    // Goldman só encaminha OS da própria empresa e para equipes cadastradas nela
    const empresaOS = os.empresa_designada;
    if (req.usuario.perfil === 'goldman' && req.usuario.empresa && empresaOS && req.usuario.empresa !== empresaOS)
      return res.status(403).json({ erro: 'Esta OS pertence a outra empresa' });
    const { rows: eqRows } = await pool.query(
      `SELECT 1 FROM usuarios WHERE perfil = 'equipe' AND equipe_nome = $1 AND empresa = $2 AND ativo = true LIMIT 1`,
      [equipe, empresaOS]
    );
    if (!eqRows.length)
      return res.status(400).json({ erro: `${equipe} não está cadastrada para a empresa ${empresaOS || '(indefinida)'}` });

    const historico = parseHistorico(os.historico);
    historico.push({
      status: 'direcionada',
      data: new Date().toISOString(),
      obs: `Direcionada para ${equipe} por ${req.usuario.nome}`,
      usuario: req.usuario.id,
    });

    const { rows } = await pool.query(
      `UPDATE ordens_servico SET
         equipe_designada = $1, status = 'direcionada',
         historico = $2, atualizado_em = NOW()
       WHERE id = $3 RETURNING *`,
      [equipe, JSON.stringify(historico), id]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('POST encaminhar:', e.message); res.status(500).json({ erro: e.message }); }
});

// Registrar início de serviço (equipe, admin)
app.post('/api/ordens/:id/registrar-inicio', adminOuEquipe, async (req, res) => {
  try {
    const { id } = req.params;
    const { foto, gps, dataHora } = req.body;

    const { rows: atual } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.length) return res.status(404).json({ erro: 'OS não encontrada' });

    const os = atual[0];

    // Valida que a OS está designada para a equipe do usuário
    if (req.usuario.perfil === 'equipe' && os.equipe_designada !== req.usuario.equipe_nome)
      return res.status(403).json({ erro: 'Esta OS não está designada para sua equipe' });

    const historico = parseHistorico(os.historico);
    historico.push({
      status: 'em_execucao',
      data: new Date().toISOString(),
      obs: `Início de serviço registrado por ${req.usuario.nome}`,
      usuario: req.usuario.id,
    });

    const { rows } = await pool.query(
      `UPDATE ordens_servico SET
         foto_inicio = $1, gps_inicio = $2, data_inicio_servico = $3,
         status = 'em_execucao', historico = $4, atualizado_em = NOW()
       WHERE id = $5 RETURNING *`,
      [foto || null, gps || null, normalizarDataHora(dataHora), JSON.stringify(historico), id]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('POST registrar-inicio:', e.message); res.status(500).json({ erro: e.message }); }
});

// Registrar fim de serviço (equipe, admin)
app.post('/api/ordens/:id/registrar-fim', adminOuEquipe, async (req, res) => {
  try {
    const { id } = req.params;
    const { foto, gps, dataHora } = req.body;

    const { rows: atual } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.length) return res.status(404).json({ erro: 'OS não encontrada' });

    const os = atual[0];

    // Valida status e equipe
    if (os.status !== 'em_execucao')
      return res.status(400).json({ erro: 'OS precisa estar em execução para registrar fim' });
    if (req.usuario.perfil === 'equipe' && os.equipe_designada !== req.usuario.equipe_nome)
      return res.status(403).json({ erro: 'Esta OS não está designada para sua equipe' });

    const historico = parseHistorico(os.historico);
    historico.push({
      status: 'aguardando_validacao',
      data: new Date().toISOString(),
      obs: `Fim de serviço registrado por ${req.usuario.nome} — aguardando validação SEINFRA`,
      usuario: req.usuario.id,
    });

    const { rows } = await pool.query(
      `UPDATE ordens_servico SET
         foto_fim = $1, gps_fim = $2, data_fim_servico = $3,
         status = 'aguardando_validacao', historico = $4, atualizado_em = NOW()
       WHERE id = $5 RETURNING *`,
      [foto || null, gps || null, normalizarDataHora(dataHora), JSON.stringify(historico), id]
    );
    res.json(mapRow(rows[0], true));
  } catch (e) { console.error('POST registrar-fim:', e.message); res.status(500).json({ erro: e.message }); }
});

// Validar OS (seinfra, admin)
app.post('/api/ordens/:id/validar', adminOuSeinfra, async (req, res) => {
  try {
    const { id } = req.params;
    const { aceitar, motivo } = req.body;

    const { rows: atual } = await pool.query('SELECT * FROM ordens_servico WHERE id = $1', [id]);
    if (!atual.length) return res.status(404).json({ erro: 'OS não encontrada' });

    const os = atual[0];
    const historico = parseHistorico(os.historico);

    if (aceitar) {
      historico.push({
        status: 'fechada',
        data: new Date().toISOString(),
        obs: `OS validada e aceita por ${req.usuario.nome}`,
        usuario: req.usuario.id,
      });
      const { rows } = await pool.query(
        `UPDATE ordens_servico SET
           status = 'fechada', validado_por = $1, validado_em = NOW(),
           historico = $2, atualizado_em = NOW(), concluido_em = NOW()
         WHERE id = $3 RETURNING *`,
        [req.usuario.id, JSON.stringify(historico), id]
      );
      res.json(mapRow(rows[0], true));
    } else {
      const motivoRejeicao = motivo || 'Sem motivo informado';
      historico.push({
        status: 'reaberta',
        data: new Date().toISOString(),
        obs: `OS rejeitada por ${req.usuario.nome}: ${motivoRejeicao}`,
        usuario: req.usuario.id,
      });
      const { rows } = await pool.query(
        `UPDATE ordens_servico SET
           status = 'reaberta', motivo_rejeicao = $1, equipe_designada = NULL,
           historico = $2, atualizado_em = NOW()
         WHERE id = $3 RETURNING *`,
        [motivoRejeicao, JSON.stringify(historico), id]
      );
      res.json(mapRow(rows[0], true));
    }
  } catch (e) { console.error('POST validar:', e.message); res.status(500).json({ erro: e.message }); }
});

// ─── Empresas e Equipes cadastradas ────────────────────────────────────────────
// Deriva as empresas e equipes a partir dos usuários cadastrados, para que os
// selects de direcionamento/encaminhamento reflitam o cadastro real.
app.get('/api/empresas', qualquerUsuario, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT empresa FROM usuarios
        WHERE empresa IS NOT NULL AND empresa <> '' AND ativo = true
        ORDER BY empresa`
    );
    res.json(rows.map(r => r.empresa));
  } catch (e) {
    console.error('GET /api/empresas:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/equipes', qualquerUsuario, async (req, res) => {
  try {
    const { empresa } = req.query;
    const params = [];
    let filtro = `WHERE perfil = 'equipe' AND equipe_nome IS NOT NULL AND equipe_nome <> '' AND ativo = true`;
    if (empresa) {
      params.push(empresa);
      filtro += ` AND empresa = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT equipe_nome, empresa FROM usuarios ${filtro} ORDER BY equipe_nome`,
      params
    );
    res.json(rows.map(r => ({ equipe: r.equipe_nome, empresa: r.empresa || null })));
  } catch (e) {
    console.error('GET /api/equipes:', e.message);
    res.status(500).json({ erro: e.message });
  }
});
// ─── fim Empresas e Equipes ─────────────────────────────────────────────────────

// ─── Importar Protocolo SEN ────────────────────────────────────────────────────
let _pdfParse = null;
try { _pdfParse = require('pdf-parse'); } catch {}

app.post('/api/protocolos/importar-pdf', adminOuSeinfra, async (req, res) => {
  if (!_pdfParse) {
    return res.status(500).json({ erro: 'Dependência pdf-parse não instalada. Execute npm install no servidor.' });
  }
  try {
    const { pdf } = req.body;
    if (!pdf) return res.status(400).json({ erro: 'PDF não informado' });

    const buf = Buffer.from(pdf, 'base64');
    const data = await _pdfParse(buf, { max: 1 }); // só 1ª página — evita processar fotos
    const txt = data.text || '';

    const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

    // Retorna o texto da linha imediatamente após a que contém o padrão
    const lineAfter = (pattern) => {
      const idx = lines.findIndex(l => new RegExp(pattern, 'i').test(l));
      return idx >= 0 && idx + 1 < lines.length ? lines[idx + 1] : '';
    };

    // Retorna o valor após o label — tenta inline primeiro, depois próxima linha
    const valorDe = (pattern) => {
      // Try inline first (same line after colon/space)
      const line = lines.find(l => new RegExp('^\\s*' + pattern + '\\s*[:.]', 'i').test(l));
      if (line) {
        const m = line.match(new RegExp(pattern + '\\s*[:.\\s]\\s*(.+)', 'i'));
        if (m && m[1].trim()) return m[1].trim();
      }
      // Fallback: value on next line after label
      const idx = lines.findIndex(l => new RegExp(pattern, 'i').test(l));
      if (idx >= 0 && idx + 1 < lines.length) {
        const nextLine = lines[idx + 1];
        if (nextLine && !/^[A-ZÁÉÍÓÚÃÕÇ\s]{5,}$/.test(nextLine)) return nextLine;
      }
      return '';
    };

    // Coleta linhas entre dois padrões (para descrições multi-linha)
    const between = (startPattern, stopPattern) => {
      const start = lines.findIndex(l => new RegExp(startPattern, 'i').test(l));
      if (start < 0) return '';
      const parts = [];
      for (let i = start + 1; i < lines.length; i++) {
        if (stopPattern && new RegExp(stopPattern, 'i').test(lines[i])) break;
        if (/^[A-ZÁÉÍÓÚÃÕÇ\s]{5,}$/.test(lines[i])) break; // para em títulos maiúsculos
        parts.push(lines[i]);
      }
      return parts.join(' ').trim();
    };

    // Número do processo
    const processoMatch = txt.match(/SEN[-–][\d]+-[\d]+/i);
    const processo = processoMatch ? processoMatch[0].replace('–', '-') : '';

    // Tipo de serviço — linha logo após o cabeçalho de serviço
    const tipoRaw = lineAfter('SERVI[ÇC]O SOLICITADO') ||
                    lineAfter('TIPO DE SERVI[ÇC]O')    ||
                    valorDe('Servi[çc]o');

    const mapaTipos = [
      [/bueiro|boca.de.lobo|galeria/i,    'Bueiros / Bocas de Lobo'],
      [/pavimenta|asfalto/i,              'Pavimentação / Asfalto'],
      [/drenagem|esgoto/i,                'Drenagem / Esgoto'],
      [/ilumina/i,                        'Iluminação Pública'],
      [/limpeza.urban|varri[çc]|capina/i, 'Limpeza Urbana'],
      [/pra[çc]a|parque/i,               'Manutenção de Praças'],
      [/cal[çc]ada|passeio/i,            'Calçadas / Passeios'],
      [/sinaliza/i,                       'Sinalização Viária'],
      [/ponte|viaduto/i,                  'Pontes / Viadutos'],
    ];
    let tipo = 'Outros';
    const haystack = tipoRaw + ' ' + txt.slice(0, 600);
    for (const [re, label] of mapaTipos) {
      if (re.test(haystack)) { tipo = label; break; }
    }

    // Data de solicitação — busca padrões DD/MM/YYYY perto de "Data" ou "Solicitação"
    let dataSolicitacao = '';
    const dateLineIdx = lines.findIndex(l => /data|solicita/i.test(l));
    if (dateLineIdx >= 0) {
      // Procura data na mesma linha ou nas próximas 2 linhas
      for (let i = dateLineIdx; i <= Math.min(dateLineIdx + 2, lines.length - 1); i++) {
        const dateMatch = lines[i].match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
        if (dateMatch) {
          dataSolicitacao = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`; // YYYY-MM-DD
          break;
        }
      }
    }
    // Fallback: procura qualquer data DD/MM/YYYY no texto
    if (!dataSolicitacao) {
      const anyDate = txt.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
      if (anyDate) {
        dataSolicitacao = `${anyDate[3]}-${anyDate[2]}-${anyDate[1]}`;
      }
    }

    // Endereço
    const rua    = valorDe('Rua');
    const numero = valorDe('N[uú]mero');
    const endereco = (rua && numero && numero !== '0000')
      ? `${rua}, ${numero}`
      : rua || '';

    // Bairro
    const bairro = valorDe('Bairro');

    // Referência
    const referencia = between('ponto de refer[eê]ncia', 'Qual o|observa[çc]|FOTO') ||
                       valorDe('ponto de refer[eê]ncia');

    // Descrição: problema + observação
    const problema   = between('Qual o problema', 'observa[çc]|FOTO') || valorDe('Qual o problema');
    const observacao = between('observa[çc]', 'FOTO|$') || valorDe('observa[çc]');
    const descricao  = [problema, observacao].filter(Boolean).join(' — ') || tipoRaw;

    res.json({
      ok: true,
      dados: {
        tipo,
        descricao,
        endereco,
        bairro,
        referencia,
        dataSolicitacao,
        tag:       processo ? `Protocolo ${processo}` : 'Protocolo SEN',
        prioridade: 'media',
        _processo: processo,
        _tipoRaw:  tipoRaw,
      },
    });
  } catch (e) {
    console.error('importar-pdf:', e.message);
    res.status(500).json({ erro: 'Erro ao processar PDF: ' + e.message });
  }
});
// ─── fim Protocolo SEN ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
iniciarBanco().then(() => {
  app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
}).catch(err => {
  console.error('Erro ao conectar no banco:', err.message);
  process.exit(1);
});
