// Importa um edital escrito em markdown: título = matéria, item de lista = tópico.
// Título sem itens logo abaixo é agrupador (ex.: "Conhecimentos Gerais") e é ignorado.
import { transacao } from './db.js';

const TITULO = /^#{1,6}\s+(.+?)\s*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX~])\]\s+)?(.+?)\s*$/;
const QUESTOES_NO_TITULO = /\s*\((\d+)(?:\s+quest[õo]es)?\)\s*$/i;
const DATA_ENTRE_PARENTESES = /\s*\(\d{2}-\d{2}(?:-\d{4})?[^)]*\)/;
const LIMITE_NOME = 120;

function limparMarkdown(texto) {
  return texto
    .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .trim();
}

// O checklist do cofre mistura o nome do tópico com anotações de progresso.
// Corta a anotação: primeiro a data entre parênteses, depois o ": comentário" de linhas longas.
export function nomeDoTopico(texto) {
  let nome = limparMarkdown(texto);
  const data = nome.search(DATA_ENTRE_PARENTESES);
  if (data > 0) nome = nome.slice(0, data);
  if (nome.length > LIMITE_NOME) {
    const doisPontos = nome.indexOf(': ');
    if (doisPontos > 0) nome = nome.slice(0, doisPontos);
  }
  if (nome.length > LIMITE_NOME) nome = nome.slice(0, LIMITE_NOME - 3).trimEnd() + '...';
  return nome.trim();
}

export function lerEdital(markdown) {
  const materias = [];
  let atual = null;
  for (const linha of markdown.split(/\r?\n/)) {
    const titulo = linha.match(TITULO);
    if (titulo) {
      const texto = limparMarkdown(titulo[1]);
      const questoes = texto.match(QUESTOES_NO_TITULO);
      atual = {
        nome: texto.replace(QUESTOES_NO_TITULO, '').trim(),
        questoes: questoes ? Number(questoes[1]) : null,
        topicos: [],
      };
      materias.push(atual);
      continue;
    }
    const item = linha.match(ITEM);
    if (item && atual) {
      atual.topicos.push({
        numero: atual.topicos.length + 1,
        nome: nomeDoTopico(item[2]),
        concluido: item[1] === 'x' || item[1] === 'X',
      });
    }
  }
  const comTopicos = materias.filter((m) => m.topicos.length > 0);
  // Questões por matéria só servem de importância se todas tiverem; misturar com o padrão distorce o peso.
  const todasComQuestoes = comTopicos.every((m) => m.questoes !== null);
  return comTopicos.map((m) => ({ ...m, importancia: todasComQuestoes ? m.questoes : 2.5 }));
}

export function importarEdital(db, { nomePlano, dataProva = null, markdown }) {
  const materias = lerEdital(markdown);
  if (materias.length === 0) throw new Error('Nenhuma matéria com tópicos encontrada no edital.');
  return transacao(db, () => {
    const { lastInsertRowid: planoId } = db
      .prepare('INSERT INTO plano (nome, data_prova) VALUES (?, ?)')
      .run(nomePlano, dataProva);
    const inserirMateria = db.prepare(
      'INSERT INTO materia (plano_id, nome, importancia, posicao) VALUES (?, ?, ?, ?)',
    );
    const inserirTopico = db.prepare(
      'INSERT INTO topico (materia_id, numero, nome, concluido) VALUES (?, ?, ?, ?)',
    );
    materias.forEach((m, i) => {
      const { lastInsertRowid: materiaId } = inserirMateria.run(planoId, m.nome, m.importancia, i + 1);
      for (const t of m.topicos) inserirTopico.run(materiaId, t.numero, t.nome, t.concluido ? 1 : 0);
    });
    return { planoId: Number(planoId), materias };
  });
}
