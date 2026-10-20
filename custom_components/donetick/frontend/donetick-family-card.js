// A family chore board: today's tasks with a photo button per member to mark
// who did it, members' points, and the rewards those points can buy.
// HA starts extra modules alongside its app bundle, which replaces both the
// custom-element registry and HTMLElement with its scoped-registry polyfill.
// Wait before defining classes so they use the final registry and base class.
await customElements.whenDefined('home-assistant');

const STRINGS = {
  en: {today:'To do today', all:'Tasks', allDone:'All done for today, well done!', noTasks:'No tasks to show',
    pending:'Waiting for approval', points:'Points', rewards:'Rewards', pts:'pts', approve:'Approve', reject:'Reject',
    more:'{n} more', confirm:'Tap again', done:'Done!', submitted:'Sent for approval', noMembers:'No Donetick members found'},
  fr: {today:"À faire aujourd'hui", all:'Tâches', allDone:"Tout est fait pour aujourd'hui, bravo !", noTasks:'Aucune tâche à afficher',
    pending:'En attente de validation', points:'Les points', rewards:'Récompenses', pts:'pts', approve:'Valider', reject:'Refuser',
    more:'encore {n}', confirm:'Touche encore', done:'Bravo !', submitted:'Envoyé pour validation', noMembers:'Aucun membre Donetick trouvé'},
};

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function labelNames(value) {
  const labels = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return labels.map(label => typeof label === 'string' ? label : label?.name)
    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().toLowerCase());
}

function isDonetick(hass, id) {
  const platform = hass.entities?.[id]?.platform;
  return platform === undefined || platform === 'donetick';
}

// Members come from the points sensors, tasks from the task sensors.
export function boardData(hass, config, now = new Date()) {
  const members = [];
  const tasks = [];
  let rewards = null;
  for (const [id, state] of Object.entries(hass.states)) {
    if (!id.startsWith('sensor.') || !isDonetick(hass, id)) continue;
    const a = state.attributes;
    if (a.donetick_member_id !== undefined) {
      members.push({id: a.donetick_member_id, name: a.display_name || a.friendly_name, role: a.role,
        picture: a.entity_picture || null, points: Number(state.state) || 0});
    } else if (a.task_id !== undefined && a.is_active !== false) {
      tasks.push({id: a.task_id, entity: id, name: a.friendly_name || state.state, points: a.points,
        due: a.next_due_date ? new Date(a.next_due_date) : null, labels: labelNames(a.labels),
        assignees: a.assignee_ids || [], pending: a.pending_approval === true});
    } else if (Array.isArray(a.rewards) && rewards === null) {
      rewards = a.rewards;
    }
  }
  const chosen = config.members?.length ? config.members.map(Number) : null;
  const shown = chosen ? chosen.map(id => members.find(m => m.id === id)).filter(Boolean) : members;
  const wanted = (config.labels || []).map(label => label.trim().toLowerCase()).filter(Boolean);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const visible = tasks.filter(task => (!wanted.length || task.labels.some(label => wanted.includes(label)))
    && (config.due !== 'today' || !task.due || task.due <= endOfDay))
    .map(task => {
      const candidates = task.assignees.length ? shown.filter(m => task.assignees.includes(m.id)) : shown;
      return {...task, members: candidates};
    })
    .filter(task => task.members.length || task.pending)
    .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.name.localeCompare(b.name));
  return {members: shown, tasks: visible, rewards: rewards || []};
}

class DonetickFamilyCard extends HTMLElement {
  static getConfigElement() { return document.createElement('donetick-family-card-editor'); }
  static getStubConfig(hass) {
    const {members} = boardData(hass, {});
    const children = members.filter(m => m.role && m.role !== 'admin');
    return {due: 'today', members: (children.length ? children : members).map(m => m.id)};
  }
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this._busy = new Map();   // task id or reward key -> member id being sent
    this._flash = new Map();  // task id -> message shown briefly after a tap
    this._armed = null;       // reward key waiting for a confirming second tap
    this.shadowRoot.addEventListener('click', event => this.onClick(event));
  }
  setConfig(config) {
    if (config.due && !['today', 'all'].includes(config.due)) throw new Error('due must be today or all');
    if (config.members !== undefined && !Array.isArray(config.members)) throw new Error('members must be a list of Donetick user IDs');
    if (config.labels !== undefined && !Array.isArray(config.labels)) throw new Error('labels must be a list of label names');
    this._config = {due: 'today', show_points: true, show_rewards: true, show_approval: false, allow_redeem: false, ...config};
    this.render();
  }
  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    const relevant = id => id.startsWith('sensor.') && isDonetick(hass, id);
    if (previous && Object.keys(hass.states).every(id => !relevant(id) || previous.states[id] === hass.states[id])
      && Object.keys(previous.states).every(id => !relevant(id) || hass.states[id])
      && previous.locale?.language === hass.locale?.language) return;
    this.render();
  }
  getCardSize() { return 3 + (this._data?.tasks.length || 0) * 2; }
  getGridOptions() { return {columns: 12, min_columns: 6}; }
  t(key, values = {}) {
    const language = (this._hass?.locale?.language || 'en').split('-')[0];
    const text = (STRINGS[language] || STRINGS.en)[key] ?? STRINGS.en[key];
    return text.replace(/\{(\w+)\}/g, (_, name) => values[name]);
  }
  async call(service, data, key, memberId) {
    this._busy.set(key, memberId); this._error = ''; this.render();
    try {
      const result = await this._hass.callService('donetick', service, data, undefined, false, service !== 'approve_task' && service !== 'reject_task');
      return result?.response;
    } catch (err) {
      this._error = err?.message || String(err);
      return null;
    } finally {
      this._busy.delete(key); this.render();
    }
  }
  async onClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const {action, task, member, reward} = button.dataset;
    if (action === 'complete') {
      const taskId = Number(task);
      if (this._busy.has(taskId)) return;
      const response = await this.call('complete_task', {task_id: taskId, completed_by: Number(member)}, taskId, Number(member));
      if (response) this.flash(taskId, response.pending_approval ? this.t('submitted') : this.t('done'));
    } else if (action === 'approve' || action === 'reject') {
      await this.call(`${action}_task`, {task_id: Number(task)}, Number(task), null);
    } else if (action === 'redeem') {
      const key = `reward-${reward}-${member}`;
      if (this._armed !== key) { this._armed = key; this.render(); setTimeout(() => { if (this._armed === key) { this._armed = null; this.render(); } }, 4000); return; }
      this._armed = null;
      await this.call('redeem_reward', {reward_id: Number(reward), user_id: Number(member)}, key, Number(member));
    }
  }
  flash(taskId, message) {
    this._flash.set(taskId, message); this.render();
    setTimeout(() => { this._flash.delete(taskId); this.render(); }, 2500);
  }
  avatar(member, size) {
    const initial = escape((member.name || '?').charAt(0).toUpperCase());
    return member.picture
      ? `<img class="photo" style="width:${size}px;height:${size}px" src="${escape(member.picture)}" alt="">`
      : `<span class="photo initial" style="width:${size}px;height:${size}px;font-size:${size / 2.4}px">${initial}</span>`;
  }
  renderScores(members) {
    const best = Math.max(...members.map(m => m.points));
    const leaders = members.filter(m => m.points === best);
    return `<div class="scores">${members.map(m => `<div class="score">
      ${this.avatar(m, 72)}${leaders.length === 1 && best > 0 && leaders[0] === m ? '<span class="crown">👑</span>' : ''}
      <div class="score-name">${escape(m.name)}</div><div class="score-points">${m.points} <small>${this.t('pts')}</small></div>
    </div>`).join('')}</div>`;
  }
  renderTask(task) {
    const busy = this._busy.get(task.id);
    const flash = this._flash.get(task.id);
    const points = task.points ? `<span class="points">⭐ ${task.points} ${this.t('pts')}</span>` : '';
    let actions;
    if (flash) actions = `<div class="flash">${escape(flash)}</div>`;
    else if (task.pending) {
      actions = `<div class="waiting">⏳ ${this.t('pending')}</div>${this._config.show_approval ? `<div class="approval">
        <button data-action="approve" data-task="${task.id}" ${busy !== undefined ? 'disabled' : ''}>✅ ${this.t('approve')}</button>
        <button data-action="reject" data-task="${task.id}" ${busy !== undefined ? 'disabled' : ''}>❌ ${this.t('reject')}</button></div>` : ''}`;
    } else {
      actions = `<div class="members">${task.members.map(m => `<button class="member${busy === m.id ? ' busy' : ''}" data-action="complete" data-task="${task.id}" data-member="${m.id}"
        ${busy !== undefined ? 'disabled' : ''} aria-label="${escape(`${m.name}: ${task.name}`)}">${this.avatar(m, 64)}<span>${escape(m.name)}</span></button>`).join('')}</div>`;
    }
    return `<div class="task${task.pending ? ' is-pending' : ''}"><div class="task-head"><span class="task-name">${escape(task.name)}</span>${points}</div>${actions}</div>`;
  }
  renderRewards(rewards, members) {
    if (!rewards.length || !members.length) return '';
    return `<h3>🎁 ${this.t('rewards')}</h3><div class="rewards">${rewards.map(r => `<div class="reward">
      <div class="reward-head"><span>${escape(r.name)}</span><span class="points">${r.points_cost} ${this.t('pts')}</span></div>
      <div class="reward-members">${members.map(m => {
        const missing = r.points_cost - m.points;
        const key = `reward-${r.id}-${m.id}`;
        const label = missing > 0 ? this.t('more', {n: missing}) : this._armed === key ? this.t('confirm') : '✓';
        const content = `${this.avatar(m, 36)}<span>${escape(label)}</span>`;
        return this._config.allow_redeem && missing <= 0
          ? `<button class="chip${this._armed === key ? ' armed' : ''}" data-action="redeem" data-reward="${r.id}" data-member="${m.id}" ${this._busy.has(key) ? 'disabled' : ''}>${content}</button>`
          : `<span class="chip${missing > 0 ? ' short' : ''}">${content}</span>`;
      }).join('')}</div></div>`).join('')}</div>`;
  }
  render() {
    if (!this._config || !this._hass) return;
    const data = this._data = boardData(this._hass, this._config);
    const title = this._config.title ?? (this._config.due === 'today' ? this.t('today') : this.t('all'));
    const empty = data.members.length ? (this._config.due === 'today' ? `🎉 ${this.t('allDone')}` : this.t('noTasks')) : this.t('noMembers');
    this.shadowRoot.innerHTML = `<style>
      ha-card { padding: 16px; }
      h2, h3 { margin: 0 0 12px; font-weight: 600; } h2 { font-size: 22px; } h3 { font-size: 18px; margin-top: 20px; }
      .photo { border-radius: 50%; object-fit: cover; display: block; flex: none; }
      .initial { display: grid; place-items: center; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 700; }
      .scores { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
      .score { position: relative; flex: 1 1 140px; display: flex; flex-direction: column; align-items: center; gap: 4px;
        padding: 12px; border-radius: 20px; background: var(--secondary-background-color); }
      .crown { position: absolute; top: 4px; right: 12px; font-size: 28px; }
      .score-name { font-size: 18px; font-weight: 600; }
      .score-points { font-size: 32px; font-weight: 800; color: var(--primary-color); } .score-points small { font-size: 14px; }
      .tasks { display: grid; gap: 12px; }
      .task { padding: 12px; border-radius: 20px; background: var(--secondary-background-color); }
      .task.is-pending { opacity: .75; }
      .task-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 8px; }
      .task-name { font-size: 20px; font-weight: 600; }
      .points { color: var(--secondary-text-color); white-space: nowrap; }
      .members { display: flex; gap: 10px; flex-wrap: wrap; }
      button { font: inherit; color: inherit; cursor: pointer; border: none; }
      button:disabled { cursor: default; opacity: .5; }
      .member { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 10px; border-radius: 16px;
        background: var(--card-background-color); font-size: 15px; touch-action: manipulation; }
      .member:not(:disabled):active { transform: scale(.94); }
      .member.busy { opacity: 1; outline: 3px solid var(--primary-color); }
      .waiting, .flash { font-size: 16px; padding: 6px 0; } .flash { font-weight: 700; color: var(--success-color, var(--primary-color)); }
      .approval { display: flex; gap: 8px; margin-top: 6px; }
      .approval button { padding: 8px 14px; border-radius: 12px; background: var(--card-background-color); }
      .rewards { display: grid; gap: 10px; }
      .reward { padding: 10px 12px; border-radius: 16px; background: var(--secondary-background-color); }
      .reward-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-weight: 600; }
      .reward-members { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 3px; border-radius: 999px;
        background: var(--card-background-color); font-size: 14px; }
      .chip.short { opacity: .55; } .chip.armed { outline: 2px solid var(--primary-color); }
      .empty { font-size: 18px; padding: 8px 0; }
      .error { color: var(--error-color); margin-top: 8px; }
    </style><ha-card>
      ${this._config.show_points && data.members.length ? `<h2>⭐ ${this.t('points')}</h2>${this.renderScores(data.members)}` : ''}
      <h2>${escape(title)}</h2>
      ${data.tasks.length ? `<div class="tasks">${data.tasks.map(task => this.renderTask(task)).join('')}</div>` : `<div class="empty">${escape(empty)}</div>`}
      ${this._config.show_rewards ? this.renderRewards(data.rewards, data.members) : ''}
      ${this._error ? `<div class="error">${escape(this._error)}</div>` : ''}
    </ha-card>`;
  }
}

class DonetickFamilyCardEditor extends HTMLElement {
  setConfig(config) { this._config = {...config}; this.render(); }
  set hass(hass) { const first = !this._hass; this._hass = hass; if (first) this.render(); }
  render() {
    if (!this._hass || !this._config) return;
    const {members} = boardData(this._hass, {});
    const labels = new Set();
    for (const [id, state] of Object.entries(this._hass.states)) {
      if (id.startsWith('sensor.') && state.attributes.task_id !== undefined) labelNames(state.attributes.labels).forEach(l => labels.add(l));
    }
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = schema => ({title: 'Title', members: 'Members with a photo button', labels: 'Only tasks with these labels',
        due: 'Tasks shown', show_points: 'Show points', show_rewards: 'Show rewards', show_approval: 'Show approve and reject buttons',
        allow_redeem: 'Allow redeeming rewards from the card'}[schema.name] ?? schema.name);
      this._form.addEventListener('value-changed', event => {
        event.stopPropagation();
        const config = {...event.detail.value};
        for (const key of Object.keys(config)) if (config[key] === '' || (Array.isArray(config[key]) && !config[key].length)) delete config[key];
        if (config.members) config.members = config.members.map(Number);
        this._config = config;
        this.dispatchEvent(new CustomEvent('config-changed', {detail: {config}, bubbles: true, composed: true}));
      });
      this.append(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = [
      {name: 'title', selector: {text: {}}},
      {name: 'members', selector: {select: {multiple: true, options: members.map(m => ({value: String(m.id), label: m.name}))}}},
      {name: 'labels', selector: {select: {multiple: true, custom_value: true, options: [...labels]}}},
      {name: 'due', selector: {select: {mode: 'dropdown', options: [{value: 'today', label: 'Due today or overdue'}, {value: 'all', label: 'All'}]}}},
      {name: 'show_points', selector: {boolean: {}}},
      {name: 'show_rewards', selector: {boolean: {}}},
      {name: 'show_approval', selector: {boolean: {}}},
      {name: 'allow_redeem', selector: {boolean: {}}},
    ];
    this._form.data = {due: 'today', show_points: true, show_rewards: true, show_approval: false, allow_redeem: false,
      ...this._config, members: (this._config.members || []).map(String)};
  }
}

if (!customElements.get('donetick-family-card')) customElements.define('donetick-family-card', DonetickFamilyCard);
if (!customElements.get('donetick-family-card-editor')) customElements.define('donetick-family-card-editor', DonetickFamilyCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === 'donetick-family-card')) window.customCards.push({type: 'donetick-family-card', name: 'Donetick Family Board', description: "Today's tasks with a photo per member to mark who did it, points and rewards"});
