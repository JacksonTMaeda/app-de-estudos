#!/usr/bin/env node
// Linha de comando da etapa 1, até as telas existirem.
//   importar <edital.md> "<nome do plano>" [--db caminho]
//   ciclo <plano_id> [--total 840] [--min 45] [--max 90] [--passo 15] [--db caminho]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { abrirBanco, CAMINHO_PADRAO } from './db.js';
import { importarEdital } from './edital.js';
import { gerarCiclo, topicoSugerido } from './ciclo.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string', default: CAMINHO_PADRAO },
    total: { type: 'string' },
    min: { type: 'string' },
    max: { type: 'string' },
    passo: { type: 'string' },
  },
});

const [comando, ...args] = positionals;
const db = abrirBanco(values.db);
const horas = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;

if (comando === 'importar') {
  const [arquivo, nomePlano] = args;
  if (!arquivo || !nomePlano) throw new Error('Uso: importar <edital.md> "<nome do plano>"');
  const { planoId, materias } = importarEdital(db, { nomePlano, markdown: readFileSync(arquivo, 'utf8') });
  console.log(`Plano ${planoId} criado: "${nomePlano}"`);
  for (const m of materias) {
    const feitos = m.topicos.filter((t) => t.concluido).length;
    console.log(`  ${m.nome}: ${m.topicos.length} tópicos (${feitos} concluídos), importância ${m.importancia}`);
  }
} else if (comando === 'ciclo') {
  const planoId = Number(args[0]);
  const opcoes = Object.fromEntries(
    ['total', 'min', 'max', 'passo'].filter((k) => values[k]).map((k) => [k, Number(values[k])]),
  );
  const { blocos, opcoes: o } = gerarCiclo(db, planoId, opcoes);
  const pesos = new Map(blocos.filter((b) => b.materia).map((b) => [b.materia.nome, b.materia.peso]));
  console.log(`Pesos (${horas(o.total)} por volta do ciclo):`);
  for (const [nome, peso] of pesos) console.log(`  ${String(peso).padStart(3)}%  ${nome}`);
  const voltas = [...new Set(blocos.map((b) => b.volta))];
  for (const v of voltas) {
    const daVolta = blocos.filter((b) => b.volta === v);
    const soma = daVolta.reduce((a, b) => a + b.duracao, 0);
    console.log(`\nVolta ${v} de ${voltas.length} (${horas(soma)}; pedido ${horas(o.total)}):`);
    for (const b of daVolta) {
      if (!b.materia) {
        console.log(`  ${String(b.posicao).padStart(2)}. ${String(b.duracao).padStart(3)} min  Questões misturadas (todas as matérias)`);
        continue;
      }
      const t = topicoSugerido(db, b.materia.id);
      console.log(`  ${String(b.posicao).padStart(2)}. ${String(b.duracao).padStart(3)} min  ${b.materia.nome}${t ? `  >  ${t.nome}` : ''}`);
    }
  }
} else {
  console.log('Comandos: importar <edital.md> "<nome do plano>" | ciclo <plano_id>');
  process.exitCode = 1;
}
