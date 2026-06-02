app.put('/api/ordens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const o = req.body;

    const atual = await sql`SELECT foto_abertura, foto_conclusao FROM ordens_servico WHERE id = ${id}`;
    if (!atual.length) return res.status(404).json({ erro: 'Não encontrada' });

    const fotoAbertura = o.fotoAbertura !== undefined ? o.fotoAbertura : atual[0].foto_abertura;
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: e.message });
  }
});