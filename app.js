(() => {
  "use strict";

  // ---------- Configuração do Supabase ----------
  const SUPABASE_URL = "https://jfrdeijscuflxpuexqet.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_z7XVgAzqJy0z-4wF6UL4Mw_uuIYCrYV";

  const KEY = "estoque-mp-v1";           // chave antiga (dados locais) e prefixo de preferências
  const EMAIL_DOMAIN = "@estoque.app";   // e-mail interno, nunca mostrado ao usuário

  const $ = id => document.getElementById(id);
  const show = (id, on) => { $(id).hidden = !on; };

  const configured = !/COLE_AQUI/.test(SUPABASE_URL) && !/COLE_AQUI/.test(SUPABASE_ANON_KEY);
  if (!configured || !window.supabase || !window.supabase.createClient) {
    show("loadingView", false);
    show("cfgView", true);
    if (configured) {
      $("cfgView").querySelector("p").textContent = "Não foi possível carregar a biblioteca do Supabase. Verifique sua conexão com a internet e recarregue a página.";
    }
    return;
  }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---------- Estado ----------
  let db = { materias: [], entradas: [], saidas: [] };
  let profiles = [];            // linhas de public.profiles
  let me = null;                // { id, username, isAdmin }
  let channel = null;
  let wasDown = false;
  let hiddenAt = 0;
  let loadSeq = 0;

  // ---------- Utilidades ----------
  const today = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const fmtNum = n => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  const fmtDate = s => s ? s.split("-").reverse().join("/") : "";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const mpById = id => db.materias.find(m => m.id === id);
  const fmtDM = s => s ? s.split("-").reverse().slice(0, 2).join("/") : "";
  const mpLabel = m => m ? (m.codigo ? `${m.codigo} – ${m.nome}` : m.nome) : "(removida)";
  const fmtDT = s => s ? new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  // Nome do usuário a partir do id (profiles é carregado junto com os dados)
  const uname = id => { if (!id) return ""; const p = profiles.find(x => x.id === id); return p ? p.username : "usuário removido"; };
  // Célula "Registrado por": quem cadastrou e, se houver, quem editou por último
  function autorCell(r) {
    const c = r.createdBy ? esc(uname(r.createdBy)) : '<span class="muted">—</span>';
    const u = r.updatedBy
      ? `<div class="autor-edit">editado por ${esc(uname(r.updatedBy))}${r.updatedAt ? " em " + esc(fmtDT(r.updatedAt)) : ""}</div>`
      : "";
    return `<td class="autor">${c}${u}</td>`;
  }
  const fmtMin = n => (Number(n) > 0 ? fmtNum(n) : "—");
  const errMsg = e => (e && e.message) ? e.message : String(e);

  let toastTimer;
  function toast(msg, error = false) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "show" + (error ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.className = "", error ? 4500 : 2800);
  }

  // Executa fn desabilitando o botão (evita envio duplicado) e mostra erros em toast
  async function locked(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(errMsg(e), true); }
    finally { btn.disabled = false; }
  }

  function totais(mpId) {
    const ent = db.entradas.filter(e => e.mpId === mpId).reduce((s, e) => s + Number(e.qtd), 0);
    const sai = db.saidas.filter(e => e.mpId === mpId).reduce((s, e) => s + Number(e.qtd), 0);
    return { ent, sai, saldo: ent - sai };
  }

  // ---------- Mapeamento banco <-> memória ----------
  const COLS = {
    materias: ["codigo", "nome", "unidade", "minimo"],
    entradas: ["mp_id", "data", "qtd", "fornecedor", "doc", "obs"],
    saidas:   ["mp_id", "data", "qtd", "destino", "resp", "obs"],
  };
  const autoria = r => ({ createdBy: r.created_by || null, updatedBy: r.updated_by || null, updatedAt: r.updated_at || "" });
  function fromRow(t, r) {
    if (t === "materias") {
      return { id: r.id, codigo: r.codigo ?? "", nome: r.nome, unidade: r.unidade, minimo: Number(r.minimo) || 0, ...autoria(r) };
    }
    const o = { id: r.id, mpId: r.mp_id, data: r.data, qtd: Number(r.qtd), createdAt: r.created_at || "", ...autoria(r) };
    (t === "entradas" ? ["fornecedor", "doc", "obs"] : ["destino", "resp", "obs"]).forEach(k => o[k] = r[k] ?? "");
    return o;
  }
  function toRow(t, rec) {
    const o = {};
    COLS[t].forEach(c => { o[c] = c === "mp_id" ? rec.mpId : rec[c]; });
    return o;
  }
  function upsertLocal(t, rec) {
    const i = db[t].findIndex(x => x.id === rec.id);
    if (i >= 0) db[t][i] = rec; else db[t].push(rec);
  }

  async function fetchAll(table) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select("*").order("id").range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  async function refetchAll() {
    const seq = ++loadSeq;
    const [m, e, s, p] = await Promise.all(["materias", "entradas", "saidas", "profiles"].map(fetchAll));
    if (seq !== loadSeq || !me) return;   // chegou resposta mais nova ou saiu da conta
    db = {
      materias: m.map(r => fromRow("materias", r)),
      entradas: e.map(r => fromRow("entradas", r)),
      saidas: s.map(r => fromRow("saidas", r)),
    };
    profiles = p;
    syncMe();
    reconcileForms();
    renderAll();
    loadHistorico();
  }

  // ---------- Abas ----------
  function showTab(tab) {
    if (tab === "usuarios" && !(me && me.isAdmin)) tab = "estoque";
    if (!document.querySelector(`[data-tab="${tab}"]`) || !document.getElementById(tab)) tab = "estoque";
    document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll("section").forEach(s => s.classList.toggle("active", s.id === tab));
    try { localStorage.setItem(KEY + "-tab", tab); } catch (e) {}
  }
  document.querySelectorAll("[data-tab]").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

  // ---------- Matérias-primas ----------
  function resetMpForm() {
    $("mpForm").reset();
    $("mpId").value = "";
    $("mpMinimo").value = "";
    $("mpFormTitle").textContent = "Cadastrar matéria-prima";
    $("mpSubmit").textContent = "Cadastrar";
    $("mpCancel").hidden = true;
  }

  $("mpForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const id = $("mpId").value;
    const data = {
      codigo: $("mpCodigo").value.trim(),
      nome: $("mpNome").value.trim(),
      unidade: $("mpUnidade").value,
      minimo: Number($("mpMinimo").value) || 0,
    };
    if (!data.nome) return toast("Informe o nome da matéria-prima.", true);
    const dup = db.materias.find(m => m.id !== id && (
      norm(m.nome) === norm(data.nome) || (data.codigo && norm(m.codigo) === norm(data.codigo))
    ));
    if (dup) return toast("Já existe uma matéria-prima com esse nome ou código.", true);

    locked($("mpSubmit"), async () => {
      const q = id
        ? sb.from("materias").update(toRow("materias", data)).eq("id", id)
        : sb.from("materias").insert(toRow("materias", data));
      const { data: rows, error } = await q.select();
      if (error) throw error;
      if (!rows || !rows.length) throw new Error("Registro não encontrado (talvez tenha sido excluído por outro usuário).");
      upsertLocal("materias", fromRow("materias", rows[0]));
      toast(id ? "Matéria-prima atualizada." : "Matéria-prima cadastrada.");
      resetMpForm(); renderAll();
    });
  });
  $("mpCancel").addEventListener("click", resetMpForm);
  $("mpBusca").addEventListener("input", renderMaterias);

  function editMp(id) {
    const m = mpById(id); if (!m) return;
    $("mpId").value = m.id;
    $("mpCodigo").value = m.codigo;
    $("mpNome").value = m.nome;
    $("mpUnidade").value = m.unidade;
    $("mpMinimo").value = m.minimo > 0 ? m.minimo : "";
    $("mpFormTitle").textContent = "Editar matéria-prima";
    $("mpSubmit").textContent = "Salvar alterações";
    $("mpCancel").hidden = false;
    $("mpNome").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function delMp(id) {
    const m = mpById(id); if (!m) return;
    const movs = db.entradas.filter(e => e.mpId === id).length + db.saidas.filter(e => e.mpId === id).length;
    const msg = movs
      ? `Excluir "${m.nome}"? Isso também vai apagar ${movs} movimentação(ões) de entrada/saída dela.`
      : `Excluir "${m.nome}"?`;
    if (!confirm(msg)) return;
    try {
      const { error } = await sb.from("materias").delete().eq("id", id);
      if (error) throw error;
    } catch (e) { return toast(errMsg(e), true); }
    removeMateriaLocal(id);
    reconcileForms(); renderAll();
    toast("Matéria-prima excluída.");
  }
  function removeMateriaLocal(id) {
    db.materias = db.materias.filter(x => x.id !== id);
    db.entradas = db.entradas.filter(x => x.mpId !== id);
    db.saidas = db.saidas.filter(x => x.mpId !== id);
  }

  function situacao(m, saldo) {
    if (saldo <= 0) return { key: "out", badge: '<span class="badge out">Sem estoque</span>' };
    if (m.minimo > 0 && saldo < m.minimo) return { key: "low", badge: '<span class="badge low">Abaixo do mínimo</span>' };
    return { key: "ok", badge: '<span class="badge ok">OK</span>' };
  }

  // Mais recentes primeiro (data desc; depois ordem de criação desc)
  const byRecent = (a, b) => (b.data || "").localeCompare(a.data || "") || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));

  function obsCell(mpId) {
    const list = db.entradas.filter(e => e.mpId === mpId && String(e.obs || "").trim()).sort(byRecent);
    if (!list.length) return '<span class="muted">—</span>';
    const e = list[0];
    const more = list.length > 1 ? ` <span class="obs-more">+${list.length - 1}</span>` : "";
    return `<span class="obs-cell" title="${esc(e.obs)}"><span class="obs-date">${esc(fmtDM(e.data))}</span> ${esc(e.obs)}</span>${more}`;
  }

  function renderEstoque() {
    const q = norm($("estBusca").value);
    const filtro = $("estFiltro").value;
    let low = 0, out = 0;
    const rows = [...db.materias]
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
      .map(m => {
        const t = totais(m.id);
        const sit = situacao(m, t.saldo);
        if (sit.key === "out") out++; else if (sit.key === "low") low++;
        if (q && !norm(m.nome).includes(q) && !norm(m.codigo).includes(q)) return "";
        if (filtro && filtro !== sit.key) return "";
        return `<tr class="clickable" data-act="det-mp" data-id="${esc(m.id)}" tabindex="0">
          <td>${esc(m.codigo)}</td><td><strong>${esc(m.nome)}</strong></td><td>${esc(m.unidade)}</td>
          <td class="num">${fmtNum(t.ent)}</td><td class="num">${fmtNum(t.sai)}</td>
          <td class="num"><strong>${fmtNum(t.saldo)}</strong></td><td class="num">${fmtMin(m.minimo)}</td>
          <td>${sit.badge}</td>
          <td>${obsCell(m.id)}</td></tr>`;
      }).join("");
    $("estTabela").innerHTML = rows || `<tr><td colspan="9" class="empty">${db.materias.length ? "Nenhum resultado para a busca." : "Nenhuma matéria-prima cadastrada ainda. Cadastre na aba Matérias-primas."}</td></tr>`;
    $("stTotal").textContent = db.materias.length;
    $("stLow").textContent = low;
    $("stOut").textContent = out;
  }
  $("estBusca").addEventListener("input", renderEstoque);
  $("estFiltro").addEventListener("change", renderEstoque);

  function renderMaterias() {
    const q = norm($("mpBusca").value);
    const rows = [...db.materias]
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
      .filter(m => !q || norm(m.nome).includes(q) || norm(m.codigo).includes(q))
      .map(m => `<tr>
          <td>${esc(m.codigo)}</td><td><strong>${esc(m.nome)}</strong></td><td>${esc(m.unidade)}</td>
          <td class="num">${fmtMin(m.minimo)}</td>
          <td class="num"><strong>${fmtNum(totais(m.id).saldo)}</strong></td>
          ${autorCell(m)}
          <td class="acts">
            <button class="small" data-act="edit-mp" data-id="${esc(m.id)}">Editar</button>
            <button class="small danger" data-act="del-mp" data-id="${esc(m.id)}">Excluir</button>
          </td></tr>`).join("");
    $("mpTabela").innerHTML = rows || `<tr><td colspan="7" class="empty">${db.materias.length ? "Nenhum resultado para a busca." : "Nenhuma matéria-prima cadastrada ainda. Use o formulário acima."}</td></tr>`;
  }

  // ---------- Detalhes da matéria-prima (modal) ----------
  let detId = null;
  function openDet(id) {
    if (!mpById(id)) return;
    detId = id;
    renderDet();
    $("detModal").hidden = false;
    $("detClose").focus();
  }
  function closeDet() { detId = null; $("detModal").hidden = true; }

  function renderDet() {
    if (!detId) return;
    const m = mpById(detId);
    if (!m) return closeDet();
    const t = totais(m.id);
    const sit = situacao(m, t.saldo);
    $("detHead").innerHTML = `<h2>${esc(m.nome)}</h2>
      <p class="muted">${m.codigo ? `Código ${esc(m.codigo)} · ` : ""}Unidade ${esc(m.unidade)}</p>
      <p>Saldo: <strong>${fmtNum(t.saldo)} ${esc(m.unidade)}</strong> · Mínimo: ${fmtMin(m.minimo)} · ${sit.badge}</p>`;
    const movs = [
      ...db.entradas.filter(e => e.mpId === m.id).map(e => ({ ...e, tipo: "in" })),
      ...db.saidas.filter(e => e.mpId === m.id).map(e => ({ ...e, tipo: "out" })),
    ].sort(byRecent);
    $("detLista").innerHTML = movs.map(r => {
      const isIn = r.tipo === "in";
      const quem = isIn
        ? [r.fornecedor, r.doc].filter(Boolean).join(" / ")
        : [r.destino, r.resp].filter(Boolean).join(" / ");
      return `<li class="${r.tipo}">
        <span class="obs-date">${esc(fmtDate(r.data))}</span>
        ${isIn ? '<span class="badge in">Entrada</span>' : '<span class="badge outflow">Saída</span>'}
        <strong>${isIn ? "+" : "−"}${fmtNum(r.qtd)} ${esc(m.unidade)}</strong>
        ${quem ? `<span class="muted">${esc(quem)}</span>` : ""}
        ${r.createdBy ? `<span class="autor-tag">por ${esc(uname(r.createdBy))}${r.updatedBy ? ` · editado por ${esc(uname(r.updatedBy))}` : ""}</span>` : ""}
        <div>${r.obs ? esc(r.obs) : '<span class="muted">—</span>'}</div>
      </li>`;
    }).join("") || '<li class="empty">Nenhuma movimentação registrada.</li>';
  }

  $("detClose").addEventListener("click", closeDet);
  $("detModal").addEventListener("click", ev => { if (ev.target === $("detModal")) closeDet(); });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && !$("detModal").hidden) closeDet();
    else if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches && ev.target.matches("tr.clickable")) {
      ev.preventDefault(); openDet(ev.target.dataset.id);
    }
  });

  // ---------- Movimentações (entradas e saídas) ----------
  function setupMov(prefix, listName, extraFields, tipo) {
    const f = name => $(prefix + name);
    const isSaida = listName === "saidas";
    const Tipo = tipo[0].toUpperCase() + tipo.slice(1);

    function reset() {
      f("Form").reset();
      f("Id").value = "";
      f("Data").value = today();
      f("FormTitle").textContent = `Registrar ${tipo}`;
      f("Submit").textContent = `Registrar ${tipo}`;
      f("Cancel").hidden = true;
      updateHint();
    }

    function updateHint() {
      const m = mpById(f("Mp").value);
      if (!m) { f("Hint").textContent = db.materias.length ? "" : "Cadastre uma matéria-prima antes de registrar movimentações."; return; }
      f("Hint").textContent = `Saldo atual de ${m.nome}: ${fmtNum(totais(m.id).saldo)} ${m.unidade}`;
    }

    f("Form").addEventListener("submit", ev => {
      ev.preventDefault();
      const id = f("Id").value;
      const mpId = f("Mp").value;
      const qtd = Number(f("Qtd").value);
      if (!mpById(mpId)) return toast("Selecione uma matéria-prima.", true);
      if (!(qtd > 0)) return toast("A quantidade deve ser maior que zero.", true);

      if (isSaida) {
        let saldo = totais(mpId).saldo;
        const old = id && db.saidas.find(s => s.id === id);
        if (old && old.mpId === mpId) saldo += Number(old.qtd);
        if (qtd > saldo) {
          const m = mpById(mpId);
          if (!confirm(`Saldo insuficiente: disponível ${fmtNum(saldo)} ${m.unidade}. Registrar mesmo assim (o saldo ficará negativo)?`)) return;
        }
      }

      const rec = { mpId, qtd, data: f("Data").value };
      extraFields.forEach(k => rec[k.toLowerCase()] = f(k).value.trim());

      locked(f("Submit"), async () => {
        const q = id
          ? sb.from(listName).update(toRow(listName, rec)).eq("id", id)
          : sb.from(listName).insert(toRow(listName, rec));
        const { data: rows, error } = await q.select();
        if (error) throw error;
        if (!rows || !rows.length) throw new Error("Registro não encontrado (talvez tenha sido excluído por outro usuário).");
        upsertLocal(listName, fromRow(listName, rows[0]));
        toast(`${Tipo} ${id ? "atualizada" : "registrada"}.`);
        reset(); renderAll();
      });
    });

    f("Cancel").addEventListener("click", reset);
    f("Mp").addEventListener("change", updateHint);
    f("Busca").addEventListener("input", render);
    f("FiltroMp").addEventListener("change", render);

    function edit(id) {
      const r = db[listName].find(x => x.id === id); if (!r) return;
      f("Id").value = r.id;
      f("Data").value = r.data;
      f("Mp").value = r.mpId;
      f("Qtd").value = r.qtd;
      extraFields.forEach(k => f(k).value = r[k.toLowerCase()] || "");
      f("FormTitle").textContent = `Editar ${tipo}`;
      f("Submit").textContent = "Salvar alterações";
      f("Cancel").hidden = false;
      updateHint();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    async function del(id) {
      if (!confirm(`Excluir esta ${tipo}?`)) return;
      try {
        const { error } = await sb.from(listName).delete().eq("id", id);
        if (error) throw error;
      } catch (e) { return toast(errMsg(e), true); }
      db[listName] = db[listName].filter(x => x.id !== id);
      reconcileForms(); renderAll();
      toast(`${Tipo} excluída.`);
    }

    function render() {
      const q = norm(f("Busca").value);
      const filtro = f("FiltroMp").value;
      const list = [...db[listName]]
        .sort((a, b) => (b.data || "").localeCompare(a.data || ""))
        .filter(r => !filtro || r.mpId === filtro)
        .filter(r => {
          if (!q) return true;
          const m = mpById(r.mpId);
          return norm([mpLabel(m), fmtDate(r.data), ...extraFields.map(k => r[k.toLowerCase()])].join(" ")).includes(q);
        });
      const sinal = isSaida ? "−" : "+";
      const cor = isSaida ? "var(--red)" : "var(--green)";
      f("Tabela").innerHTML = list.map(r => {
        const m = mpById(r.mpId);
        return `<tr>
          <td>${fmtDate(r.data)}</td><td>${esc(mpLabel(m))}</td>
          <td class="num" style="color:${cor};font-weight:600">${sinal}${fmtNum(r.qtd)} ${esc(m ? m.unidade : "")}</td>
          ${extraFields.map(k => `<td>${esc(r[k.toLowerCase()])}</td>`).join("")}
          ${autorCell(r)}
          <td class="acts">
            <button class="small" data-act="edit-${prefix}" data-id="${esc(r.id)}">Editar</button>
            <button class="small danger" data-act="del-${prefix}" data-id="${esc(r.id)}">Excluir</button>
          </td></tr>`;
      }).join("") || `<tr><td colspan="${5 + extraFields.length}" class="empty">${db[listName].length ? "Nenhum resultado." : `Nenhuma ${tipo} registrada ainda.`}</td></tr>`;
    }

    function fillSelects() {
      const opts = [...db.materias].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
        .map(m => `<option value="${esc(m.id)}">${esc(mpLabel(m))} (${esc(m.unidade)})</option>`).join("");
      const cur = f("Mp").value, curF = f("FiltroMp").value;
      f("Mp").innerHTML = `<option value="">Selecione...</option>` + opts;
      f("FiltroMp").innerHTML = `<option value="">Todas as matérias-primas</option>` + opts;
      if (mpById(cur)) f("Mp").value = cur;
      if (mpById(curF)) f("FiltroMp").value = curF;
      updateHint();
    }

    return { reset, render, fillSelects, edit, del, formId: () => f("Id").value, listName };
  }

  const entradas = setupMov("en", "entradas", ["Fornecedor", "Doc", "Obs"], "entrada");
  const saidas = setupMov("sa", "saidas", ["Destino", "Resp", "Obs"], "saída");

  // Cancela edições cujo registro não existe mais (ex.: excluído por outra pessoa)
  function reconcileForms() {
    const id = $("mpId").value;
    if (id && !mpById(id)) { resetMpForm(); toast("A matéria-prima que você editava foi excluída por outro usuário.", true); }
    [entradas, saidas].forEach(mv => {
      const eid = mv.formId();
      if (eid && !db[mv.listName].some(x => x.id === eid)) { mv.reset(); toast("O registro que você editava foi excluído por outro usuário.", true); }
    });
  }

  // ---------- Usuários (admin) ----------
  function renderUsers() {
    if (!me || !me.isAdmin) return;
    const rows = [...profiles].sort((a, b) => a.username.localeCompare(b.username, "pt-BR")).map(p => {
      const self = p.id === me.id;
      const d = p.created_at ? new Date(p.created_at).toLocaleDateString("pt-BR") : "";
      return `<tr>
        <td><strong>${esc(p.username)}</strong>${self ? ' <span class="tag">(você)</span>' : ""}</td>
        <td>${p.is_admin ? "Sim" : "Não"}</td><td>${esc(d)}</td>
        <td class="acts">
          <button class="small" data-act="pw-user" data-id="${esc(p.id)}">Redefinir senha</button>
          <button class="small" data-act="adm-user" data-id="${esc(p.id)}">${p.is_admin ? "Remover admin" : "Tornar admin"}</button>
          ${self ? "" : `<button class="small danger" data-act="del-user" data-id="${esc(p.id)}">Excluir</button>`}
        </td></tr>`;
    }).join("");
    $("usTabela").innerHTML = rows || `<tr><td colspan="4" class="empty">Nenhum usuário.</td></tr>`;
  }

  async function refetchProfiles() {
    profiles = await fetchAll("profiles");
    syncMe();
    renderUsers();
  }

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw error;
    return data;
  }

  $("usForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const username = $("usNome").value.trim().toLowerCase();
    const password = $("usSenha").value;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return toast("Usuário inválido: use 3 a 30 caracteres (letras, números, ponto, hífen ou sublinhado).", true);
    if (password.length < 4) return toast("A senha deve ter pelo menos 4 caracteres.", true);
    locked($("usSubmit"), async () => {
      await rpc("admin_create_user", { p_username: username, p_password: password, p_is_admin: $("usAdmin").checked });
      $("usForm").reset();
      toast("Usuário criado.");
      await refetchProfiles();
    });
  });

  async function userAction(act, id) {
    const p = profiles.find(x => x.id === id); if (!p) return;
    try {
      if (act === "pw-user") {
        const senha = prompt(`Nova senha para "${p.username}" (mínimo 4 caracteres):`);
        if (senha === null) return;
        if (senha.length < 4) return toast("A senha deve ter pelo menos 4 caracteres.", true);
        await rpc("admin_set_password", { p_user_id: id, p_password: senha });
        toast("Senha redefinida.");
      } else if (act === "adm-user") {
        await rpc("admin_set_admin", { p_user_id: id, p_is_admin: !p.is_admin });
        toast(p.is_admin ? "Permissão de administrador removida." : "Usuário agora é administrador.");
        await refetchProfiles();
      } else if (act === "del-user") {
        if (!confirm(`Excluir o usuário "${p.username}"? Ele não poderá mais entrar no sistema.`)) return;
        await rpc("admin_delete_user", { p_user_id: id });
        toast("Usuário excluído.");
        await refetchProfiles();
      }
    } catch (e) { toast(errMsg(e), true); }
  }

  // ---------- Alterar senha ----------
  $("btnPass").addEventListener("click", () => { $("passForm").reset(); show("passModal", true); $("pwOld").focus(); });
  $("pwCancel").addEventListener("click", () => show("passModal", false));
  $("passForm").addEventListener("submit", ev => {
    ev.preventDefault();
    if ($("pwNew").value !== $("pwNew2").value) return toast("As senhas novas não conferem.", true);
    if ($("pwNew").value.length < 4) return toast("A nova senha deve ter pelo menos 4 caracteres.", true);
    locked($("pwSubmit"), async () => {
      await rpc("change_my_password", { p_old: $("pwOld").value, p_new: $("pwNew").value });
      show("passModal", false);
      toast("Senha alterada.");
    });
  });

  // ---------- Ações das tabelas (delegação de eventos) ----------
  document.addEventListener("click", ev => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    if (b.tagName === "TR" && ev.target.closest("button, a, input, select")) return;
    const { act, id } = b.dataset;
    if (act.endsWith("-user")) return userAction(act, id);
    ({
      "edit-mp": editMp, "del-mp": delMp, "det-mp": openDet,
      "edit-en": entradas.edit, "del-en": entradas.del,
      "edit-sa": saidas.edit, "del-sa": saidas.del,
    })[act]?.(id);
  });

  // ---------- Backup ----------
  $("btnExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `estoque-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Backup exportado.");
  });

  const chunks = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };

  // Envia dados no formato antigo ({materias, entradas, saidas}) para o banco compartilhado (somente adiciona)
  async function importarDados(d) {
    const str = v => (v == null ? "" : String(v));
    const idMap = new Map();          // id antigo -> uuid novo
    const byName = new Map(db.materias.map(m => [norm(m.nome), m.id]));
    const novas = [];                 // { oldId, row }
    const nomesNovas = new Map();     // nome normalizado -> oldId da primeira ocorrência
    let reaproveitadas = 0;

    for (const m of d.materias) {
      const nome = str(m.nome).trim();
      if (!nome) continue;
      const k = norm(nome);
      if (byName.has(k)) { idMap.set(m.id, byName.get(k)); reaproveitadas++; continue; }
      if (nomesNovas.has(k)) { idMap.set(m.id, nomesNovas.get(k)); continue; }
      nomesNovas.set(k, m.id);
      novas.push({ oldId: m.id, row: { codigo: str(m.codigo).trim(), nome, unidade: str(m.unidade) || "un", minimo: Number(m.minimo) || 0 } });
    }
    // resolve apelidos internos do backup (nomes repetidos apontam para a 1ª ocorrência)
    for (const grupo of chunks(novas, 500)) {
      const { data, error } = await sb.from("materias").insert(grupo.map(x => x.row)).select();
      if (error) throw error;
      data.forEach((r, i) => {
        idMap.set(grupo[i].oldId, r.id);
        upsertLocal("materias", fromRow("materias", r));
      });
    }
    // ids de duplicatas internas que apontavam para oldId da 1ª ocorrência
    for (const [oldId, alvo] of [...idMap]) if (idMap.has(alvo) && idMap.get(alvo) !== alvo) idMap.set(oldId, idMap.get(alvo));

    const resumo = { materias: novas.length, reaproveitadas, entradas: 0, saidas: 0, ignorados: 0 };
    for (const [t, lista, extras] of [["entradas", d.entradas, ["fornecedor", "doc", "obs"]], ["saidas", d.saidas, ["destino", "resp", "obs"]]]) {
      const rows = [];
      for (const r of lista) {
        const mp = idMap.get(r.mpId);
        const qtd = Number(r.qtd);
        if (!mp || !(qtd > 0)) { resumo.ignorados++; continue; }
        const row = { mp_id: mp, data: str(r.data).slice(0, 10) || today(), qtd };
        extras.forEach(k => row[k] = str(r[k]));
        rows.push(row);
      }
      for (const grupo of chunks(rows, 500)) {
        const { data, error } = await sb.from(t).insert(grupo).select();
        if (error) throw error;
        data.forEach(r => upsertLocal(t, fromRow(t, r)));
        resumo[t] += data.length;
      }
    }
    renderAll();
    return resumo;
  }
  const resumoTxt = r => `${r.materias} matéria(s)-prima(s) nova(s), ${r.entradas} entrada(s) e ${r.saidas} saída(s) enviadas` +
    (r.reaproveitadas ? ` (${r.reaproveitadas} matéria(s) já existiam e foram reaproveitadas)` : "") +
    (r.ignorados ? `; ${r.ignorados} registro(s) inválido(s) ignorado(s)` : "") + ".";

  const validBackup = d => d && Array.isArray(d.materias) && Array.isArray(d.entradas) && Array.isArray(d.saidas);

  $("btnImport").addEventListener("click", () => $("fileImport").click());
  $("fileImport").addEventListener("change", ev => {
    const input = ev.target;
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      input.value = "";
      let d;
      try { d = JSON.parse(reader.result); if (!validBackup(d)) throw new Error(); }
      catch (e) { return toast("Arquivo de backup inválido.", true); }
      if (!confirm("Enviar este backup para o banco compartilhado? Os registros serão ADICIONADOS aos que já existem (nada será apagado). Matérias-primas com o mesmo nome serão reaproveitadas, sem duplicar.")) return;
      locked($("btnImport"), async () => {
        const r = await importarDados(d);
        toast("Backup importado: " + resumoTxt(r));
      });
    };
    reader.readAsText(file);
  });

  // Dados antigos do navegador (versão sem banco compartilhado)
  const DISMISS_KEY = KEY + "-local-dispensado";
  function dadosLocais() {
    try {
      if (localStorage.getItem(DISMISS_KEY)) return null;
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!validBackup(d)) return null;
      return (d.materias.length || d.entradas.length || d.saidas.length) ? d : null;
    } catch (e) { return null; }
  }
  function dispensarLocal() {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch (e) {}
    show("localBanner", false);
  }
  function checkLocalBanner() { show("localBanner", !!dadosLocais()); }
  $("localSkip").addEventListener("click", dispensarLocal);
  $("localSend").addEventListener("click", () => {
    const d = dadosLocais(); if (!d) return dispensarLocal();
    locked($("localSend"), async () => {
      const r = await importarDados(d);
      dispensarLocal();
      toast("Dados enviados: " + resumoTxt(r));
    });
  });


  // ---------- Histórico de alterações ----------
  let historico = [];          // mais recentes primeiro
  let hiFim = false, hiErro = false;
  const HI_PAGE = 300;
  const ACOES = { insert: ["Inclusão", "in"], update: ["Alteração", "low"], delete: ["Exclusão", "out"] };
  const CAMPOS = {
    codigo: "código", nome: "nome", unidade: "unidade", minimo: "estoque mínimo", mp_id: "matéria-prima",
    data: "data", qtd: "quantidade", fornecedor: "fornecedor", doc: "doc.", obs: "observação",
    destino: "destino", resp: "responsável",
  };

  async function fetchHistorico(antesDe) {
    let q = sb.from("historico").select("*").order("id", { ascending: false }).limit(HI_PAGE);
    if (antesDe) q = q.lt("id", antesDe);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }
  async function loadHistorico() {
    const seq = loadSeq;
    try {
      const d = await fetchHistorico();
      if (seq !== loadSeq || !me) return;
      historico = d; hiFim = d.length < HI_PAGE; hiErro = false;
    } catch (e) {
      if (seq !== loadSeq || !me) return;
      historico = []; hiFim = true; hiErro = true;   // script 002_autoria.sql ainda não rodado
    }
    renderHistorico();
  }

  const quemHist = h => h.usuario || uname(h.usuario_id) || "—";
  function nomeMp(id, d) {
    const m = mpById(id); if (m) return m.nome;
    if (d && d.mp_nome) return d.mp_nome;
    const h = historico.find(x => x.tabela === "materias" && x.registro_id === id && x.dados);
    return h ? h.dados.nome : "matéria-prima excluída";
  }
  function fmtCampo(k, v) {
    if (v === null || v === undefined || v === "") return "vazio";
    if (k === "data") return fmtDate(v);
    if (k === "qtd" || k === "minimo") return fmtNum(v);
    if (k === "mp_id") return nomeMp(v);
    return String(v);
  }
  function descHist(h) {
    const d = h.dados || {};
    let txt;
    if (h.tabela === "materias") {
      const verbo = { insert: "Cadastrou", update: "Editou", delete: "Excluiu" }[h.acao] || h.acao;
      txt = `${verbo} a matéria-prima ${d.nome || ""}${d.codigo ? ` (${d.codigo})` : ""}`;
    } else {
      const tipo = h.tabela === "entradas" ? "entrada" : "saída";
      const verbo = { insert: "Registrou", update: "Editou", delete: "Excluiu" }[h.acao] || h.acao;
      const un = d.mp_unidade || (mpById(d.mp_id) || {}).unidade || "";
      txt = `${verbo} ${tipo} de ${fmtNum(d.qtd)} ${un} de ${nomeMp(d.mp_id, d)} (${fmtDate(d.data)})`;
    }
    let mud = "";
    if (h.acao === "update" && h.anterior) {
      const lista = Object.keys(CAMPOS)
        .filter(k => k in d && JSON.stringify(h.anterior[k] ?? null) !== JSON.stringify(d[k] ?? null))
        .map(k => `${CAMPOS[k]}: ${fmtCampo(k, h.anterior[k])} → ${fmtCampo(k, d[k])}`);
      if (lista.length) mud = lista.join("; ");
    }
    return { txt, mud };
  }

  function renderHistorico() {
    const sel = $("hiUsuario"), cur = sel.value;
    const nomes = [...new Set(historico.map(quemHist))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    sel.innerHTML = '<option value="">Todos os usuários</option>' + nomes.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    if (nomes.includes(cur)) sel.value = cur;
    const fu = sel.value, ft = $("hiTipo").value, q = norm($("hiBusca").value);
    const rows = historico
      .filter(h => (!fu || quemHist(h) === fu) && (!ft || h.tabela === ft))
      .map(h => ({ h, ...descHist(h) }))
      .filter(x => !q || norm([x.txt, x.mud, quemHist(x.h), fmtDT(x.h.quando)].join(" ")).includes(q))
      .map(({ h, txt, mud }) => {
        const [rot, cls] = ACOES[h.acao] || [h.acao, "ok"];
        return `<tr>
          <td class="nowrap">${esc(fmtDT(h.quando))}</td>
          <td><strong>${esc(quemHist(h))}</strong></td>
          <td><span class="badge ${cls}">${esc(rot)}</span></td>
          <td>${esc(txt)}${mud ? `<div class="autor-edit">${esc(mud)}</div>` : ""}</td></tr>`;
      }).join("");
    $("hiTabela").innerHTML = rows || `<tr><td colspan="4" class="empty">${
      hiErro ? "O histórico ainda não foi ativado no banco de dados."
      : historico.length ? "Nenhum resultado." : "Nenhuma alteração registrada ainda."}</td></tr>`;
    $("hiMais").hidden = hiFim;
  }
  $("hiUsuario").addEventListener("change", renderHistorico);
  $("hiTipo").addEventListener("change", renderHistorico);
  $("hiBusca").addEventListener("input", renderHistorico);
  $("hiMais").addEventListener("click", () => locked($("hiMais"), async () => {
    const last = historico[historico.length - 1];
    const d = await fetchHistorico(last && last.id);
    historico.push(...d.filter(x => !historico.some(h => h.id === x.id)));
    hiFim = d.length < HI_PAGE;
    renderHistorico();
  }));

  // ---------- Tempo real ----------
  function setLive(on) {
    const el = $("liveInd");
    el.textContent = on ? "Ao vivo" : "Reconectando";
    el.className = "live " + (on ? "on" : "off");
  }

  function onChange(table, p) {
    if (!me) return;
    if (table === "historico") {
      if (p.eventType === "INSERT" && !historico.some(h => h.id === p.new.id)) {
        historico.unshift(p.new);
        historico.sort((a, b) => b.id - a.id);
        renderHistorico();
      }
      return;
    }
    if (table === "profiles") {
      if (p.eventType === "DELETE") {
        profiles = profiles.filter(x => x.id !== p.old.id);
        if (p.old.id === me.id) return sb.auth.signOut();
      } else {
        const i = profiles.findIndex(x => x.id === p.new.id);
        if (i >= 0) profiles[i] = p.new; else profiles.push(p.new);
      }
      syncMe(); renderUsers();
      return;
    }
    if (p.eventType === "DELETE") {
      if (table === "materias") removeMateriaLocal(p.old.id);
      else db[table] = db[table].filter(x => x.id !== p.old.id);
    } else {
      upsertLocal(table, fromRow(table, p.new));
    }
    reconcileForms();
    renderAll();
  }

  function subscribe() {
    unsubscribe();
    channel = sb.channel("estoque-realtime");
    ["materias", "entradas", "saidas", "profiles", "historico"].forEach(t =>
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, p => onChange(t, p)));
    channel.subscribe(status => {
      if (status === "SUBSCRIBED") {
        setLive(true);
        if (wasDown) { wasDown = false; refetchAll().catch(e => toast(errMsg(e), true)); }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        wasDown = true;
        setLive(false);
      }
    });
  }
  function unsubscribe() {
    if (channel) { try { sb.removeChannel(channel); } catch (e) {} channel = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (me && hiddenAt && Date.now() - hiddenAt > 60000) {
      refetchAll().catch(e => toast(errMsg(e), true));
    }
    hiddenAt = 0;
  });

  // ---------- Sessão / login ----------
  function syncMe() {
    if (!me) return;
    const p = profiles.find(x => x.id === me.id);
    if (p) { me.username = p.username; me.isAdmin = !!p.is_admin; }
    $("whoAmI").textContent = me.username + (me.isAdmin ? " (admin)" : "");
    $("navUsuarios").hidden = !me.isAdmin;
    if (!me.isAdmin && $("usuarios").classList.contains("active")) showTab("estoque");
  }

  function renderAll() {
    renderEstoque(); renderMaterias(); renderDet();
    entradas.fillSelects(); saidas.fillSelects();
    entradas.render(); saidas.render();
    renderUsers();
    renderHistorico();
  }

  async function startApp(user) {
    if (me && me.id === user.id) return;       // já iniciado (evento repetido)
    me = { id: user.id, username: String(user.email || "").split("@")[0], isAdmin: false };
    show("loginView", false); show("loadingView", true);
    try {
      subscribe();
      await refetchAll();
      if (!profiles.some(p => p.id === me.id)) throw new Error("Usuário não encontrado.");
    } catch (e) {
      const m = errMsg(e);
      await stopApp();
      await sb.auth.signOut().catch(() => {});
      showLogin(m);
      return;
    }
    resetMpForm(); entradas.reset(); saidas.reset();
    show("loadingView", false); show("app", true);
    let tab = "estoque";
    try { tab = localStorage.getItem(KEY + "-tab") || tab; } catch (e) {}
    showTab(tab);
    checkLocalBanner();
  }

  async function stopApp() {
    unsubscribe();
    me = null; loadSeq++;
    db = { materias: [], entradas: [], saidas: [] };
    profiles = [];
    historico = []; hiFim = false; hiErro = false;
    wasDown = false;
    closeDet();
    show("app", false); show("passModal", false); show("localBanner", false);
  }

  function showLogin(msg) {
    show("loadingView", false); show("app", false); show("loginView", true);
    $("loginErr").textContent = msg || "";
    $("loginPass").value = "";
    $("loginUser").focus();
  }

  $("loginForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const username = $("loginUser").value.trim().toLowerCase();
    locked($("loginBtn"), async () => {
      $("loginErr").textContent = "";
      const { data, error } = await sb.auth.signInWithPassword({ email: username + EMAIL_DOMAIN, password: $("loginPass").value });
      if (error) {
        $("loginErr").textContent = (error.status && error.status >= 500) || /fetch|network/i.test(error.message || "")
          ? "Não foi possível conectar ao servidor. Tente novamente."
          : "Usuário ou senha inválidos";
        return;
      }
      await startApp(data.user);
    });
  });

  $("btnLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    await stopApp();
    $("loginUser").value = "";
    showLogin();
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && me) {
      setTimeout(async () => { await stopApp(); showLogin(); }, 0);
    }
  });

  (async () => {
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) return await startApp(data.session.user);
    } catch (e) {}
    showLogin();
  })();
})();
