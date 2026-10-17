/**
 * 里程碑验收托管平台 · 前端逻辑
 *
 * 9 个页面按真实动线组织：
 *   工作台 · 项目列表 · 项目详情 · 规则库 · 创建项目 · 交付 · 验收 · 结算 · 争议 · 信任机制
 *
 * 所有操作走真实 API。验收会真的拉起隔离进程跑交付物代码。
 */

(function () {
  'use strict';

  // ════════════ 状态 ════════════
  const S = {
    token: localStorage.getItem('ms_token'),
    address: localStorage.getItem('ms_address'),
    role: localStorage.getItem('ms_role'),
    projectId: null,
    project: null,
    templates: [],
    rejected: [],
    selectedRule: null,
    /** 验收规格覆盖（仅测试用）。正常签约走标准模板生成。 */
    specOverride: null,
    page: 'dashboard',
    busy: false,
  };

  const ROLES = {
    client:     { label: '甲方',   icon: '甲', color: 'var(--blue)' },
    provider:   { label: '乙方',   icon: '乙', color: 'var(--green)' },
    arbitrator: { label: '仲裁者', icon: '裁', color: 'var(--violet)' },
    collector:  { label: '采集器', icon: '采', color: 'var(--amber)' },
  };

  /**
   * 页面可见性 —— 前端展示层的权限控制。
   *
   * ⚠️ 重要：这不是安全边界。
   * 后端接口仍会自行校验地址归属，这里只决定「看不看得见入口」。
   * 前端隐藏只是避免用户看到无权操作的按钮，不能替代后端校验。
   */
  const PAGE_ROLES = {
    dashboard:  ['client', 'provider', 'arbitrator', 'collector'],
    projects:   ['client', 'provider', 'arbitrator', 'collector'],
    rules:      ['client', 'provider', 'arbitrator', 'collector'],
    create:     ['client'],
    delivery:   ['provider'],
    verify:     ['client', 'collector'],
    settlement: ['client', 'provider', 'arbitrator'],
    disputes:   ['client', 'provider', 'arbitrator'],
    trust:      ['client', 'provider', 'arbitrator', 'collector'],
  };

  /** 该角色能否访问某页面 */
  function canSee(page) {
    const allowed = PAGE_ROLES[page];
    if (!allowed) return true;          // 未登记的页面不限制
    return allowed.includes(S.role);
  }

  const PAGE_META = {
    dashboard:  { t: '工作台',        d: '你现在该处理的事' },
    projects:   { t: '我的项目',      d: '甲方与乙方视角的项目' },
    detail:     { t: '项目详情',      d: '里程碑 · 资金 · 审计轨迹' },
    rules:      { t: '验收规则库',    d: '标准化模板，防止任意改判定标准' },
    create:     { t: '创建项目',      d: '配置里程碑并锁定验收规格' },
    delivery:   { t: '交付提交',      d: '只存哈希，源码不落链' },
    verify:     { t: '执行验收',      d: '平台真实运行交付物并测量' },
    settlement: { t: '资金结算',      d: '全程托管，验收通过才放行' },
    disputes:   { t: '争议仲裁',      d: '挑战期机制与独立裁定' },
    trust:      { t: '信任机制',      d: '不靠信任，靠机制' },
  };

  const roleLabel = (r) => (ROLES[r] || { label: r || '未知' }).label;

  /** 地址比较（忽略大小写） */
  const sameAddr = (a, b) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

  const MS_LABEL = {
    pending: '待提交', submitted: '待验收', passed: '验收通过',
    failed: '验收不通过', challenged: '争议中', released: '已放款',
    refunded: '已退款', settled: '已结算', rejected: '需返工',
  };

  // ════════════ 工具 ════════════
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');

  const fmtEther = (v) => {
    const n = Number(v || 0);
    if (!n) return '0';
    return n >= 1e18 ? (n / 1e18).toFixed(2) : n.toFixed(2);
  };

  /** 安全事件绑定：元素不存在时跳过，不让整个应用崩掉 */
  const on = (sel, evt, fn) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.addEventListener(evt, fn);
  };

  const API = (() => {
    if (location.protocol === 'file:') return 'http://localhost:4000';
    if (location.port === '4000') return '';
    return location.origin;
  })();

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(S.token ? { authorization: 'Bearer ' + S.token } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
    return json;
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      setTimeout(() => el.remove(), 320);
    }, 3800);
  }

  function setBusy(b, tx) {
    S.busy = b;
    const el = $('#busy');
    el.classList.toggle('on', b);
    if (tx) $('#busyTx').textContent = tx;
  }

  // ════════════ 路由 ════════════
  function go(page, opts = {}) {
    if (!PAGE_META[page]) page = 'dashboard';

    /**
     * 无权访问时兜底到工作台。
     * 即便用户手动改 URL hash 或直接调 go()，也进不去。
     */
    if (!canSee(page)) {
      if (!opts.silent) {
        toast(`「${PAGE_META[page].t}」需要${roleLabel(S.role)}以外的角色权限`, 'warn');
      }
      page = S.projectId ? 'detail' : 'dashboard';
    }

    S.page = page;

    $$('.page').forEach((p) => p.classList.toggle('on', p.id === 'page-' + page));
    $$('.nav-i').forEach((n) => n.classList.toggle('on', n.dataset.page === page));

    const meta = PAGE_META[page];
    $('#pageTitle').textContent = meta.t;
    $('#pageDesc').textContent = meta.d;

    // 关闭移动端侧栏
    $('#sidebar').classList.remove('open');
    $('#sbMask').classList.remove('on');

    if (!opts.silent) window.scrollTo({ top: 0, behavior: 'smooth' });
    route(page);
  }

  function route(page) {
    switch (page) {
      case 'dashboard':  return renderDashboard();
      case 'projects':   return renderProjectList();
      case 'detail':     return S.projectId ? renderDetail() : go('projects');
      case 'rules':      return renderRules();
      case 'create':     return renderCreate();
      case 'delivery':   return renderDelivery();
      case 'verify':     return renderVerifyPage();
      case 'settlement': return renderSettlement();
      case 'disputes':   return renderDisputes();
      case 'trust':      return renderTrust();
    }
  }

  // ════════════ 登录 ════════════
  $$('.role').forEach((b) => b.addEventListener('click', () => {
    $$('.role').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
  }));

  /**
   * 演示账号点击填充。
   *
   * 角色由 HTML 的 data-role 显式声明 —— 不再用地址前缀猜。
   * 早期版本靠 `0x111…` / `0x222…` 判断角色，切到链上真实地址后完全失效。
   */
  $$('.demo-a').forEach((b) => b.addEventListener('click', () => {
    $('#loginAddr').value = b.dataset.fill;
    const want = b.dataset.role;
    if (want) {
      $$('.role').forEach((x) => x.classList.toggle('sel', x.dataset.role === want));
    }
  }));

  on('#pasteBtn', 'click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      $('#loginAddr').value = t.trim();
      toast('已粘贴', 'ok');
    } catch {
      $('#loginAddr').focus();
      toast('浏览器不允许读取剪贴板，请手动粘贴', 'warn');
    }
  });

  on('#loginBtn', 'click', doLogin);
  on('#loginAddr', 'keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const address = $('#loginAddr').value.trim();
    const role = $('.role.sel')?.dataset.role || 'client';
    const nickname = $('#loginName').value.trim() || address.slice(0, 8);

    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return toast('钱包地址格式不正确（0x + 40 位十六进制）', 'bad');
    }

    setBusy(true, '登录中…');
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { address, role, nickname } });
      S.token = r.token; S.address = r.address; S.role = r.role;
      localStorage.setItem('ms_token', r.token);
      localStorage.setItem('ms_address', r.address);
      localStorage.setItem('ms_role', r.role);
      enterApp();
      toast(`欢迎，${nickname}（${ROLES[role].label}）`, 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  on('#logoutBtn', 'click', () => {
    ['ms_token', 'ms_address', 'ms_role'].forEach((k) => localStorage.removeItem(k));
    location.reload();
  });

  function enterApp() {
    $('#authView').classList.add('hidden');
    $('#appView').classList.remove('hidden');

    const r = ROLES[S.role] || { label: S.role, icon: '●', color: 'var(--blue)' };
    $('#sbRole').textContent = r.label;
    $('#sbAvatar').textContent = r.icon;
    $('#sbAvatar').style.background = `linear-gradient(135deg,${r.color},var(--violet))`;
    $('#sbAddr').textContent = short(S.address);

    applyNavPermissions();
    go('dashboard');
  }

  // ════════════ 数据加载 ════════════
  async function loadProjects() {
    try {
      return await api('/api/projects');
    } catch {
      return { projects: [] };
    }
  }

  /**
   * 拉取项目详情。
   *
   * 加了请求序号（_seq）防止竞态：多个页面快速切换时会并发触发多次请求，
   * 若不丢弃过期响应，「先发后到」的旧数据会覆盖新数据，
   * 表现为界面显示陈旧状态（例如验收已通过却仍显示"待验收"）。
   */
  let projectSeq = 0;
  async function loadProject() {
    if (S.projectId == null) return null;
    const seq = ++projectSeq;
    try {
      const d = await api('/api/projects/' + S.projectId);
      if (seq !== projectSeq) return S.project; // 过期响应，丢弃
      S.project = d;
      return d;
    } catch (e) {
      if (seq === projectSeq) toast(e.message, 'bad');
      return null;
    }
  }

  // ════════════ ① 工作台 ════════════
  async function renderDashboard() {
    const { projects } = await loadProjects();

    let total = 0, released = 0, refunded = 0, pending = 0, challenges = 0;
    for (const p of projects) {
      total += Number(p.total);
      if (p.status === 'draft') pending++;
    }
    if (S.project) {
      const pay = S.project.payout || { released: 0, refunded: 0 };
      released += Number(pay.released);
      refunded += Number(pay.refunded);
    }
    if (S.project?.milestones?.some((m) => m.status === 'challenged')) challenges++;

    const kpis = [
      { lb: '我的项目', num: projects.length, sub: `${pending} 个待双签`, c: 'var(--blue)' },
      { lb: '托管中总额', num: total, sub: `${fmtEther(total)} TUSD`, c: 'var(--violet)' },
      { lb: '已放款', num: released, sub: `${fmtEther(released)} TUSD`, c: 'var(--green)' },
      { lb: '待处理争议', num: challenges, sub: challenges ? '需尽快处理' : '暂无', c: 'var(--amber)' },
    ];
    $('#kpiRow').innerHTML = kpis.map((k) => `
      <div class="kpi" style="--c:${k.c}">
        <div class="kpi-lb">${k.lb}</div>
        <div class="kpi-num">${k.num}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>`).join('');

    // 待办：按角色生成
    const todos = [];
    if (S.role === 'client') {
      projects.filter((p) => p.status === 'draft').forEach((p) =>
        todos.push({ p: '高', c: 'var(--red)', t: `双签并注资：${p.title}`, d: '规则已锁定，等待双方签署', page: 'detail', id: p.id }));
    }
    if (S.role === 'provider') {
      projects.filter((p) => p.status === 'funded').forEach((p) =>
        todos.push({ p: '高', c: 'var(--amber)', t: `提交交付：${p.title}`, d: '项目已注资，可以开始交付', page: 'delivery', id: p.id }));
    }
    if (S.role === 'client' || S.role === 'collector') {
      (S.project?.milestones || []).filter((m) => m.status === 'submitted').forEach((m) =>
        todos.push({ p: '高', c: 'var(--blue)', t: `执行验收：里程碑 ${m.idx} ${m.title}`, d: '已提交交付，待客观验收', page: 'verify' }));
    }
    if (S.project?.milestones?.some((m) => m.status === 'passed')) {
      todos.push({ p: '中', c: 'var(--green)', t: '里程碑验收已通过', d: '挑战期内无异议即可放款', page: 'settlement' });
    }
    if (challenges) {
      todos.push({ p: '高', c: 'var(--violet)', t: '存在争议待仲裁', d: '需要仲裁者介入裁定', page: 'disputes' });
    }

    $('#todoList').innerHTML = todos.length ? todos.map((t, i) => `
      <div class="todo" data-page="${t.page}" data-id="${t.id ?? ''}" data-i="${i}">
        <span class="td-pri" style="--c:${t.c}"></span>
        <span class="td-tx"><span class="td-t">${esc(t.t)}</span><span class="td-d">${esc(t.d)}</span></span>
        <span class="td-act">处理 →</span>
      </div>`).join('')
      : '<div class="empty">当前没有待办事项</div>';

    $$('#todoList .todo').forEach((el) => el.addEventListener('click', () => {
      if (el.dataset.id) S.projectId = Number(el.dataset.id);
      go(el.dataset.page);
    }));

    $('#dashProjects').innerHTML = projects.length ? projects.map((p) => projectRow(p)).join('')
      : '<div class="empty">还没有项目，去「创建项目」开始</div>';
    bindProjectRows('#dashProjects');

    // 资金概览
    const remain = total - fmtEther(released) - fmtEther(refunded);
    const pc = (v) => (total > 0 ? Math.max(0, (v / total) * 100) : 0);
    $('#dashPayoutBar').innerHTML = `
      <div class="pb-seg rel" style="width:${pc(released)}%">${pc(released) > 12 ? '已放款 ' + fmtEther(released) : ''}</div>
      <div class="pb-seg ref" style="width:${pc(refunded)}%">${pc(refunded) > 12 ? '已退款 ' + fmtEther(refunded) : ''}</div>
      <div class="pb-seg rem" style="width:${pc(remain)}%">${pc(remain) > 12 ? '托管中 ' + remain.toFixed(0) : ''}</div>`;
    $('#dashPayoutNums').innerHTML = `
      <div class="pn-box ok"><span>已放款给乙方</span><b>${fmtEther(released)}</b></div>
      <div class="pn-box bad"><span>已退款给甲方</span><b>${fmtEther(refunded)}</b></div>
      <div class="pn-box"><span>托管中</span><b>${remain.toFixed(2)}</b></div>`;
  }

  function projectRow(p) {
    return `<div class="pl-item" data-id="${p.id}">
      <span class="pl-t">${esc(p.title)}</span>
      <span class="pl-s st-${esc(p.status)}">${esc(p.status)}</span>
      <span class="pl-m">${p.role === 'client' ? '我是甲方' : '我是乙方'}</span>
      <span class="pl-a">${fmtEther(p.total)} TUSD</span>
    </div>`;
  }

  function bindProjectRows(sel) {
    $$(`${sel} .pl-item`).forEach((el) => el.addEventListener('click', () => {
      S.projectId = Number(el.dataset.id);
      go('detail');
    }));
  }

  // ════════════ ② 项目列表 ════════════
  let projFilter = 'all';
  $$('#projFilters .filt').forEach((b) => b.addEventListener('click', () => {
    $$('#projFilters .filt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    projFilter = b.dataset.f;
    renderProjectList(true);
  }));

  async function renderProjectList(cached) {
    if (!cached) {
      const { projects } = await loadProjects();
      S._projects = projects;
    }
    const list = S._projects || [];
    const filtered = projFilter === 'all' ? list
      : projFilter === 'draft' ? list.filter((p) => p.status === 'draft')
      : list.filter((p) => p.status !== 'draft');

    $('#projList').innerHTML = filtered.length ? filtered.map((p) => projectRow(p)).join('')
      : '<div class="empty">没有符合条件的项目</div>';
    bindProjectRows('#projList');
  }

  // ════════════ ③ 项目详情 ════════════
  async function renderDetail() {
    const d = await loadProject();
    if (!d) return;
    const p = d.project;

    $('#detailHeader').innerHTML = `
      <div class="ph-t">${esc(p.title)}</div>
      <div class="ph-meta">
        <span class="pl-s st-${esc(p.status)}">${esc(p.status)}</span>
        <span>规则 ${esc(p.ruleSetId)}</span>
        <span>总额 ${fmtEther(p.total)} TUSD</span>
      </div>
      <div class="ph-parties">
        <div class="pp"><i style="--c:var(--blue)"></i><span>甲方</span><b>${short(p.client)}</b></div>
        <div class="pp"><i style="--c:var(--green)"></i><span>乙方</span><b>${short(p.provider)}</b></div>
        <div class="pp"><i style="--c:var(--violet)"></i><span>仲裁者</span><b>${short(p.arbitrator)}</b></div>
      </div>
      <div class="ph-hash">规格哈希 <b>${short(p.specHash)}</b><em>双方签署后不可单方变更</em></div>
      <div class="p-actions">
        ${
          /**
           * 按钮可见性 = 角色匹配 + 地址归属。
           *
           * 只看角色不够：任何登录用户都能在登录时自称「甲方」，
           * 所以必须再校验这个地址在该项目里的真实身份。
           */
          (() => {
            const isClient = S.role === 'client' && sameAddr(S.address, p.client);
            const isProvider = S.role === 'provider' && sameAddr(S.address, p.provider);
            const isArbitrator = S.role === 'arbitrator' && sameAddr(S.address, p.arbitrator);
            if (p.status !== 'draft') return '';

            let html = '';
            if (isClient || isProvider) {
              html += '<button class="btn-primary" id="dSign">签署规则</button>';
            }
            if (isClient) {
              html += '<button class="btn-ok" id="dFund">注资全部款项</button>';
            }
            if (isArbitrator) {
              html += '<span style="font-size:11.5px;color:var(--violet);align-self:center">你是仲裁者 · 争议时可裁定</span>';
            }
            if (!html) {
              html = '<span style="font-size:11.5px;color:var(--ink-3);align-self:center">你不是本项目参与方，仅可查看</span>';
            }
            return html;
          })()
        }
        <button class="btn-ghost" id="dGoVerify">去验收</button>
        <button class="btn-ghost" id="dGoSettle">查看资金</button>
      </div>`;

    on('#dSign', 'click', () => act(`/api/projects/${S.projectId}/sign`, {}, '签署成功'));
    on('#dFund', 'click', () => act(`/api/projects/${S.projectId}/fund`, {}, '注资成功，款项已托管'));
    on('#dGoVerify', 'click', () => go('verify'));
    on('#dGoSettle', 'click', () => go('settlement'));

    $('#detailMs').innerHTML = d.milestones.map((m) => msCard(m)).join('');
    bindMsActions('#detailMs');

    $('#detailAudit').innerHTML = d.audit.length ? d.audit.map((a) => `
      <div class="al">
        <span class="al-dot"></span>
        <span class="al-a">${esc(a.action)}</span>
        <span class="al-who">${short(a.actor)}</span>
        <span class="al-t">${new Date(a.at).toLocaleString()}</span>
      </div>`).join('') : '<div class="empty">暂无审计记录</div>';
  }

  function msCard(m) {
    const done = ['released', 'passed', 'settled'].includes(m.status);
    const p = S.project?.project || {};

    /**
     * 操作可见性 = 角色匹配 且 该地址确为此项目对应角色。
     * 单看角色不够 —— 登录时角色是客户端自称，任何人都能填「甲方」。
     */
    const isClient = S.role === 'client' && sameAddr(S.address, p.client);
    const isProvider = S.role === 'provider' && sameAddr(S.address, p.provider);
    const isArbitrator = S.role === 'arbitrator' && sameAddr(S.address, p.arbitrator);
    const isCollector = S.role === 'collector';

    let acts = '';
    if ((m.status === 'pending' || m.status === 'rejected') && isProvider) {
      acts += `<button class="mini-btn2 pri" data-a="deliver" data-i="${m.idx}">提交交付</button>`;
    }
    if (m.status === 'submitted' && (isClient || isCollector)) {
      acts += `<button class="mini-btn2 pri" data-a="verify" data-i="${m.idx}">执行验收</button>`;
    }
    if (m.status === 'passed' && (isClient || isProvider)) {
      acts += `<button class="mini-btn2 ok" data-a="release" data-i="${m.idx}">放款</button>
               <button class="mini-btn2" data-a="challenge" data-i="${m.idx}">发起挑战</button>`;
    }
    if (m.status === 'failed' && isClient) {
      acts += `<button class="mini-btn2" data-a="refund" data-i="${m.idx}">退款</button>`;
    }
    if (m.status === 'challenged' && isArbitrator) {
      acts += `<button class="mini-btn2 pri" data-a="arbitrate" data-i="${m.idx}">裁定分配</button>`;
    }
    if (m.status === 'challenged' && !isArbitrator) {
      acts += '<span style="font-size:11px;color:var(--ink-3);align-self:center">争议中 · 等待仲裁者裁定</span>';
    }

    return `<div class="ms-card ${done ? 'done' : ''}">
      <div class="mc-top">
        <span class="mc-idx">${m.idx}</span>
        <span class="mc-name">${esc(m.title)}</span>
        <span class="mc-amt">${fmtEther(m.amount)} <span>TUSD</span></span>
      </div>
      <div class="mc-mid">
        <span class="mc-st st-${esc(m.status)}">${esc(m.statusLabel || MS_LABEL[m.status] || m.status)}</span>
        ${m.score != null ? `<span class="mc-score">${m.score} 分</span>` : ''}
        ${m.facts ? `<span class="mc-facts">${(m.facts.testPassRate / 100).toFixed(0)}/${(m.facts.apiAvailability / 100).toFixed(0)}/${(m.facts.fieldCoverage / 100).toFixed(0)}</span>` : ''}
      </div>
      ${m.factsHash ? `<div class="mc-hash">${short(m.factsHash)}</div>` : ''}
      ${acts ? `<div class="mc-acts">${acts}</div>` : ''}
    </div>`;
  }

  function bindMsActions(sel) {
    $$(`${sel} .mini-btn2[data-a]`).forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a, i = Number(b.dataset.i);
      if (a === 'deliver') { $('#dMilestone').value = String(i); go('delivery'); }
      else if (a === 'verify') { $('#vMilestone').value = String(i); go('verify'); }
      else if (a === 'release') act(`/api/projects/${S.projectId}/milestones/${i}/release`, {}, '已放款给乙方');
      else if (a === 'refund') act(`/api/projects/${S.projectId}/milestones/${i}/refund`, {}, '已退款给甲方');
      else if (a === 'challenge') {
        const note = prompt('挑战说明（可选）');
        if (note === null) return;
        act(`/api/projects/${S.projectId}/milestones/${i}/challenge`, { reason: 'dispute', note }, '挑战已提交，等待仲裁');
      } else if (a === 'arbitrate') {
        const bps = prompt('乙方应得比例（0-100）', '70');
        if (bps == null) return;
        act(`/api/projects/${S.projectId}/milestones/${i}/arbitrate`,
          { providerBps: Math.round(Number(bps) * 100) }, '裁定完成');
      }
    }));
  }

  async function act(path, body, okMsg) {
    setBusy(true);
    try {
      const r = await api(path, { method: 'POST', body });
      toast(okMsg, 'ok');
      await loadProject();
      route(S.page);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  // ════════════ ④ 规则库 ════════════
  async function renderRules() {
    if (!S.templates.length) {
      try {
        const r = await api('/api/rules');
        S.templates = r.templates;
        S.rejected = r.rejected || [];
      } catch (e) {
        return toast(e.message, 'bad');
      }
    }

    $('#ruleGrid').innerHTML = S.templates.map((t, idx) => `
      <div class="rule-card" data-id="${t.id}">
        <span class="rc-beam"></span>
        <div class="rc-top">
          <div class="rc-name">${esc(t.name)}</div>
          <div class="rc-score"><b>${t.passThreshold}</b><span>通过线</span></div>
        </div>
        <div class="rc-tag">${esc(t.tagline)}</div>
        <div class="rc-bars">
          ${meter('必测通过率', t.required.test, t.weights.test)}
          ${meter('接口可用率', t.required.api, t.weights.api)}
          ${meter('字段覆盖率', t.required.field, t.weights.field)}
        </div>
        <div class="rc-foot">${t.facts.map((f) => `<span>${esc(f.label)}</span>`).join('')}</div>
      </div>`).join('');

    // 选中态
    if (S.selectedRule) {
      const el = $(`#ruleGrid .rule-card[data-id="${S.selectedRule.id}"]`);
      if (el) el.classList.add('sel');
    }

    $$('#ruleGrid .rule-card').forEach((el) => el.addEventListener('click', () => {
      $$('#ruleGrid .rule-card').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      S.selectedRule = S.templates.find((t) => t.id === el.dataset.id);
      // 触发进度条动画
      requestAnimationFrame(() => {
        el.querySelectorAll('.rb-bar i').forEach((b) => (b.style.width = b.dataset.w));
      });
      toast(`已选「${S.selectedRule.name}」，通过线 ${S.selectedRule.passThreshold} 分`, 'ok');
    }));

    $('#rejectList').innerHTML = (S.rejected.length ? S.rejected : [
      { type: '设计 / 创意', reason: '设计好坏无客观标准，强行量化会退化为 AI 主观判定' },
      { type: '观点 / 策略类文档', reason: '无可复算的验收依据' },
    ]).map((r) => `
      <div class="rj">
        <span class="rj-ico">⊘</span>
        <div><b>${esc(r.type)}</b><span>${esc(r.reason)}</span></div>
      </div>`).join('');
  }

  function meter(label, req, weight) {
    return `<div>
      <div class="rb-l">${label}<span>≥${req / 100}% · 权重${weight / 100}%</span></div>
      <div class="rb-bar"><i data-w="${req / 100}%"></i></div>
    </div>`;
  }

  // ════════════ ⑤ 创建项目 ════════════
  let createRendered = false;

  function renderCreate() {
    if (!S.templates.length) renderRules();

    if (!createRendered) {
      $('#cRule').innerHTML = S.templates.map((t) =>
        `<option value="${t.id}">${esc(t.name)} · 通过线 ${t.passThreshold}</option>`).join('');
      const list = $('#cMsList');
      const seeds = [['接口实现', 40], ['联调与自测', 30], ['文档与交接', 30]];
      list.innerHTML = seeds.map(([t, a], i) => `
        <div class="ms-row">
          <span class="ms-idx">${i + 1}</span>
          <input class="ms-title" value="${esc(t)}">
          <input class="ms-amt" type="number" min="1" value="${a}">
          <span class="ms-unit">TUSD</span>
        </div>`).join('');
      createRendered = true;
      recalcTotal();
    }

    on('#cAddMs', 'click', () => {
      const list = $('#cMsList');
      if (list.children.length >= 10) return toast('最多 10 个里程碑', 'warn');
      const i = list.children.length;
      const d = document.createElement('div');
      d.className = 'ms-row';
      d.innerHTML = `<span class="ms-idx">${i + 1}</span><input class="ms-title" value="里程碑 ${i + 1}">
        <input class="ms-amt" type="number" min="1" value="10"><span class="ms-unit">TUSD</span>`;
      list.appendChild(d);
      recalcTotal();
    });

    on('#cBack', 'click', () => go('rules'));
  }

  function recalcTotal() {
    let t = 0;
    $$('#cMsList .ms-amt').forEach((i) => (t += Number(i.value) || 0));
    $('#cTotal').textContent = t;
  }

  document.addEventListener('input', (e) => {
    if (e.target.classList?.contains('ms-amt')) recalcTotal();
  });

  on('#createBtn', 'click', async () => {
    const ruleId = $('#cRule').value;
    const rule = S.templates.find((t) => t.id === ruleId);
    const milestones = $$('#cMsList .ms-row').map((r) => ({
      title: r.querySelector('.ms-title').value.trim() || '未命名',
      amount: Number(r.querySelector('.ms-amt').value) || 0,
    })).filter((m) => m.amount > 0);

    if (!milestones.length) return toast('至少配置一个有效里程碑', 'warn');

    setBusy(true, '创建中…');
    try {
      const r = await api('/api/projects', {
        method: 'POST',
        body: {
          title: $('#cTitle').value.trim() || '未命名项目',
          providerAddr: $('#cProvider').value.trim(),
          arbitratorAddr: $('#cArb').value.trim(),
          ruleSetId: ruleId,
          deliverableType: rule?.deliverableType,
          milestones,
          ...(S.specOverride ? { __specOverride: S.specOverride } : {}),
        },
      });
      S.projectId = r.projectId;
      S.selectedRule = rule;
      toast(`项目已创建 · 规格哈希 ${String(r.specHash).slice(0, 14)}…`, 'ok');
      await loadProject();
      go('detail');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  });

  // ════════════ ⑥ 交付 ════════════
  // ════════════ ⑥ 交付上传 ════════════
  const MAX_UPLOAD = 50 * 1024 * 1024;
  let pickedFile = null;

  async function renderDelivery() {
    const d = await loadProject();
    if (!d) { toast('请先选择一个项目', 'warn'); return go('projects'); }
    $('#dMilestone').innerHTML = d.milestones.map((m) =>
      `<option value="${m.idx}">${m.idx} · ${esc(m.title)} · ${fmtEther(m.amount)} TUSD</option>`).join('');
  }

  /** 选择文件后的统一处理 */
  function acceptFile(file) {
    if (!file) return;
    const okExt = /\.(zip|tar\.gz|tgz|tar)$/i.test(file.name);
    if (!okExt) {
      return toast('只接受 .zip / .tar.gz / .tgz / .tar 格式', 'bad');
    }
    if (file.size > MAX_UPLOAD) {
      return toast(`文件过大（${(file.size / 1048576).toFixed(1)}MB），上限 50MB`, 'bad');
    }
    if (file.size === 0) {
      return toast('文件为空', 'bad');
    }
    pickedFile = file;
    $('#dzIdle').classList.add('hidden');
    $('#dzFile').classList.remove('hidden');
    $('#dzName').textContent = file.name;
    $('#dzSize').textContent = (file.size / 1024).toFixed(1) + ' KB';
    $('#deliverBtn').disabled = false;
  }

  function clearFile() {
    pickedFile = null;
    $('#dzIdle').classList.remove('hidden');
    $('#dzFile').classList.add('hidden');
    $('#dzProgress').classList.add('hidden');
    $('#upResult').classList.add('hidden');
    $('#fileInput').value = '';
    $('#deliverBtn').disabled = true;
  }

  // 拖拽
  const dz = $('#dropZone');
  ['dragenter', 'dragover'].forEach((ev) =>
    on(dz, ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    on(dz, ev, (e) => { e.preventDefault(); e.stopPropagation(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('over'); }));
  on(dz, 'drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptFile(f);
  });
  on(dz, 'click', () => $('#fileInput').click());
  on('#fileInput', 'change', (e) => acceptFile(e.target.files?.[0]));
  on('#dzClear', 'click', (e) => { e.stopPropagation(); clearFile(); });

  /**
   * 执行上传。抽成独立函数以便按钮点击与自动化测试共用同一条路径 ——
   * 测试走的就是真实上传逻辑，不存在「测试专用分支」。
   */
  async function uploadDelivery(idxOverride) {
    if (!pickedFile) return toast('请先选择文件', 'warn');
    const idx = Number(idxOverride ?? $('#dMilestone').value);

    const fd = new FormData();
    fd.append('file', pickedFile, pickedFile.name);
    fd.append('note', $('#dNote').value.trim() || '');

    // 进度条：用 XHR 才能拿到 upload.onprogress
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/api/projects/${S.projectId}/milestones/${idx}/upload`);
      xhr.setRequestHeader('authorization', 'Bearer ' + S.token);

      $('#dzIdle').classList.add('hidden');
      $('#dzFile').classList.add('hidden');
      $('#dzProgress').classList.remove('hidden');
      $('#deliverBtn').disabled = true;

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        $('#dzpBar').style.width = pct + '%';
        $('#dzpTx').textContent = pct < 100 ? `上传中… ${pct}%` : '服务器处理中…';
      };

      xhr.onload = () => {
        try {
          const j = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            $('#dzpBar').style.width = '100%';
            $('#dzpTx').textContent = '上传完成';
            renderUploadResult(j);
            toast(`交付物已锁定 · 哈希 ${j.hash.slice(0, 14)}…`, 'ok');
            loadProject();
            // 1.5 秒后跳到详情页看结果
            setTimeout(() => go('detail'), 1500);
          } else {
            $('#dzpTx').textContent = '上传失败';
            $('#deliverBtn').disabled = false;
            toast(j.error || '上传失败', 'bad');
          }
        } catch {
          $('#dzpTx').textContent = '响应解析失败';
          $('#deliverBtn').disabled = false;
        }
        resolve();
      };
      xhr.onerror = () => {
        $('#dzpTx').textContent = '网络错误';
        $('#deliverBtn').disabled = false;
        toast('网络错误，请重试', 'bad');
        resolve();
      };
      xhr.send(fd);
    });
  }

  on('#deliverBtn', 'click', () => uploadDelivery());

  function renderUploadResult(r) {
    const box = $('#upResult');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="upr-card">
        <div class="upr-row"><span>文件</span><b>${esc(r.originalName)}</b></div>
        <div class="upr-row"><span>SHA-256</span><b class="mono">${r.hash}</b></div>
        <div class="upr-row"><span>本地指针</span><b class="mono">${esc(r.uri)}</b></div>
        <div class="upr-row"><span>大小</span><b>${(r.size / 1024).toFixed(1)} KB · ${r.fileCount} 个文件</b></div>
        <div class="upr-row"><span>链上交易</span><b class="mono">${short(r.txHash)}</b></div>
        <div class="upr-note">${esc(r.nextStep || '')}</div>
      </div>`;
  }

  // ════════════ ⑦ 验收（核心） ════════════
  async function renderVerifyPage() {
    const d = await loadProject();
    if (!d) { toast('请先选择一个项目', 'warn'); return go('projects'); }
    const opts = d.milestones.map((m) =>
      `<option value="${m.idx}">${m.idx} · ${esc(m.title)} · ${MS_LABEL[m.status] || m.status}</option>`).join('');
    const cur = $('#vMilestone').innerHTML;
    $('#vMilestone').innerHTML = opts;
    if (cur) $('#vMilestone').value = $('#vMilestone').value || '0';
  }

  on('#verifyBtn', 'click', async () => {
    const idx = Number($('#vMilestone').value);
    const pipe = $('#pipe');

    const STEPS = [
      '拉取交付物并按 commit 校验',
      '创建隔离运行时（独立 PG + KV）',
      '灌入锁定的种子数据',
      '执行必测测试组',
      '启动服务并多轮探测接口',
      '比对契约字段',
      '提交判定到链上',
    ];
    pipe.classList.remove('hidden');
    pipe.innerHTML = STEPS.map((s, i) => `
      <div class="pipe-item" data-i="${i}">
        <span class="pipe-n">${i + 1}</span><span>${esc(s)}</span>
      </div>`).join('');

    const items = $$('.pipe-item', pipe);
    let step = 0;
    const timer = setInterval(() => {
      if (step >= items.length) return;
      items[step].classList.add('run');
      setTimeout(() => {
        items[step].classList.remove('run');
        items[step].classList.add('done');
        step++;
      }, 850);
    }, 750);

    setBusy(true, '正在拉起隔离环境并运行交付物…');
    try {
      const r = await api(`/api/projects/${S.projectId}/milestones/${idx}/verify`, { method: 'POST' });
      clearInterval(timer);
      items.forEach((x) => { x.classList.remove('run'); x.classList.add('done'); });
      renderVerifyResult(r, idx);
      toast(r.result.passed ? '验收通过' : '验收不通过', r.result.passed ? 'ok' : 'warn');
      await loadProject();
    } catch (e) {
      clearInterval(timer);
      pipe.insertAdjacentHTML('beforeend', `<div class="pipe-err">✗ ${esc(e.message)}</div>`);
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  });

  function renderVerifyResult(r, idx) {
    const d = r.detail, g = r.result.gates;
    const CIRC = 2 * Math.PI * 38;
    const off = CIRC * (1 - r.result.score / 100);

    const m = (label, val, need, ok) => `
      <div class="meter ${ok ? 'ok' : 'bad'}">
        <div class="meter-top"><span>${label}</span><b>${(val / 100).toFixed(1)}%</b></div>
        <div class="meter-bar"><i style="width:${val / 100}%"></i><u style="left:${need / 100}%"></u></div>
        <div class="meter-foot">门槛 ${need / 100}% · ${ok ? '达标' : '未达标'}</div>
      </div>`;

    $('#verifyResult').innerHTML = `
      <div class="vr-head ${r.result.passed ? 'pass' : 'fail'}">
        <div class="vr-ring">
          <svg width="88" height="88" viewBox="0 0 88 88">
            <circle class="track" cx="44" cy="44" r="38"></circle>
            <circle class="prog" cx="44" cy="44" r="38"
              stroke-dasharray="${CIRC}" stroke-dashoffset="${off}"></circle>
          </svg>
          <div class="vr-score-in">${r.result.score}</div>
        </div>
        <div>
          <div class="vr-t">里程碑 ${idx} · ${r.result.passed ? '验收通过' : '验收不通过'}</div>
          <div class="vr-s">三维度硬门槛独立判定，任一不达标即整单否决</div>
          <div class="vr-gates">
            <span class="vgate ${g.test ? 'on' : 'off'}">测试 ${g.test ? '✓' : '✗'}</span>
            <span class="vgate ${g.api ? 'on' : 'off'}">接口 ${g.api ? '✓' : '✗'}</span>
            <span class="vgate ${g.field ? 'on' : 'off'}">字段 ${g.field ? '✓' : '✗'}</span>
          </div>
        </div>
      </div>

      <div class="meters">
        ${m('必测用例通过率', r.facts.testPassRate, 90, g.test)}
        ${m('接口可用率', r.facts.apiAvailability, 95, g.api)}
        ${m('契约字段覆盖率', r.facts.fieldCoverage, 90, g.field)}
      </div>

      <div class="vr-kv">
        <div><span>必测用例</span><b>${d.tests.passedRequired}/${d.tests.requiredCount}</b></div>
        <div><span>探测次数</span><b>${d.api.totalProbes || 0}</b></div>
        <div><span>平均延迟</span><b>${d.api.avgLatencyMs || 0}ms</b></div>
        <div><span>中间件</span><b>${esc(d.runtime.isolation)}</b></div>
        <div><span>种子数据</span><b>${d.runtime.seededRows} 行</b></div>
        <div><span>链上交易</span><b class="mono">${short(r.txHash)}</b></div>
      </div>

      ${d.tests.failedCases?.length ? `
        <div class="vr-fails">
          <div class="vf-t">失败用例（平台精确到用例名与原因）</div>
          ${d.tests.failedCases.map((c) => `<div class="vf-i">✗ ${esc(c.name)}<em>${esc(c.error)}</em></div>`).join('')}
        </div>` : ''}

      ${r.result.reasons?.length ? `
        <div class="vr-reasons">
          ${r.result.reasons.map((x) => `<div class="vreason">
            <b>${esc(x.dimension)}</b> 当前 ${x.current}${x.type === 'gate' ? '%' : ' 分'}，需要 ${x.need}${x.type === 'gate' ? '%' : ' 分'}
            <em>${esc(x.advice)}</em></div>`).join('')}
        </div>` : ''}

      <div class="vr-hash">事实报告哈希 <b>${r.reportHash}</b><br>
        任何人可用同一 commit + 同一规格重跑，验证结论一致</div>

      <div class="p-actions">
        <button class="btn-primary" id="vrGoDetail">查看项目详情</button>
        ${r.result.passed ? '<button class="btn-ok" id="vrGoSettle">去放款结算</button>' : ''}
      </div>`;

    on('#vrGoDetail', 'click', () => go('detail'));
    on('#vrGoSettle', 'click', () => go('settlement'));
  }

  // ════════════ ⑧ 结算 ════════════
  let setFilter = 'all';
  $$('#setFilter .filt').forEach((b) => b.addEventListener('click', () => {
    $$('#setFilter .filt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    setFilter = b.dataset.s;
    renderSettlement(true);
  }));

  async function renderSettlement(cached) {
    if (!cached) {
      const d = await loadProject();
      if (!d) { toast('请先选择一个项目', 'warn'); return go('projects'); }
    }
    const d = S.project;
    if (!d) return;

    const p = d.payout || { released: 0, refunded: 0, remaining: 0 };
    const total = Number(d.project.total) || 1;
    const pc = (v) => Math.max(0, (Number(v) / total) * 100);

    $('#setPayoutBar').innerHTML = `
      <div class="pb-seg rel" style="width:${pc(p.released)}%">${pc(p.released) > 10 ? '已放款 ' + fmtEther(p.released) : ''}</div>
      <div class="pb-seg ref" style="width:${pc(p.refunded)}%">${pc(p.refunded) > 10 ? '已退款 ' + fmtEther(p.refunded) : ''}</div>
      <div class="pb-seg rem" style="width:${pc(p.remaining)}%">${pc(p.remaining) > 10 ? '托管中 ' + fmtEther(p.remaining) : ''}</div>`;

    $('#setPayoutNums').innerHTML = `
      <div class="pn-box ok"><span>已放款给乙方</span><b>${fmtEther(p.released)} TUSD</b></div>
      <div class="pn-box bad"><span>已退款给甲方</span><b>${fmtEther(p.refunded)} TUSD</b></div>
      <div class="pn-box"><span>仍在托管</span><b>${fmtEther(p.remaining)} TUSD</b></div>`;

    const list = d.settlements.filter((s) =>
      setFilter === 'all' ? true
      : setFilter === 'release' ? s.type === 'release'
      : setFilter === 'refund' ? s.type === 'refund'
      : s.type.startsWith('arbitration'));

    const TYPE_CN = {
      release: '放款给乙方', refund: '退款给甲方',
      arbitration_split: '仲裁·乙方部分', arbitration_refund: '仲裁·甲方部分',
    };

    $('#settleList').innerHTML = list.length ? list.map((s) => `
      <div class="sl">
        <span class="sl-t">${esc(TYPE_CN[s.type] || s.type)}</span>
        <span class="sl-a">${fmtEther(s.amount)} TUSD</span>
        <span class="sl-to">→ ${short(s.to)}</span>
        <span class="sl-p">${esc(s.status)}</span>
        <span class="sl-s">已确认</span>
      </div>`).join('') : '<div class="empty">暂无结算记录</div>';
  }

  // ════════════ ⑨ 争议 ════════════
  async function renderDisputes() {
    const d = await loadProject();
    const challenged = d?.milestones?.filter((m) => m.status === 'challenged') || [];

    $('#navBadgeDisp').textContent = challenged.length;
    $('#navBadgeDisp').classList.toggle('show', challenged.length > 0);

    $('#disputeList').innerHTML = challenged.length ? challenged.map((m) => `
      <div class="dsp">
        <div class="dsp-h">
          <span class="dsp-p">里程碑 ${m.idx} · ${esc(m.title)}</span>
          <span class="mc-st st-challenged">争议中</span>
        </div>
        <div class="dsp-d">
          <div><span>涉及金额</span><b>${fmtEther(m.amount)} TUSD</b></div>
          <div><span>验收得分</span><b>${m.score ?? '-'} 分</b></div>
          <div><span>实测三维度</span><b>${m.facts
            ? `${(m.facts.testPassRate / 100).toFixed(0)}/${(m.facts.apiAvailability / 100).toFixed(0)}/${(m.facts.fieldCoverage / 100).toFixed(0)}`
            : '-'}</b></div>
        </div>
        <div class="dsp-acts">
          ${S.role === 'arbitrator'
            ? '<button class="mini-btn2 pri" data-dispute="arbitrate">裁定分配比例</button>'
            : '<span style="font-size:11.5px;color:var(--ink-3)">等待仲裁者裁定</span>'}
          <span style="font-size:11.5px;color:var(--ink-3)">实测事实不可篡改，仲裁只决定分配比例</span>
        </div>
      </div>`).join('') : '<div class="empty">当前没有争议</div>';

    $$('#disputeList [data-dispute]').forEach((b) => b.addEventListener('click', async () => {
      const m = challenged[0];
      const bps = prompt('乙方应得比例（0-100）', '70');
      if (bps == null) return;
      await act(`/api/projects/${S.projectId}/milestones/${m.idx}/arbitrate`,
        { providerBps: Math.round(Number(bps) * 100) }, '裁定完成，款项已按比例分配');
    }));
  }

  // ════════════ ⑩ 信任机制 ════════════
  const TRUST = [
    { c: '#4DA3FF', i: '◫', t: '规格签约锁定', d: '验收规则在乙方写代码之前就确定，哈希上链。甲方无法事后把必测用例从 100 条缩到 3 条。' },
    { c: '#34D399', i: '⚙', t: '平台自建环境', d: '验收在平台自己的沙箱里跑。没有「甲方提供接口地址」这种配置项，假接口这条路从架构上就不存在。' },
    { c: '#A78BFA', i: '◐', t: '事实可复算', d: '事实报告哈希上链。任何人用同一 commit + 同一规格重跑，都能得到完全一致的结论。' },
    { c: '#FBBF24', i: '⊘', t: '能力边界清晰', d: '设计稿、观点类交付一律不接。测不了的东西不假装能测 —— 这是可信度的前提。' },
  ];
  const LIMITS = [
    ['代码可维护性与架构', '需要人工评审，自动化测不出"写得漂不漂亮"'],
    ['规格清单外的场景', '平台只测双方约定清单内的接口与用例，这是双方的责任'],
    ['性能与容量', '需另配压测环境。内存数据库测不出真实数据库的性能特征'],
    ['隐藏后门与恶意逻辑', '只能辅以静态扫描与人工审计，无法完全自动化'],
    ['主观质量判断', '用户体验、文案、设计感 —— 无客观标准，强行量化就退化成 AI 主观判定'],
  ];
  const TECH = [
    ['隔离运行时', 'pg-mem 内存 PostgreSQL + 内存 KV（Redis 常用命令实现）。每个项目一份，互不可见。'],
    ['进程注入', 'global 变量无法跨进程传递，改用 <code>--require</code> 加载器在子进程内部注入运行时。'],
    ['种子数据传递', '父子进程内存不共享，种子数据写成 JSON 快照，由加载器在子进程导入并 await 完成。'],
    ['协议解耦', '交付物只连标准协议，不关心背后真假。生产环境把 runtime-bridge 换成真 pg / ioredis 即可。'],
  ];

  function renderTrust() {
    $('#page-trust .trust-grid').innerHTML = TRUST.map((t) => `
      <div class="tg" style="--c:${t.c}">
        <div class="tg-ico">${t.i}</div>
        <h3>${t.t}</h3><p>${t.d}</p>
      </div>`).join('');

    $('#page-trust .limit-list').innerHTML = LIMITS.map(([b, s]) => `
      <div class="li"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');

    $('#page-trust .tech-grid').innerHTML = TECH.map(([b, s]) => `
      <div class="tech"><b>${esc(b)}</b><span>${s}</span></div>`).join('');
  }

  // ════════════ 权限：导航与按钮显隐 ════════════

  /** 按当前角色隐藏无权访问的导航项 */
  function applyNavPermissions() {
    let hidden = 0;
    $$('.nav-i').forEach((n) => {
      const roles = (n.dataset.roles || '').split(',').filter(Boolean);
      const ok = roles.length === 0 || roles.includes(S.role);
      n.classList.toggle('hidden', !ok);
      if (!ok) hidden++;
    });

    // 分组标题若整组都隐藏，也一并隐藏，避免出现空的「项目流程」标题
    $$('.nav-g').forEach((g) => {
      let sib = g.nextElementSibling;
      let any = false;
      while (sib && !sib.classList.contains('nav-g')) {
        if (sib.classList.contains('nav-i') && !sib.classList.contains('hidden')) any = true;
        sib = sib.nextElementSibling;
      }
      g.classList.toggle('hidden', !any);
    });

    return hidden;
  }

  // ════════════ 侧边栏交互 ════════════
  $$('.nav-i').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)));
  on('#menuBtn', 'click', () => {
    $('#sidebar').classList.add('open');
    $('#sbMask').classList.add('on');
  });
  on('#sbMask', 'click', () => {
    $('#sidebar').classList.remove('open');
    $('#sbMask').classList.remove('on');
  });

  // ════════════ 启动 ════════════
  async function boot() {
    renderTrust();
    try {
      const h = await fetch(API + '/api/health').then((r) => r.json());
      const chip = $('#chainMode');
      chip.textContent = h.chainMode === 'chain' ? '链上模式' : '本地模式';
      chip.className = 'chip ' + (h.chainMode === 'chain' ? 'ok' : 'warn');
    } catch {
      $('#chainMode').textContent = '服务未连接';
      $('#chainMode').className = 'chip bad';
    }
    try {
      const r = await api('/api/rules');
      S.templates = r.templates;
      S.rejected = r.rejected || [];
    } catch (e) {
      toast('无法连接后端：' + e.message, 'bad');
    }

    if (S.token) {
      try {
        await api('/api/auth/me');
        enterApp();
      } catch {
        localStorage.removeItem('ms_token');
        localStorage.removeItem('ms_address');
        localStorage.removeItem('ms_role');
      }
    }
  }

  // 供自动化测试访问
  window.__PLATFORM__ = { S, go, api, toast, act, route, loadProject, loadProjects, renderRules, renderCreate, uploadDelivery, acceptFile, canSee, applyNavPermissions, PAGE_ROLES };

  boot();
})();