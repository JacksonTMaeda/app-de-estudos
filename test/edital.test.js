import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { lerEdital, nomeDoTopico, importarEdital } from '../src/edital.js';
import { abrirBanco } from '../src/db.js';

const EXEMPLO = `
# Edital de teste

## Conhecimentos Gerais (35 questões)

### Língua Portuguesa (25)

_Ordem sugerida: interpretação primeiro._

- [x] [[Resumo Interpretação|Interpretação e compreensão de texto]] (21-07-2026, quiz 85%)
- [ ] Pontuação e sinais gráficos
- [~] Morfologia: classes de palavras, estrutura e formação de palavras: **parte I** estudada em 31-07-2026 com um comentário bem longo que passa do limite de cento e vinte caracteres

### Raciocínio Lógico (5)
- [ ] Conjuntos e diagramas
`;

test('agrupador sem itens não vira matéria', () => {
  const materias = lerEdital(EXEMPLO);
  assert.deepEqual(materias.map((m) => m.nome), ['Língua Portuguesa', 'Raciocínio Lógico']);
});

test('número de questões vira importância', () => {
  assert.deepEqual(lerEdital(EXEMPLO).map((m) => m.importancia), [25, 5]);
});

test('sem questões em todas, importância fica no padrão', () => {
  const materias = lerEdital('## Clínica Médica\n- Cardiologia\n## Pediatria (20)\n- Neonatologia');
  assert.deepEqual(materias.map((m) => m.importancia), [2.5, 2.5]);
});

test('tópicos: nome limpo e concluído só com [x]', () => {
  const [port] = lerEdital(EXEMPLO);
  assert.deepEqual(port.topicos, [
    { numero: 1, nome: 'Interpretação e compreensão de texto', concluido: true },
    { numero: 2, nome: 'Pontuação e sinais gráficos', concluido: false },
    { numero: 3, nome: 'Morfologia', concluido: false },
  ]);
});

test('nome curto com parênteses de conteúdo é mantido', () => {
  assert.equal(
    nomeDoTopico('Organização estrutural dos textos (coesão, coerência)'),
    'Organização estrutural dos textos (coesão, coerência)',
  );
});

test('importarEdital grava plano, matérias e tópicos', () => {
  const db = abrirBanco(':memory:');
  const { planoId } = importarEdital(db, { nomePlano: 'Teste', markdown: EXEMPLO });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM materia WHERE plano_id = ?').get(planoId).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM topico').get().n, 4);
});

// Edital real da PCPR 2026 (Papiloscopista), fora do repositório. Caminho em ESTUDOS_EDITAL_REAL;
// sem a variável, o teste é pulado.
const EDITAL_REAL = process.env.ESTUDOS_EDITAL_REAL;

test('lê o edital real da PCPR', { skip: !EDITAL_REAL || !existsSync(EDITAL_REAL) }, () => {
  const materias = lerEdital(readFileSync(EDITAL_REAL, 'utf8'));
  assert.equal(materias.length, 14);
  assert.equal(materias.reduce((a, m) => a + m.importancia, 0), 100);
  for (const m of materias) {
    assert.ok(m.topicos.length > 0, m.nome);
    for (const t of m.topicos) assert.ok(t.nome.length > 0 && t.nome.length <= 120, t.nome);
  }
});
