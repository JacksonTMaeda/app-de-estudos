// Ciclo de estudos no molde do Estudei.
// Peso: regra lida no JavaScript do Estudei (WeightSubject). Blocos: regra inferida de uma
// amostra só (um ciclo real capturado do Estudei), conferida no teste "reproduz o ciclo do Estudei".
import { transacao } from './db.js';
import { conferirPesos, faseAtiva, faseDoCiclo } from './fases.js';

export const OPCOES_PADRAO = { total: 840, min: 45, max: 90, passo: 15 };

// Cada degrau de conhecimento corta o peso pela metade; a importância multiplica direto.
export function pesoBruto({ conhecimento, importancia }) {
  return Math.pow(2, -conhecimento) * importancia;
}

// Numa fase com peso manual, ele entra no lugar do peso do Estudei (todas as matérias ou nenhuma).
export function calcularPesos(materias) {
  const brutos = materias.map((m) => m.pesoManual ?? pesoBruto(m));
  const soma = brutos.reduce((a, b) => a + b, 0) || 1;
  return materias.map((m, i) => ({
    ...m,
    fracao: brutos[i] / soma,
    peso: Math.round((brutos[i] / soma) * 100),
  }));
}

// Quebra os minutos de uma matéria em blocos múltiplos do passo, entre min e max,
// o menor primeiro. 168 min com 45/90/15 vira [75, 90].
export function quebrarEmBlocos(minutos, { min, max, passo }) {
  const unidadesMin = Math.ceil(min / passo);
  const unidadesMax = Math.floor(max / passo);
  const unidades = Math.max(Math.round(minutos / passo), unidadesMin);
  const quantidade = Math.ceil(unidades / unidadesMax);
  const base = Math.floor(unidades / quantidade);
  const resto = unidades % quantidade;
  return Array.from({ length: quantidade }, (_, i) => (base + (i >= quantidade - resto ? 1 : 0)) * passo);
}

// Divide um total inteiro na proporção dos pesos sem passar dele: arredonda para baixo e entrega
// o que sobrou a quem perdeu mais no arredondamento (método dos maiores restos).
export function repartir(total, pesos) {
  const soma = pesos.reduce((a, b) => a + b, 0) || 1;
  const ideais = pesos.map((p) => (total * p) / soma);
  const partes = ideais.map(Math.floor);
  const ordem = ideais.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  const sobra = total - partes.reduce((a, b) => a + b, 0);
  for (let k = 0; k < sobra; k++) partes[ordem[k][1]]++;
  return partes;
}

const porPesoDepoisNome = (a, b) => b.fracao - a.fracao || a.nome.localeCompare(b.nome, 'pt-BR');

// Rodízio dentro de uma volta: primeiro bloco de cada matéria, depois o segundo, e assim por diante.
function rodizio(filas, volta, blocos) {
  const rodadas = Math.max(0, ...filas.map((f) => f.blocos.length));
  for (let r = 0; r < rodadas; r++) {
    for (const { m, blocos: dele } of filas) {
      if (r < dele.length) blocos.push({ materia: m, volta, posicao: blocos.length + 1, duracao: dele[r] });
    }
  }
}

// Matéria cujo tempo ideal não chega ao bloco mínimo é "pequena" e entra em volta sim, volta não
// (decisão de projeto). As pequenas se dividem entre a volta 1 e a 2, e o tempo
// que elas liberam vai para as grandes, então cada volta fecha perto do tempo total pedido.
// Sem matéria pequena, o ciclo tem uma volta só, igual ao do Estudei.
export function montarBlocos(materias, opcoes = OPCOES_PADRAO) {
  const ordenadas = calcularPesos(materias).sort(porPesoDepoisNome);
  const pequenas = ordenadas.filter((m) => opcoes.total * m.fracao < opcoes.min);
  const grandes = ordenadas.filter((m) => !pequenas.includes(m));
  const blocos = [];

  if (pequenas.length === 0) {
    rodizio(ordenadas.map((m) => ({ m, blocos: quebrarEmBlocos(opcoes.total * m.fracao, opcoes) })), 1, blocos);
    return blocos;
  }

  // O tempo das grandes sai da volta mais cheia (a que leva a metade arredondada para cima das pequenas),
  // para nenhuma volta passar do total.
  const blocoPequeno = Math.ceil(opcoes.min / opcoes.passo) * opcoes.passo;
  const disponivel = opcoes.total - Math.ceil(pequenas.length / 2) * blocoPequeno;
  if (disponivel <= 0) throw new Error('Matérias demais para o tempo do ciclo: aumente o total ou diminua o bloco mínimo.');
  const unidades = repartir(Math.floor(disponivel / opcoes.passo), grandes.map((m) => m.fracao));
  const minimo = Math.ceil(opcoes.min / opcoes.passo);
  const filaGrande = grandes.map((m, i) => ({ m, blocos: quebrarEmBlocos(Math.max(unidades[i], minimo) * opcoes.passo, opcoes) }));
  const filaPequena = (m) => ({ m, blocos: [blocoPequeno] });

  for (const volta of [1, 2]) {
    const daVolta = pequenas.filter((_, i) => i % 2 === volta - 1).map(filaPequena);
    rodizio([...filaGrande, ...daVolta], volta, blocos);
  }
  return blocos;
}

// Com grupo de foco (prefixo do nome antes de " / "), o primeiro assunto aberto do grupo;
// sem nenhum restante no grupo, a ordem normal.
export function topicoSugerido(db, materiaId, grupoFoco = null) {
  const sql = 'SELECT id, numero, nome FROM topico WHERE materia_id = ? AND concluido = 0';
  if (grupoFoco) {
    const prefixo = `${grupoFoco.replace(/[!%_]/g, (c) => `!${c}`)} / %`;
    const doGrupo = db.prepare(`${sql} AND nome LIKE ? ESCAPE '!' ORDER BY numero LIMIT 1`).get(materiaId, prefixo);
    if (doGrupo) return doGrupo;
  }
  return db.prepare(`${sql} ORDER BY numero LIMIT 1`).get(materiaId);
}

// Opções gravadas do ciclo, com o tempo por volta do próprio plano (não o de uma fase).
export function opcoesDoCiclo(db, planoId) {
  const c = db.prepare('SELECT * FROM ciclo WHERE plano_id = ?').get(planoId);
  return c ? { total: c.total_base_min ?? c.tempo_total_min, min: c.bloco_min, max: c.bloco_max, passo: c.passo_min } : {};
}

// Põe a configuração da fase nas matérias: tira as que estão fora, acrescenta peso manual, tipo e grupo de foco.
function aplicarFase(materias, fase) {
  if (!fase) return materias;
  const config = new Map(fase.materias.map((c) => [c.materia_id, c]));
  conferirPesos(materias.map((m) => ({ materia: m.nome, ...config.get(m.id) })));
  return materias
    .filter((m) => !config.get(m.id)?.fora)
    .map((m) => {
      const c = config.get(m.id);
      return { ...m, pesoManual: c?.peso ?? undefined, tipo: c?.tipo ?? 'teoria', grupoFoco: c?.grupo_foco ?? null };
    });
}

// Recalcula o ciclo do plano do zero e grava os blocos. Com fase ativa na data, aplica a fase:
// tempo por volta dela, matérias, pesos, tipos e um bloco de questões misturadas no fim de cada volta.
export function gerarCiclo(db, planoId, opcoes = {}, { hoje } = {}) {
  const base = { ...OPCOES_PADRAO, ...opcoes };
  const fase = faseAtiva(db, planoId, hoje);
  const o = { ...base, total: fase?.minutos_por_volta ?? base.total };
  const doPlano = db
    .prepare('SELECT id, nome, conhecimento, importancia FROM materia WHERE plano_id = ? ORDER BY posicao')
    .all(planoId);
  if (doPlano.length === 0) throw new Error(`Plano ${planoId} não tem matérias.`);
  const materias = aplicarFase(doPlano, fase);
  let blocos = montarBlocos(materias, o).map((b) => ({ ...b, tipo: b.materia.tipo ?? 'teoria' }));
  if (fase?.questoes_mistas_min) {
    const voltas = [...new Set(blocos.map((b) => b.volta))];
    blocos = voltas.flatMap((v) => [
      ...blocos.filter((b) => b.volta === v),
      { materia: null, volta: v, tipo: 'questoes', duracao: fase.questoes_mistas_min },
    ]);
    blocos.forEach((b, i) => (b.posicao = i + 1));
  }
  return transacao(db, () => {
    db.prepare('DELETE FROM ciclo WHERE plano_id = ?').run(planoId);
    const { lastInsertRowid: cicloId } = db
      .prepare(
        `INSERT INTO ciclo (plano_id, tempo_total_min, bloco_min, bloco_max, passo_min, fase_id, total_base_min)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(planoId, o.total, o.min, o.max, o.passo, fase?.id ?? null, base.total);
    const inserir = db.prepare('INSERT INTO bloco (ciclo_id, materia_id, tipo, volta, posicao, duracao_min) VALUES (?, ?, ?, ?, ?, ?)');
    for (const b of blocos) inserir.run(cicloId, b.materia?.id ?? null, b.tipo, b.volta, b.posicao, b.duracao);
    return { cicloId: Number(cicloId), opcoes: o, blocos, fase: fase ? fase.nome : null };
  });
}

// Virada de fase: se a fase ativa hoje não é a fase de que o ciclo foi gerado, refaz o ciclo uma vez
// (copiar guarda a cópia do banco antes). Plano sem fase: as duas são null e nada acontece.
// Devolve { de, para } quando refez, ou null. Se a fase nova não dá ciclo (configuração inválida),
// o ciclo antigo fica e a resposta traz o erro, para as telas continuarem abrindo.
export function sincronizarFase(db, planoId, { hoje, copiar } = {}) {
  let virada = null;
  try {
    const ciclo = db.prepare('SELECT fase_id FROM ciclo WHERE plano_id = ?').get(planoId);
    if (!ciclo) return null;
    const ativa = faseAtiva(db, planoId, hoje);
    if ((ciclo.fase_id ?? null) === (ativa?.id ?? null)) return null;
    virada = { de: faseDoCiclo(db, ciclo.fase_id)?.nome ?? null, para: ativa?.nome ?? null };
    copiar?.('antes da virada de fase');
    gerarCiclo(db, planoId, opcoesDoCiclo(db, planoId), { hoje });
    return virada;
  } catch (erro) {
    // Banco aberto só para leitura: a virada fica para a próxima abertura do app.
    if (/readonly|no such column/i.test(erro.message)) return null;
    return { ...virada, erro: `O ciclo não foi refeito para a fase: ${erro.message}` };
  }
}
