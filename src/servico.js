// Regras de uso do dia a dia: o que estudar agora, registrar estudo, revisões e números do painel.
// Usado pela plataforma (servidor.js) e, na próxima etapa, pelo servidor MCP.
import { transacao } from './db.js';
import { topicoSugerido } from './ciclo.js';

const TIPOS = ['teoria', 'questoes', 'revisao'];

// Datas locais em texto (YYYY-MM-DD), para agrupar por dia no fuso do PC.
export function dataLocal(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function dataHoraLocal(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${dataLocal(d)}T${z(d.getHours())}:${z(d.getMinutes())}`;
}
function somarDias(data, dias) {
  const [a, m, d] = data.split('-').map(Number);
  return dataLocal(new Date(a, m - 1, d + dias));
}
function inicioDaSemana(data) {
  const [a, m, d] = data.split('-').map(Number);
  const dia = new Date(a, m - 1, d);
  return somarDias(data, -dia.getDay()); // semana começa no domingo, como no Estudei
}

function preferencia(db, chave) {
  return JSON.parse(db.prepare('SELECT valor FROM preferencia WHERE chave = ?').get(chave).valor);
}

export function listarPlanos(db) {
  return db.prepare('SELECT id, nome, data_prova FROM plano ORDER BY id').all();
}

export function cicloDoPlano(db, planoId) {
  const ciclo = db.prepare('SELECT * FROM ciclo WHERE plano_id = ?').get(planoId);
  if (!ciclo) return null;
  const blocos = db
    .prepare(
      `SELECT b.id, b.volta, b.posicao, b.duracao_min, b.feito, m.id materia_id, m.nome materia, m.cor
       FROM bloco b JOIN materia m ON m.id = b.materia_id WHERE b.ciclo_id = ? ORDER BY b.posicao`,
    )
    .all(ciclo.id);
  return { ...ciclo, blocos };
}

// Primeiro bloco ainda não feito. Quando a fila acaba, ela recomeça do início.
// Com reiniciar = false (leitura pelo Claude), só calcula, sem gravar o recomeço.
export function proximoBloco(db, planoId, { reiniciar = true } = {}) {
  const ciclo = cicloDoPlano(db, planoId);
  if (!ciclo || ciclo.blocos.length === 0) return null;
  let bloco = ciclo.blocos.find((b) => !b.feito);
  let feitos = ciclo.blocos.filter((b) => b.feito).length;
  if (!bloco) {
    if (reiniciar) db.prepare('UPDATE bloco SET feito = 0 WHERE ciclo_id = ?').run(ciclo.id);
    bloco = { ...ciclo.blocos[0], feito: 0 };
    feitos = 0;
  }
  return {
    ...bloco,
    topico: topicoSugerido(db, bloco.materia_id) ?? null,
    progresso: { feitos, total: ciclo.blocos.length },
  };
}

export function registrarSessao(db, planoId, dados, origem = 'app') {
  const tipo = TIPOS.includes(dados.tipo) ? dados.tipo : 'teoria';
  const inicio = dados.inicio || dataHoraLocal();
  const duracao = Math.max(0, Math.round(Number(dados.duracao_min) || 0));
  const acertos = Math.max(0, Number(dados.acertos) || 0);
  const erros = Math.max(0, Number(dados.erros) || 0);
  return transacao(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO sessao (plano_id, materia_id, topico_id, inicio, duracao_min, tipo, acertos, erros, anotacao, origem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(planoId, dados.materia_id || null, dados.topico_id || null, inicio, duracao, tipo, acertos, erros, dados.anotacao || null, origem);
    const sessaoId = Number(lastInsertRowid);
    agendarRevisoes(db, sessaoId, tipo, inicio);
    if (dados.bloco_id) db.prepare('UPDATE bloco SET feito = 1 WHERE id = ?').run(dados.bloco_id);
    if (dados.topico_concluido && dados.topico_id) db.prepare('UPDATE topico SET concluido = 1 WHERE id = ?').run(dados.topico_id);
    return sessaoId;
  });
}

// Revisões pendentes da sessão, refeitas a partir da data dela. As já feitas ou puladas ficam.
function agendarRevisoes(db, sessaoId, tipo, inicio) {
  db.prepare("DELETE FROM revisao WHERE sessao_id = ? AND estado = 'pendente'").run(sessaoId);
  if (tipo === 'revisao') return;
  const jaResolvidas = db.prepare("SELECT COUNT(*) n FROM revisao WHERE sessao_id = ?").get(sessaoId).n;
  const inserir = db.prepare('INSERT INTO revisao (sessao_id, data_prevista) VALUES (?, ?)');
  for (const dias of preferencia(db, 'intervalos_revisao').slice(jaResolvidas)) {
    inserir.run(sessaoId, somarDias(inicio.slice(0, 10), dias));
  }
}

export function obterSessao(db, sessaoId) {
  return db.prepare('SELECT * FROM sessao WHERE id = ?').get(sessaoId) ?? null;
}

// Corrige um estudo registrado. Mudou a data ou o tipo, as revisões pendentes acompanham.
export function editarSessao(db, sessaoId, dados) {
  const atual = obterSessao(db, sessaoId);
  if (!atual) throw new Error(`Estudo ${sessaoId} não existe.`);
  const tipo = TIPOS.includes(dados.tipo) ? dados.tipo : atual.tipo;
  const inicio = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dados.inicio ?? '') ? dados.inicio : atual.inicio;
  const numero = (v, antes) => (v === undefined || v === null || v === '' ? antes : Math.max(0, Math.round(Number(v)) || 0));
  transacao(db, () => {
    db.prepare(
      `UPDATE sessao SET materia_id = ?, topico_id = ?, inicio = ?, duracao_min = ?, tipo = ?, acertos = ?, erros = ?, anotacao = ?
       WHERE id = ?`,
    ).run(
      dados.materia_id === undefined ? atual.materia_id : dados.materia_id || null,
      dados.topico_id === undefined ? atual.topico_id : dados.topico_id || null,
      inicio,
      numero(dados.duracao_min, atual.duracao_min),
      tipo,
      numero(dados.acertos, atual.acertos),
      numero(dados.erros, atual.erros),
      dados.anotacao === undefined ? atual.anotacao : dados.anotacao || null,
      sessaoId,
    );
    if (inicio !== atual.inicio || tipo !== atual.tipo) agendarRevisoes(db, sessaoId, tipo, inicio);
  });
  return obterSessao(db, sessaoId);
}

// Apaga o estudo e as revisões dele. Chamado pela tela do Histórico e pelo Claude (MCP).
export function apagarSessao(db, sessaoId) {
  db.prepare('DELETE FROM sessao WHERE id = ?').run(sessaoId);
}

export function pularBloco(db, blocoId) {
  db.prepare('UPDATE bloco SET feito = 1 WHERE id = ?').run(blocoId);
}

export function materiasComTopicos(db, planoId) {
  const materias = db
    .prepare('SELECT id, nome, cor, conhecimento, importancia FROM materia WHERE plano_id = ? ORDER BY posicao')
    .all(planoId);
  const topicos = db.prepare('SELECT id, numero, nome, concluido FROM topico WHERE materia_id = ? ORDER BY numero');
  const stats = db.prepare(
    `SELECT COALESCE(SUM(duracao_min), 0) minutos, COALESCE(SUM(acertos), 0) acertos, COALESCE(SUM(erros), 0) erros
     FROM sessao WHERE materia_id = ?`,
  );
  return materias.map((m) => ({ ...m, topicos: topicos.all(m.id), ...stats.get(m.id) }));
}

export function alternarTopico(db, topicoId, concluido) {
  db.prepare('UPDATE topico SET concluido = ? WHERE id = ?').run(concluido ? 1 : 0, topicoId);
}

export function definirDataProva(db, planoId, data) {
  db.prepare('UPDATE plano SET data_prova = ? WHERE id = ?').run(data || null, planoId);
}

// Apaga o plano inteiro: matérias, assuntos, ciclo, estudos, revisões e questões vão junto (ON DELETE CASCADE).
export function apagarPlano(db, planoId) {
  db.prepare('DELETE FROM plano WHERE id = ?').run(planoId);
}

export function historico(db, planoId, limite = 50) {
  return db
    .prepare(
      `SELECT s.id, s.inicio, s.duracao_min, s.tipo, s.acertos, s.erros, s.anotacao, s.origem,
              m.id materia_id, m.nome materia, m.cor, t.nome topico
       FROM sessao s LEFT JOIN materia m ON m.id = s.materia_id LEFT JOIN topico t ON t.id = s.topico_id
       WHERE s.plano_id = ? ORDER BY s.inicio DESC, s.id DESC LIMIT ?`,
    )
    .all(planoId, limite);
}

export function revisoesDoDia(db, planoId, hoje = dataLocal()) {
  return db
    .prepare(
      `SELECT r.id, r.data_prevista, m.id materia_id, m.nome materia, m.cor, t.nome topico, s.inicio
       FROM revisao r JOIN sessao s ON s.id = r.sessao_id
       LEFT JOIN materia m ON m.id = s.materia_id LEFT JOIN topico t ON t.id = s.topico_id
       WHERE s.plano_id = ? AND r.estado = 'pendente' AND r.data_prevista <= ?
       ORDER BY r.data_prevista, r.id`,
    )
    .all(planoId, hoje);
}

export function concluirRevisao(db, revisaoId, estado = 'feita') {
  db.prepare('UPDATE revisao SET estado = ? WHERE id = ?').run(estado === 'pulada' ? 'pulada' : 'feita', revisaoId);
}

// Tudo o que foi estudado entre duas datas (YYYY-MM-DD, inclusive): por dia, por matéria e por tipo.
export function resumoPeriodo(db, planoId, inicio, fim) {
  const onde = `s.plano_id = ? AND substr(s.inicio, 1, 10) BETWEEN ? AND ?`;
  const args = [planoId, inicio, fim];
  const minimo = preferencia(db, 'minutos_constancia');
  const porDia = db
    .prepare(`SELECT substr(s.inicio, 1, 10) dia, SUM(s.duracao_min) minutos, SUM(s.acertos) acertos, SUM(s.erros) erros
              FROM sessao s WHERE ${onde} GROUP BY dia ORDER BY dia`)
    .all(...args);
  const porMateria = db
    .prepare(`SELECT COALESCE(m.nome, 'Sem matéria') materia, SUM(s.duracao_min) minutos, SUM(s.acertos) acertos,
                     SUM(s.erros) erros, COUNT(*) sessoes
              FROM sessao s LEFT JOIN materia m ON m.id = s.materia_id WHERE ${onde}
              GROUP BY s.materia_id ORDER BY minutos DESC`)
    .all(...args);
  const porTipo = db
    .prepare(`SELECT s.tipo, SUM(s.duracao_min) minutos, COUNT(*) sessoes FROM sessao s WHERE ${onde} GROUP BY s.tipo`)
    .all(...args);
  const soma = (campo) => porDia.reduce((a, d) => a + (d[campo] || 0), 0);
  return {
    inicio,
    fim,
    minutos: soma('minutos'),
    questoes: { acertos: soma('acertos'), erros: soma('erros') },
    diasComEstudo: porDia.length,
    diasQueContaram: porDia.filter((d) => d.minutos >= minimo).length,
    minimoConstancia: minimo,
    porDia,
    porMateria,
    porTipo,
  };
}

// Dias seguidos que contaram, de trás para frente. Hoje ainda em andamento não quebra a sequência.
function diasSeguidos(constancia) {
  let i = constancia.length - 1;
  if (!constancia[i].contou) i--;
  let n = 0;
  for (; i >= 0 && constancia[i].contou; i--) n++;
  return n;
}

// Números do painel inicial.
export function resumo(db, planoId, hoje = dataLocal()) {
  const minutos = (desde, ate = hoje) =>
    db
      .prepare(`SELECT COALESCE(SUM(duracao_min), 0) m FROM sessao WHERE plano_id = ? AND substr(inicio, 1, 10) BETWEEN ? AND ?`)
      .get(planoId, desde, ate).m;
  const semana = inicioDaSemana(hoje);
  const q = db
    .prepare('SELECT COALESCE(SUM(acertos), 0) a, COALESCE(SUM(erros), 0) e FROM sessao WHERE plano_id = ?')
    .get(planoId);
  const qSemana = db
    .prepare(
      `SELECT COALESCE(SUM(acertos), 0) a, COALESCE(SUM(erros), 0) e FROM sessao
       WHERE plano_id = ? AND substr(inicio, 1, 10) BETWEEN ? AND ?`,
    )
    .get(planoId, semana, hoje);
  const edital = db
    .prepare(
      `SELECT COUNT(*) total, COALESCE(SUM(t.concluido), 0) feitos
       FROM topico t JOIN materia m ON m.id = t.materia_id WHERE m.plano_id = ?`,
    )
    .get(planoId);
  const minimo = preferencia(db, 'minutos_constancia');
  const porDia = new Map(
    db
      .prepare(
        `SELECT substr(inicio, 1, 10) dia, SUM(duracao_min) m FROM sessao
         WHERE plano_id = ? AND substr(inicio, 1, 10) BETWEEN ? AND ? GROUP BY dia`,
      )
      .all(planoId, somarDias(hoje, -29), hoje)
      .map((r) => [r.dia, r.m]),
  );
  const constancia = Array.from({ length: 30 }, (_, i) => {
    const dia = somarDias(hoje, i - 29);
    const m = porDia.get(dia) || 0;
    return { dia, minutos: m, contou: m >= minimo };
  });
  const semanaPorDia = Array.from({ length: 7 }, (_, i) => {
    const dia = somarDias(semana, i);
    return { dia, minutos: porDia.get(dia) || 0 };
  });
  const ciclo = db.prepare('SELECT tempo_total_min FROM ciclo WHERE plano_id = ?').get(planoId);
  return {
    hoje: minutos(hoje),
    semana: minutos(semana),
    total: db.prepare('SELECT COALESCE(SUM(duracao_min), 0) m FROM sessao WHERE plano_id = ?').get(planoId).m,
    metaSemanal: ciclo ? ciclo.tempo_total_min : null,
    questoes: { acertos: q.a, erros: q.e, desempenho: q.a + q.e ? q.a / (q.a + q.e) : null },
    questoesSemana: { acertos: qSemana.a, erros: qSemana.e },
    edital: { total: edital.total, feitos: edital.feitos },
    constancia,
    diasSeguidos: diasSeguidos(constancia),
    semanaPorDia,
    minimoConstancia: minimo,
  };
}
