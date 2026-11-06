import { PAPERFORGE_CONFIG as config } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const shortDate = (date) => date ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(date)) : '—';
const icon = (name) => `<svg><use href="#ic-${name}"/></svg>`;

class Membership {
  client = null;
  user = null;
  profile = null;
  initialized = false;
  configuring = false;
  connecting = false;
  connectError = '';
  pendingRequests = [];

  async init() {
    this.injectDialogs();
    this.attachEvents();
    this.renderHeader();
    this.configuring = Boolean(config.supabaseUrl && config.supabaseAnonKey);
    if (!this.configuring) {
      this.initialized = true;
      return;
    }
    await this.connectClient();
  }

  async connectClient() {
    if (this.connecting || this.client) return;
    this.connecting = true;
    this.connectError = '';
    this.refreshLoginDialog();
    try {
      const sources = [
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
        'https://esm.sh/@supabase/supabase-js@2?bundle',
      ];
      let sdk;
      let previousError;
      for (const source of sources) {
        try {
          sdk = await Promise.race([
            import(/* @vite-ignore */ source),
            new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时')), 12000)),
          ]);
          if (sdk?.createClient) break;
          throw new Error('SDK 模块无效');
        } catch (error) { previousError = error; }
      }
      if (!sdk?.createClient) throw previousError || new Error('SDK 无法加载');
      const { createClient } = sdk;
      this.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
      });
      const { data, error } = await this.client.auth.getSession();
      if (error) throw error;
      this.user = data.session?.user || null;
      if (this.user) await this.refreshProfile();
      this.client.auth.onAuthStateChange((_event, session) => {
        this.user = session?.user || null;
        if (!this.user) { this.profile = null; this.renderHeader(); }
        else setTimeout(() => this.refreshProfile().catch((e) => this.notify(e.message, true)), 0);
      });
    } catch (error) {
      console.error('Supabase setup:', error);
      this.connectError = error.message || '未知网络错误';
      this.notify(`登录服务未能连接：${error.message}`, true);
    } finally {
      this.connecting = false;
      this.initialized = true;
      this.renderHeader();
      this.refreshLoginDialog();
    }
  }

  refreshLoginDialog() {
    if (!$('memberOverlay')?.classList.contains('hidden') && $('memberHeading')?.textContent === '登录你的工作空间') this.showLogin();
  }

  notify(message, error = false) {
    const target = $('toast');
    if (!target) return alert(message);
    target.textContent = message;
    target.classList.toggle('error', error);
    target.classList.remove('hidden');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => target.classList.add('hidden'), error ? 6500 : 3800);
  }

  injectDialogs() {
    const overlay = document.createElement('div');
    overlay.id = 'memberOverlay';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `<div class="membership-modal" role="dialog" aria-modal="true" aria-labelledby="memberHeading">
      <button class="modal-close" id="closeMember" aria-label="关闭">${icon('close')}</button>
      <div id="memberBody"></div>
    </div>`;
    document.body.append(overlay);
    const admin = document.createElement('div');
    admin.id = 'adminOverlay';
    admin.className = 'modal-overlay hidden';
    admin.innerHTML = `<div class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="adminHeading">
      <button class="modal-close" id="closeAdmin" aria-label="关闭">${icon('close')}</button>
      <div class="admin-heading"><span class="admin-heading-icon">${icon('shield')}</span><div><small>ADMIN CONTROL</small><h2 id="adminHeading">PaperForge 控制台</h2><p>查看付款申请、免费授权与用户状态</p></div></div>
      <div id="adminBody" class="admin-body"></div>
    </div>`;
    document.body.append(admin);
  }

  attachEvents() {
    $('accountBtn').addEventListener('click', () => this.user ? this.showMembership() : this.showLogin());
    $('membershipBtn').addEventListener('click', () => this.showMembership());
    $('adminBtn').addEventListener('click', () => this.showAdmin());
    $('closeMember').addEventListener('click', () => this.closeDialogs());
    $('closeAdmin').addEventListener('click', () => this.closeDialogs());
    $('memberOverlay').addEventListener('click', (e) => { if (e.target === $('memberOverlay')) this.closeDialogs(); });
    $('adminOverlay').addEventListener('click', (e) => { if (e.target === $('adminOverlay')) this.closeDialogs(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeDialogs(); });
    $('memberBody').addEventListener('click', async (event) => {
      const target = event.target.closest('button[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'login') await this.signIn();
      if (action === 'retry-login') await this.connectClient();
      if (action === 'logout') await this.signOut();
      if (action === 'submit-payment') await this.submitPayment();
    });
    $('adminBody').addEventListener('click', async (event) => {
      const target = event.target.closest('button[data-action]');
      if (!target || target.disabled) return;
      const action = target.dataset.action;
      target.disabled = true;
      try {
        if (action === 'approve' || action === 'reject') {
          const { error } = await this.client.rpc('pf_admin_decide_payment', { p_request_id: target.dataset.request, p_approve: action === 'approve' });
          if (error) throw error;
          this.notify(action === 'approve' ? '付款申请已批准，会员延长 30 天' : '付款申请已拒绝');
        } else if (['complimentary', 'revoke', 'suspend'].includes(action)) {
          const { error } = await this.client.rpc('pf_admin_set_access', { p_user_id: target.dataset.user, p_action: action });
          if (error) throw error;
          this.notify(action === 'complimentary' ? '已赠送免费高级权限' : action === 'suspend' ? '已暂停用户权限' : '权限已撤销');
        }
        await this.showAdmin();
      } catch (error) { this.notify(`操作失败：${error.message}`, true); target.disabled = false; }
    });
  }

  renderHeader() {
    const account = $('accountBtn');
    if (!account) return;
    account.innerHTML = this.user ? `${icon('shield')} ${esc((this.user.email || '已登录').split('@')[0])}` : `${icon('shield')} Google 登录`;
    $('membershipBtn').classList.toggle('hidden', !this.user);
    $('adminBtn').classList.toggle('hidden', this.profile?.role !== 'admin');
  }

  async refreshProfile() {
    if (!this.user || !this.client) { this.profile = null; this.renderHeader(); return; }
    const { data, error } = await this.client.from('pf_profiles')
      .select('id,email,full_name,role,plan,free_exports_used,premium_expires_at')
      .eq('id', this.user.id).single();
    if (error) { console.error(error); this.notify('无法读取会员资料。请检查 Supabase 数据库是否已执行 schema.sql。', true); }
    this.profile = data || null;
    this.renderHeader();
  }

  closeDialogs() {
    $('memberOverlay').classList.add('hidden');
    $('adminOverlay').classList.add('hidden');
  }

  guardUse() {
    if (this.user && this.profile) return true;
    this.showLogin();
    return false;
  }

  showLogin() {
    const message = !this.configuring ? '尚未完成 Supabase 配置。管理员需先把 Project URL 与 Publishable Key 填入 config.js。'
      : this.client ? '使用 Google 账号登录，即可获得 1 次免费成功导出额度。'
      : this.connecting ? '正在建立安全登录连接，通常需要几秒钟。连接成功后按钮会自动启用。'
      : `登录组件无法加载：${this.connectError || '网络问题'}。请点击「重试连接」，或关闭广告拦截器后再试。`;
    $('memberBody').innerHTML = `<div class="member-hero"><span class="member-hero-icon">${icon('shield')}</span><small>WELCOME TO PAPERFORGE</small><h2 id="memberHeading">登录你的工作空间</h2><p>${esc(message)}</p></div>
      <button class="google-btn" data-action="login" ${!this.client ? 'disabled' : ''}><span class="google-g">G</span> 使用 Google 账号继续</button>
      ${!this.client && !this.connecting && this.configuring ? '<button class="signout-btn" data-action="retry-login">重试连接登录服务</button>' : ''}
      <div class="member-trust">${icon('check')} 免费 1 次导出　·　${icon('check')} 无需设置密码</div>`;
    $('adminOverlay').classList.add('hidden');
    $('memberOverlay').classList.remove('hidden');
  }

  async signIn() {
    if (!this.client) return this.notify('请先配置 Supabase 项目。', true);
    const { error } = await this.client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${window.location.pathname}` },
    });
    if (error) this.notify(`Google 登录失败：${error.message}`, true);
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) return this.notify(error.message, true);
    this.user = null; this.profile = null; this.renderHeader(); this.closeDialogs();
    this.notify('已退出 Google 账号');
  }

  activePlan() {
    const profile = this.profile;
    if (!profile) return false;
    if (profile.role === 'admin') return 'Admin';
    if (profile.plan === 'suspended') return false;
    if (profile.plan === 'complimentary' && (!profile.premium_expires_at || new Date(profile.premium_expires_at) > new Date())) return 'Complimentary';
    if (profile.plan === 'premium' && new Date(profile.premium_expires_at) > new Date()) return 'Premium';
    return false;
  }

  async showMembership() {
    if (!this.user) return this.showLogin();
    await this.refreshProfile();
    const p = this.profile;
    if (!p) return this.showLogin();
    const plan = this.activePlan();
    const remaining = p.free_exports_used === 0 ? '1 / 1' : '0 / 1';
    const { data: pending } = await this.client.from('pf_payment_requests')
      .select('id,status,created_at').eq('user_id', this.user.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1);
    this.pendingRequests = pending || [];
    const qr = config.paymentQrImage
      ? `<img class="payment-qr" src="${esc(config.paymentQrImage)}" alt="管理员收款二维码"/>`
      : `<div class="qr-placeholder">${icon('file')}<span>收款 QR Code 即将上传</span></div>`;
    $('memberBody').innerHTML = `<div class="member-hero left"><span class="member-hero-icon">${icon('shield')}</span><small>ACCOUNT & MEMBERSHIP</small><h2 id="memberHeading">我的会员中心</h2><p>${esc(this.user.email)}</p></div>
      <div class="membership-stats"><div><small>当前权限</small><strong>${esc(plan || (p.plan === 'suspended' ? 'Suspended' : 'Free Trial'))}</strong></div><div><small>剩余免费导出</small><strong>${remaining}</strong></div></div>
      ${plan === 'Premium' && p.premium_expires_at ? `<div class="member-expiry">有效期至 ${shortDate(p.premium_expires_at)}</div>` : ''}
      <div class="membership-payment"><div class="membership-payment-head"><div><strong>Premium Access</strong><p>可在有效期内不限次数导出</p></div><div class="price">RM ${config.monthlyPrice}<small>/ 月</small></div></div>
        ${qr}<p class="qr-guide">扫码付款后，在下方填写转账参考编号或付款人姓名。管理员核款后人工开通 30 天权限。</p>
        ${this.pendingRequests.length ? `<div class="pending-indicator">${icon('check')} 付款通知已提交，等待管理员核款</div>` : `<label class="payment-ref-label" for="paymentReference">转账参考编号 / 付款人姓名</label>
        <input id="paymentReference" class="payment-reference" maxlength="120" placeholder="例如 Transfer 123456 / Jun Hao" />
        <button class="pay-request-btn" data-action="submit-payment">已完成付款，提交审核 ${icon('arrow')}</button>`}
      </div><button class="signout-btn" data-action="logout">退出登录</button>`;
    $('adminOverlay').classList.add('hidden');
    $('memberOverlay').classList.remove('hidden');
  }

  async submitPayment() {
    if (!this.client || !this.user) return;
    if (!config.paymentQrImage) return this.notify('管理员尚未提供收款 QR Code，付款功能暂不可用。', true);
    const ref = $('paymentReference')?.value.trim();
    if (!ref || ref.length < 2) return this.notify('请填写转账参考编号或付款人姓名。', true);
    const { error } = await this.client.from('pf_payment_requests').insert({
      user_id: this.user.id, amount: config.monthlyPrice, currency: config.currency, payment_reference: ref,
    });
    if (error) return this.notify(`提交失败：${error.message}`, true);
    this.notify('已提交付款通知，等待管理员核款');
    await this.showMembership();
  }

  async authorizeExport(kind) {
    if (!this.client || !this.user || !this.profile) { this.showLogin(); return false; }
    try {
      const { data, error } = await this.client.rpc('pf_consume_export', { p_kind: kind });
      if (error) throw error;
      if (!data?.allowed) {
        this.notify(data?.reason === 'suspended' ? '该账号已暂停使用。' : '免费导出次数已用完，请申请 Premium。', true);
        await this.showMembership();
        return false;
      }
      await this.refreshProfile();
      return true;
    } catch (error) { this.notify(`无法验证导出权限：${error.message}`, true); return false; }
  }

  async showAdmin() {
    if (this.profile?.role !== 'admin' || !this.client) return this.notify('无管理员权限。', true);
    $('memberOverlay').classList.add('hidden');
    $('adminOverlay').classList.remove('hidden');
    $('adminBody').innerHTML = `<div class="admin-loading">正在读取用户和申请记录…</div>`;
    const [accounts, payments] = await Promise.all([
      this.client.from('pf_profiles').select('id,email,role,plan,free_exports_used,premium_expires_at').order('created_at', { ascending: false }).limit(200),
      this.client.from('pf_payment_requests').select('id,user_id,status,amount,currency,payment_reference,created_at').order('created_at', { ascending: false }).limit(200),
    ]);
    if (accounts.error || payments.error) {
      $('adminBody').textContent = `无法加载管理数据：${accounts.error?.message || payments.error?.message}`;
      return;
    }
    const profiles = accounts.data || [];
    const requests = payments.data || [];
    const emails = Object.fromEntries(profiles.map((p) => [p.id, p.email]));
    const pending = requests.filter((p) => p.status === 'pending');
    const requestRows = pending.length ? pending.map((req) => `<div class="admin-request"><div><strong>${esc(emails[req.user_id] || req.user_id)}</strong><small>${esc(req.payment_reference)} · RM ${req.amount} · ${shortDate(req.created_at)}</small></div><div class="admin-row-actions"><button data-action="approve" data-request="${esc(req.id)}" class="admin-approve">Approve</button><button data-action="reject" data-request="${esc(req.id)}">Reject</button></div></div>`).join('') : '<p class="admin-empty">暂时没有待审核申请。</p>';
    const userRows = profiles.filter((p) => p.role !== 'admin').map((p) => `<div class="admin-request"><div><strong>${esc(p.email)}</strong><small>${esc(p.plan)} · 免费导出 ${p.free_exports_used}/1${p.premium_expires_at ? ` · 截至 ${shortDate(p.premium_expires_at)}` : ''}</small></div><div class="admin-row-actions"><button data-action="complimentary" data-user="${esc(p.id)}" class="admin-approve">免费批准</button><button data-action="revoke" data-user="${esc(p.id)}">撤销</button><button data-action="suspend" data-user="${esc(p.id)}">暂停</button></div></div>`).join('') || '<p class="admin-empty">暂无普通用户。</p>';
    $('adminBody').innerHTML = `<div class="admin-stats"><div><small>总用户</small><strong>${profiles.length}</strong></div><div><small>待核款</small><strong>${pending.length}</strong></div><div><small>高级会员</small><strong>${profiles.filter((p) => p.plan === 'premium').length}</strong></div></div>
      <h3>待审核付款 <span>${pending.length}</span></h3><div class="admin-list">${requestRows}</div>
      <h3>用户管理 <span>${profiles.length}</span></h3><div class="admin-list">${userRows}</div>
      <p class="admin-footer-note">仅展示最近 200 条记录。审批只根据你实际确认的收款记录操作，页面本身不会自动验证付款。</p>`;
  }
}

export const membership = new Membership();
