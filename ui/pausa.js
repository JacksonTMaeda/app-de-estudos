// Relógio que pausa: guarda o início, o total já pausado e, enquanto pausado, desde quando.
// Sem DOM, para o teste importar direto. A rodada de questões usa um para a rodada e outro por questão.
export function novoRelogio(agora = Date.now()) {
  return { inicio: agora, pausas: 0, pausadoEm: null };
}

export function pausar(r, agora = Date.now()) {
  if (r && r.pausadoEm == null) r.pausadoEm = agora;
  return r;
}

export function continuar(r, agora = Date.now()) {
  if (r && r.pausadoEm != null) {
    r.pausas += agora - r.pausadoEm;
    r.pausadoEm = null;
  }
  return r;
}

// Tempo corrido sem o pausado. Pausado, o relógio fica parado no instante da pausa.
export function msCorridos(r, agora = Date.now()) {
  if (r?.inicio == null) return 0;
  return Math.max(0, (r.pausadoEm ?? agora) - r.inicio - (r.pausas || 0));
}
