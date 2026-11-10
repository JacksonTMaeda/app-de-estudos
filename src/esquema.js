// Confere os argumentos de uma ferramenta do MCP contra o inputSchema dela, antes de rodar.
// O esquema era só anunciado ao Claude: enum, pattern e minimum não eram cobrados por ninguém, e um valor
// fora do combinado chegava às regras (data em formato errado, número como texto, lista vazia).
// Cobre o que os esquemas do mcp.js usam: type, enum, pattern, minimum, maximum, exclusiveMinimum, maxLength,
// minItems, maxItems, items, properties e required. Propriedade que o esquema não cita passa sem conferir.
// Argumento opcional que vem null conta como não enviado.

const NOME_DO_TIPO = {
  string: 'texto',
  integer: 'número inteiro',
  number: 'número',
  boolean: 'verdadeiro ou falso',
  array: 'lista',
  object: 'objeto',
};

function ehDoTipo(tipo, v) {
  switch (tipo) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

function mostrar(v) {
  const texto = JSON.stringify(v) ?? String(v);
  return texto.length > 60 ? `${texto.slice(0, 57)}...` : texto;
}

// Devolve a lista de problemas (vazia quando está tudo certo). onde é o caminho do argumento, para a mensagem.
export function conferirArgumentos(esquema, valor, onde = '') {
  const nome = onde || 'argumentos';
  if (esquema.type) {
    const tipos = [].concat(esquema.type);
    if (!tipos.some((t) => ehDoTipo(t, valor))) {
      return [`${nome}: esperava ${tipos.map((t) => NOME_DO_TIPO[t] ?? t).join(' ou ')}, veio ${mostrar(valor)}`];
    }
  }
  const erros = [];
  if (esquema.enum && !esquema.enum.includes(valor)) {
    erros.push(`${nome}: precisa ser um de ${esquema.enum.join(', ')}; veio ${mostrar(valor)}`);
  }
  if (typeof valor === 'string') {
    if (esquema.pattern && !new RegExp(esquema.pattern).test(valor)) {
      erros.push(`${nome}: formato inválido, veio ${mostrar(valor)}${esquema.description ? ` (${esquema.description})` : ''}`);
    }
    if (esquema.maxLength != null && valor.length > esquema.maxLength) {
      erros.push(`${nome}: no máximo ${esquema.maxLength} caracteres, veio com ${valor.length}`);
    }
  }
  if (typeof valor === 'number') {
    if (esquema.minimum != null && valor < esquema.minimum) erros.push(`${nome}: mínimo ${esquema.minimum}, veio ${valor}`);
    if (esquema.maximum != null && valor > esquema.maximum) erros.push(`${nome}: máximo ${esquema.maximum}, veio ${valor}`);
    if (esquema.exclusiveMinimum != null && valor <= esquema.exclusiveMinimum) {
      erros.push(`${nome}: precisa ser maior que ${esquema.exclusiveMinimum}, veio ${valor}`);
    }
  }
  if (Array.isArray(valor)) {
    if (esquema.minItems != null && valor.length < esquema.minItems) {
      erros.push(`${nome}: precisa de pelo menos ${esquema.minItems} ${esquema.minItems === 1 ? 'item' : 'itens'}, veio com ${valor.length}`);
    }
    if (esquema.maxItems != null && valor.length > esquema.maxItems) {
      erros.push(`${nome}: no máximo ${esquema.maxItems} itens, veio com ${valor.length}`);
    }
    if (esquema.items) valor.forEach((item, i) => erros.push(...conferirArgumentos(esquema.items, item, `${onde}[${i + 1}]`)));
  } else if (valor !== null && typeof valor === 'object') {
    const caminho = (chave) => (onde ? `${onde}.${chave}` : chave);
    for (const chave of esquema.required ?? []) {
      if (valor[chave] === undefined || valor[chave] === null) erros.push(`${caminho(chave)}: é obrigatório`);
    }
    for (const [chave, sub] of Object.entries(esquema.properties ?? {})) {
      if (valor[chave] === undefined || valor[chave] === null) continue;
      erros.push(...conferirArgumentos(sub, valor[chave], caminho(chave)));
    }
  }
  return erros;
}
