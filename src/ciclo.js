// Ciclo de estudos no molde do Estudei.
// Peso: regra lida no JavaScript do Estudei (WeightSubject). Blocos: regra inferida de uma
// amostra só (um ciclo real capturado do Estudei), conferida no teste "reproduz o ciclo do Estudei".
import { transacao } from './db.js';

export const OPCOES_PADRAO = { total: 840, min: 45, max: 90, passo: 15 };

// Cada degrau de conhecimento corta o peso pela metade; a importância multiplica direto.
export function pesoBruto({ conhecimento, importancia }) {
  return Math.pow(2, -conhecimento) * importancia;
}

export function calcularPesos(materias) {
  const brutos = materias.map(pesoBruto);
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

export function topicoSugerido(db, materiaId) {
  return db
    .prepare('SELECT id, numero, nome FROM topico WHERE materia_id = ? AND concluido = 0 ORDER BY numero LIMIT 1')
    .get(materiaId);
}

// Recalcula o ciclo do plano do zero e grava os blocos.
export function gerarCiclo(db, planoId, opcoes = {}) {
  const o = { ...OPCOES_PADRAO, ...opcoes };
  const materias = db
    .prepare('SELECT id, nome, conhecimento, importancia FROM materia WHERE plano_id = ? ORDER BY posicao')
    .all(planoId);
  if (materias.length === 0) throw new Error(`Plano ${planoId} não tem matérias.`);
  const blocos = montarBlocos(materias, o);
  return transacao(db, () => {
    db.prepare('DELETE FROM ciclo WHERE plano_id = ?').run(planoId);
    const { lastInsertRowid: cicloId } = db
      .prepare('INSERT INTO ciclo (plano_id, tempo_total_min, bloco_min, bloco_max, passo_min) VALUES (?, ?, ?, ?, ?)')
      .run(planoId, o.total, o.min, o.max, o.passo);
    const inserir = db.prepare('INSERT INTO bloco (ciclo_id, materia_id, volta, posicao, duracao_min) VALUES (?, ?, ?, ?, ?)');
    for (const b of blocos) inserir.run(cicloId, b.materia.id, b.volta, b.posicao, b.duracao);
    return { cicloId: Number(cicloId), opcoes: o, blocos };
  });
}
