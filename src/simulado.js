// Simulado (1.1): N questões com X por matéria, cronômetro único, gabarito só no fim, resultado por matéria.
// Pode usar lote reservado quando pedido. A correção grava as respostas, um estudo de questões por matéria
// e o resultado do simulado.
import { transacao } from './db.js';
import { listarQuestoes, prepararQuestoes } from './questoes.js';
import { registrarSessao, dataHoraLocal } from './servico.js';

// porMateria: { <materia_id>: quantidade }. Com lote, só questões dele (reservado ou não).
// Sem lote, incluirReservados decide se os lotes reservados entram.
export function montarSimulado(db, planoId, { porMateria, lote = null, incluirReservados = false }) {
  const pedidos = Object.entries(porMateria ?? {}).map(([id, n]) => [Number(id), Math.max(0, Math.round(Number(n) || 0))]).filter(([, n]) => n > 0);
  if (pedidos.length === 0) throw new Error('Diga quantas questões de cada matéria.');
  const faltas = [];
  const questoes = pedidos.flatMap(([materiaId, n]) => {
    const achadas = listarQuestoes(db, planoId, { materiaId, lote, incluirReservados, aleatoria: true, limite: n });
    if (achadas.length < n) faltas.push({ materia_id: materiaId, pedidas: n, achadas: achadas.length });
    return achadas;
  });
  for (let i = questoes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questoes[i], questoes[j]] = [questoes[j], questoes[i]];
  }
  return { questoes, faltas };
}

// respostas: [{ questao_id, escolhida (índice, ou null se ficou em branco), segundos }]. Em branco conta como erro.
export function corrigirSimulado(db, planoId, { respostas, minutos, lote = null, inicio = dataHoraLocal() }) {
  prepararQuestoes(db);
  if (!Array.isArray(respostas) || respostas.length === 0) throw new Error('Simulado sem questões.');
  const buscar = db.prepare('SELECT q.id, q.correta, q.materia_id, m.nome materia FROM questao q LEFT JOIN materia m ON m.id = q.materia_id WHERE q.id = ? AND q.plano_id = ?');
  const gravar = db.prepare('INSERT INTO resposta (questao_id, escolhida, acertou, segundos) VALUES (?, ?, ?, ?)');
  return transacao(db, () => {
    const porMateria = new Map();
    const gabarito = respostas.map((r) => {
      const q = buscar.get(Number(r.questao_id), planoId);
      if (!q) throw new Error(`Questão ${r.questao_id} não é deste plano.`);
      const emBranco = r.escolhida === null || r.escolhida === undefined;
      const acertou = !emBranco && Number(r.escolhida) === q.correta;
      if (!emBranco) gravar.run(q.id, Number(r.escolhida), acertou ? 1 : 0, Number.isFinite(r.segundos) ? Math.round(r.segundos) : null);
      const m = porMateria.get(q.materia_id) ?? { materia_id: q.materia_id, materia: q.materia ?? 'Sem matéria', questoes: 0, acertos: 0, em_branco: 0 };
      m.questoes++;
      if (acertou) m.acertos++;
      if (emBranco) m.em_branco++;
      porMateria.set(q.materia_id, m);
      return { questao_id: q.id, escolhida: emBranco ? null : Number(r.escolhida), correta: q.correta, acertou };
    });
    const total = Math.max(1, Math.round(Number(minutos) || 0));
    const lista = [...porMateria.values()];
    for (const m of lista) {
      registrarSessao(db, planoId, {
        materia_id: m.materia_id,
        tipo: 'questoes',
        inicio,
        duracao_min: Math.round((total * m.questoes) / respostas.length),
        acertos: m.acertos,
        erros: m.questoes - m.acertos,
        anotacao: `Simulado: ${m.questoes} questões`,
      });
    }
    const acertos = gabarito.filter((g) => g.acertou).length;
    const { lastInsertRowid } = db
      .prepare('INSERT INTO simulado (plano_id, feito_em, minutos, questoes, acertos, por_materia, lote) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(planoId, inicio, total, respostas.length, acertos, JSON.stringify(lista), lote);
    return { id: Number(lastInsertRowid), minutos: total, questoes: respostas.length, acertos, por_materia: lista, gabarito };
  });
}

export function listarSimulados(db, planoId, limite = 20) {
  const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'simulado'").get();
  if (!existe) return [];
  return db
    .prepare('SELECT * FROM simulado WHERE plano_id = ? ORDER BY feito_em DESC, id DESC LIMIT ?')
    .all(planoId, limite)
    .map((s) => ({ ...s, por_materia: JSON.parse(s.por_materia) }));
}
