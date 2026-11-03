// Pedido do Claude para a janela do programa: o MCP abre o programa com --pedido=<base64url de JSON>.
// Com o programa já aberto, o Windows entrega o argumento à cópia que está rodando (second-instance).
// Hoje só existe um pedido: abrir uma rodada com as questões indicadas, na ordem dada.

const PREFIXO = '--pedido=';
export const MAX_IDS = 500;

export function codificarPedido(pedido) {
  return PREFIXO + Buffer.from(JSON.stringify(pedido), 'utf8').toString('base64url');
}

// Acha e valida o pedido na linha de comando. Qualquer coisa fora do formato vira null:
// quem chama o programa pela linha de comando não consegue mais do que abrir questões do banco.
export function lerPedido(argv = []) {
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(PREFIXO));
  if (!arg) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(arg.slice(PREFIXO.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const inteiro = (n) => Number.isInteger(n) && n > 0;
  if (p?.tipo !== 'questoes' || !inteiro(p.planoId) || !Array.isArray(p.ids)) return null;
  if (p.ids.length === 0 || p.ids.length > MAX_IDS || !p.ids.every(inteiro)) return null;
  return { tipo: 'questoes', planoId: p.planoId, ids: [...new Set(p.ids)] };
}
