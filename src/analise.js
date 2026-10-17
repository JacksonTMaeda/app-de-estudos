// Análise das respostas do banco de questões: onde erra, por quê, e se está melhorando.
import { prepararQuestoes, CAUSAS } from './questoes.js';

const BANCA = `CASE WHEN q.fonte IS NULL OR q.fonte = '' OR lower(q.fonte) LIKE '%autoral%' THEN 'Autoral'
  ELSE trim(substr(q.fonte, 1, CASE WHEN instr(q.fonte, '/') > 0 THEN instr(q.fonte, '/') - 1 ELSE length(q.fonte) END)) END`;

// Semana começando no domingo, como no resto do app.
const SEMANA = `date(r.respondida_em, '-6 days', 'weekday 0')`;

const taxa = (linha) => ({ ...linha, acerto: linha.respostas ? linha.acertos / linha.respostas : null });

export function analisarQuestoes(db, planoId, { semanas = 8, minimoPorTema = 2, limiteLista = 15 } = {}) {
  prepararQuestoes(db);
  const base = `FROM resposta r JOIN questao q ON q.id = r.questao_id LEFT JOIN materia m ON m.id = q.materia_id
                WHERE q.plano_id = ?`;
  const agrupar = (chave, extra = '') =>
    db
      .prepare(
        `SELECT ${chave} nome, COUNT(*) respostas, SUM(r.acertou) acertos, AVG(r.segundos) segundos_medio
         ${base} GROUP BY ${chave} ${extra}`,
      )
      .all(planoId)
      .map(taxa);

  const geral = taxa(
    db.prepare(`SELECT COUNT(*) respostas, COALESCE(SUM(r.acertou), 0) acertos, AVG(r.segundos) segundos_medio,
                       COUNT(DISTINCT r.questao_id) questoes ${base}`).get(planoId),
  );
  const banco = db.prepare('SELECT COUNT(*) n FROM questao WHERE plano_id = ?').get(planoId).n;

  const porSemana = db
    .prepare(
      `SELECT ${SEMANA} semana, COUNT(*) respostas, SUM(r.acertou) acertos
       ${base} AND r.respondida_em >= date('now', 'localtime', ?) GROUP BY semana ORDER BY semana`,
    )
    .all(planoId, `-${semanas * 7} days`)
    .map(taxa);

  const porMateria = agrupar("COALESCE(m.nome, 'Sem matéria')", 'ORDER BY MIN(m.posicao)');
  // Banca com poucas respostas vira ruído; elas se somam numa linha só.
  const bancas = agrupar(BANCA, 'ORDER BY respostas DESC');
  const poucas = bancas.filter((b) => b.respostas < minimoPorTema + 1 && b.nome !== 'Autoral');
  const porBanca = bancas.filter((b) => !poucas.includes(b));
  if (poucas.length) {
    porBanca.push(taxa({
      nome: `Outras bancas (${poucas.length})`,
      respostas: poucas.reduce((s, b) => s + b.respostas, 0),
      acertos: poucas.reduce((s, b) => s + b.acertos, 0),
    }));
  }
  // Só tema que ainda tem erro; a matéria vai à parte para o nome do tema caber na tela.
  const temas = db
    .prepare(
      `SELECT COALESCE(q.tema, 'Sem tema') nome, m.nome materia, COUNT(*) respostas, SUM(r.acertou) acertos
       ${base} GROUP BY q.materia_id, q.tema HAVING COUNT(*) >= ? AND SUM(r.acertou) < COUNT(*)`,
    )
    .all(planoId, minimoPorTema)
    .map(taxa)
    .sort((a, b) => a.acerto - b.acerto || b.respostas - a.respostas);

  const erros = db.prepare(`SELECT COUNT(*) n ${base} AND r.acertou = 0`).get(planoId).n;
  const causas = Object.entries(CAUSAS).map(([chave, rotulo]) => ({
    chave,
    rotulo,
    total: db.prepare(`SELECT COUNT(*) n ${base} AND r.acertou = 0 AND r.causa = ?`).get(planoId, chave).n,
  }));
  const semCausa = erros - causas.reduce((a, c) => a + c.total, 0);

  // Questões cuja última resposta foi errada, as que mais erraram primeiro.
  const paraRefazer = db
    .prepare(
      `WITH stats AS (
         SELECT r.questao_id, COUNT(*) vezes, SUM(1 - r.acertou) erros, MAX(r.id) ultima
         FROM resposta r GROUP BY r.questao_id
       )
       SELECT q.id, q.tema, q.fonte, q.numero, m.nome materia, s.vezes, s.erros, u.causa ultima_causa
       FROM stats s JOIN questao q ON q.id = s.questao_id JOIN resposta u ON u.id = s.ultima
       LEFT JOIN materia m ON m.id = q.materia_id
       WHERE q.plano_id = ? AND u.acertou = 0
       ORDER BY s.erros DESC, s.vezes DESC, q.id LIMIT ?`,
    )
    .all(planoId, limiteLista);

  return {
    geral: { ...geral, banco },
    porSemana,
    porMateria,
    porBanca,
    pioresTemas: temas.slice(0, 10),
    causas: { erros, semCausa, lista: causas },
    paraRefazer,
  };
}
