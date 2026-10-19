# App De Estudos

Programa de desktop (Windows) para planejar e registrar estudo para concursos e provas: ciclo de estudos com peso por matéria, cronômetro, revisões espaçadas, banco de questões com análise de erros, e uma ponte MCP para o Claude acompanhar e orientar.

Tudo roda no PC de cada pessoa. Não há servidor nem conta: os dados ficam num arquivo SQLite local.

## Instalar

Baixe o `App-De-Estudos-Setup-<versão>.exe` da [última release](../../releases/latest) e dê dois cliques. O Windows pode avisar "O Windows protegeu o computador", porque o instalador não é assinado: clique em **Mais informações** e depois em **Executar assim mesmo**.

O programa se atualiza sozinho: ao abrir (e a cada 6 horas) ele confere as releases, baixa a versão nova e pergunta se pode reiniciar.

## Seus dados

- O banco fica em `Documentos\App De Estudos\estudos.db`, **fora** da pasta do programa. Instalar, atualizar ou desinstalar o programa não toca nele.
- Cópias automáticas ficam em `Documentos\App De Estudos\copias` (as 30 mais novas): uma ao abrir uma versão nova do programa, **antes** de qualquer ajuste no banco; uma por dia; e uma antes de cada operação do Claude que apaga ou refaz o ciclo.
- Para voltar uma cópia: feche o programa e copie o arquivo de volta como `estudos.db`.
- Mudança de banco em versão nova é sempre aditiva (coluna ou tabela nova); nada é apagado na atualização.

## O que tem

- **Início:** tempo do dia e da semana, desempenho, progresso no edital, próximo estudo do ciclo com cronômetro, revisões do dia, constância.
- **Ciclo:** peso da matéria = `2 ^ (-conhecimento) × importância`, em blocos de 45 a 90 min. Matéria cujo tempo não chega ao bloco mínimo entra em volta sim, volta não.
- **Questões:** importa quizzes em HTML, filtra por matéria, banca e situação, corrige com comentário e pergunta a causa de cada erro.
- **Análise:** acerto por semana, matéria, banca e tema, causas dos erros, questões para refazer.
- **Materiais:** escolha a pasta dos PDFs; cada subpasta com o nome de uma matéria fica ligada a ela (dá para trocar à mão). O leitor abre na página onde você parou, com zoom e texto selecionável. O PDF fica onde está: o app guarda só o caminho e a página.
- **Edital** e **Histórico** (corrigir e apagar estudo).

## Ponte com o Claude (servidor MCP)

`src/mcp.js` deixa o Claude consultar e mexer no app ao vivo:

- **Ler:** `ver_plano`, `proximo_estudo`, `resumo_periodo`, `revisoes_pendentes`, `historico_sessoes`, `analise_questoes`, `assuntos_da_materia`.
- **Gravar:** `registrar_estudo`, `corrigir_estudo`, `marcar_assunto`, `concluir_revisao`, `ajustar_conhecimento`, `refazer_ciclo`, `definir_data_prova`, `adicionar_questoes`, `criar_plano`.
- **Apagar:** `apagar_estudo`, `apagar_questao`, `apagar_plano` (este exige o nome exato do plano). Antes de apagar, o servidor guarda uma cópia do banco.

Roda com o Node que vem dentro do programa. Registro no Claude Code, com o programa instalado (troque `<você>` pelo seu usuário do Windows):

```json
"app-de-estudos": {
  "command": "C:/Users/<você>/AppData/Local/Programs/app-de-estudos/App De Estudos.exe",
  "args": ["C:/Users/<você>/AppData/Local/Programs/app-de-estudos/resources/app/src/mcp.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

Quando o programa se atualiza, o servidor vem junto: ferramentas novas aparecem na próxima sessão do Claude.

## Desenvolver

Requer Node 22.13 ou mais novo.

```bash
npm install
npm start          # abre o programa a partir do código
npm test           # testes
npm run instalador # gera o instalador em dist/
```

Linha de comando: `npm run cli -- importar "edital.md" "Nome do plano"` e `npm run cli -- ciclo 1`. Use `--db outro.db` para não mexer no banco padrão.

Conferência visual: `ESTUDOS_DB=demo.db ESTUDOS_CAPTURA=tela.png ESTUDOS_TELA=ciclo npx electron .` salva a tela e fecha.

## Publicar uma versão

1. Subir o número em `package.json` (`1.0.0` para `1.0.1`, por exemplo) e commitar.
2. `npm run instalador`.
3. Criar a release `v<versão>` no GitHub com os três arquivos de `dist/`: o `.exe`, o `.exe.blockmap` e o `latest.yml`. Sem o `latest.yml` os programas instalados não enxergam a versão nova.
