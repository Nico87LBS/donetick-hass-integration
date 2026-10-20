// A family chore board: a podium of members' points, today's tasks with a
// photo button per member to mark who did it, what is already done, and the
// rewards each member can take.
// HA starts extra modules alongside its app bundle, which replaces both the
// custom-element registry and HTMLElement with its scoped-registry polyfill.
// Wait before defining classes so they use the final registry and base class.
await customElements.whenDefined('home-assistant');

const STRINGS = {
  en: {today:'To do today', all:'Tasks', allDone:'All done for today, well done!', noTasks:'No tasks to show',
    pending:'Waiting for approval', done:'Done today', rewards:'Rewards', approve:'Approve', reject:'Reject',
    confirm:'Tap again to redeem', bravo:'Well done!', submitted:'Sent for approval', noMembers:'No Donetick members found',
    day:'{n} per day', week:'{n} per week', month:'{n} per month', missing:'{n} points missing', quota:'Available again in {time}',
    available:'Redeem', minutes:'{n} min', hours:'{n} h', days:'{n} d'},
  fr: {today:"À faire aujourd'hui", all:'Tâches', allDone:"Tout est fait pour aujourd'hui, bravo !", noTasks:'Aucune tâche à afficher',
    pending:'En attente de validation', done:"Déjà fait aujourd'hui", rewards:'Récompenses', approve:'Valider', reject:'Refuser',
    confirm:'Touche encore pour échanger', bravo:'Bravo !', submitted:'Envoyé pour validation', noMembers:'Aucun membre Donetick trouvé',
    day:'{n} par jour', week:'{n} par semaine', month:'{n} par mois', missing:'Il manque {n} points', quota:'De nouveau disponible dans {time}',
    available:'Échanger', minutes:'{n} min', hours:'{n} h', days:'{n} j'},
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

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// Members on the podium: up to three steps of distinct scores, ties share a step.
export function podium(members) {
  const scores = [...new Set(members.map(m => m.points))].sort((a, b) => b - a).slice(0, 3);
  return [0, 1, 2].map(rank => scores[rank] === undefined ? [] : members.filter(m => m.points === scores[rank]));
}

// What a member sees on a reward: available, missing points, or out of quota until a date.
export function rewardState(reward, member, now = new Date()) {
  const resetsAt = reward.quota_resets_at ? new Date(reward.quota_resets_at) : null;
  const used = resetsAt && resetsAt > now ? Number(reward.quota_used?.[member.id] ?? reward.quota_used?.[String(member.id)] ?? 0) : 0;
  if (reward.quota_count > 0 && used >= reward.quota_count) return {kind: 'quota', resetsAt};
  const missing = reward.points_cost - member.points;
  if (missing > 0) return {kind: 'points', missing};
  return {kind: 'available'};
}

// Members come from the points sensors, tasks from the task sensors.
export function boardData(hass, config, now = new Date()) {
  const members = [];
  const tasks = [];
  const completers = new Map();
  let rewards = null;
  for (const [id, state] of Object.entries(hass.states)) {
    if (!id.startsWith('sensor.') || !isDonetick(hass, id)) continue;
    const a = state.attributes;
    if (a.donetick_member_id !== undefined) {
      members.push({id: a.donetick_member_id, name: a.display_name || a.friendly_name, role: a.role,
        picture: a.entity_picture || null, points: Number(state.state) || 0, recent: a.recent_completions || []});
    } else if (a.task_id !== undefined && a.is_active !== false) {
      // The state is the bare task name; friendly_name may carry the device name.
      tasks.push({id: a.task_id, entity: id, name: state.state || a.friendly_name, points: a.points,
        due: a.next_due_date ? new Date(a.next_due_date) : null, labels: labelNames(a.labels),
        assignees: a.assignee_ids || [], pending: a.pending_approval === true});
    } else if (Array.isArray(a.rewards) && rewards === null) {
      rewards = a.rewards;
    } else if (Array.isArray(a.tasks) && a.tasks.every(t => 'completed_by' in t)) {
      for (const t of a.tasks) completers.set(t.task_id, t.completed_by);
    }
  }
  const chosen = config.members?.length ? config.members.map(Number) : null;
  const shown = chosen ? chosen.map(id => members.find(m => m.id === id)).filter(Boolean) : members;
  const wanted = (config.labels || []).map(label => label.trim().toLowerCase()).filter(Boolean);
  const labelled = labels => !wanted.length || labelNames(labels).some(label => wanted.includes(label));
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const visible = tasks.filter(task => labelled(task.labels)
    && (config.due !== 'today' || !task.due || task.due <= endOfDay))
    .map(task => {
      const candidates = task.assignees.length ? shown.filter(m => task.assignees.includes(m.id)) : shown;
      return {...task, members: candidates, completedBy: task.pending ? shown.find(m => m.id === completers.get(task.id)) || null : null};
    })
    .filter(task => task.members.length || task.pending)
    .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.name.localeCompare(b.name));
  const done = shown.flatMap(member => member.recent
    .filter(item => item.completed_at && sameDay(new Date(item.completed_at), now) && labelled(item.labels))
    .map(item => ({...item, member})))
    .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  return {members: shown, tasks: visible, done, rewards: rewards || []};
}

const icon = {
  star: '<path d="M12 2l3 6.5 7 .8-5.2 4.8 1.4 7-6.2-3.6-6.2 3.6 1.4-7L2 9.3l7-.8z" fill="currentColor"/>',
  crown: '<path d="M3 19h18l1.5-11-5.5 4.5L12 5l-5 7.5L1.5 8z" fill="#f5b400" stroke="#d99a00" stroke-width="1.2" stroke-linejoin="round"/>',
  todo: '<path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  gift: '<path d="M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7c-1-3-5-4-5-1.5S10 7 12 7zm0 0c1-3 5-4 5-1.5S14 7 12 7z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2c0 5 10 5 10 10S7 17 7 22M17 2c0 5-10 5-10 10s10 5 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
};
const svg = (name, size, label) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${label ? `role="img" aria-label="${escape(label)}"` : 'aria-hidden="true"'}>${icon[name]}</svg>`;

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
  connectedCallback() {
    // Quota countdowns move on even when no sensor changes.
    this._timer = setInterval(() => this.render(), 60000);
  }
  disconnectedCallback() { clearInterval(this._timer); }
  setConfig(config) {
    if (config.due && !['today', 'all'].includes(config.due)) throw new Error('due must be today or all');
    if (config.members !== undefined && !Array.isArray(config.members)) throw new Error('members must be a list of Donetick user IDs');
    if (config.labels !== undefined && !Array.isArray(config.labels)) throw new Error('labels must be a list of label names');
    this._config = {due: 'today', show_points: true, show_done: true, show_rewards: true, show_approval: false, allow_redeem: false, ...config};
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
  getCardSize() { return 4 + (this._data?.tasks.length || 0) + (this._data?.done.length || 0) + (this._data?.rewards.length || 0); }
  getGridOptions() { return {columns: 12, min_columns: 6}; }
  t(key, values = {}) {
    const language = (this._hass?.locale?.language || 'en').split('-')[0];
    const text = (STRINGS[language] || STRINGS.en)[key] ?? STRINGS.en[key];
    return text.replace(/\{(\w+)\}/g, (_, name) => values[name]);
  }
  duration(until) {
    const minutes = Math.max(1, Math.ceil((until - new Date()) / 60000));
    if (minutes < 60) return this.t('minutes', {n: minutes});
    if (minutes < 48 * 60) return this.t('hours', {n: Math.ceil(minutes / 60)});
    return this.t('days', {n: Math.ceil(minutes / 1440)});
  }
  async call(service, data, key, memberId) {
    this._busy.set(key, memberId); this._error = ''; this.render();
    try {
      const result = await this._hass.callService('donetick', service, data, undefined, false, service !== 'approve_task' && service !== 'reject_task');
      return result?.response ?? {};
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
      if (response) this.flash(taskId, response.pending_approval ? this.t('submitted') : this.t('bravo'));
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
  face(member, size, extra = '') {
    const initial = escape((member.name || '?').charAt(0).toUpperCase());
    return member.picture
      ? `<img class="face${extra}" style="width:${size}px;height:${size}px" src="${escape(member.picture)}" alt="">`
      : `<span class="face initial${extra}" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.4)}px">${initial}</span>`;
  }
  badge(kind, iconName, text = '') {
    return `<span class="badge ${kind}${text ? ' wide' : ''}">${svg(iconName, 11)}${escape(text)}</span>`;
  }
  points(value, muted = false, cost = false) {
    return value ? `<span class="pts${muted ? ' muted' : ''}${cost ? ' cost' : ''}">${svg('star', 14)}${cost ? '' : '+'}${value}</span>` : '';
  }
  header(iconName, kind, title, count) {
    return `<div class="head"><span class="head-icon ${kind}">${svg(iconName, 18)}</span><h2>${escape(title)}</h2><span class="count ${kind}">${count}</span></div>`;
  }
  renderPodium(members) {
    const steps = podium(members);
    const step = (group, rank) => {
      const size = rank === 0 ? 76 : 60;
      const faces = group.length
        ? group.map(m => `<div class="podium-member">${rank === 0 && m.points > 0 ? `<span class="crown">${svg('crown', 30)}</span>` : ''}${this.face(m, size, rank === 0 && m.points > 0 ? ' leader' : '')}<div class="podium-name">${escape(m.name)}</div></div>`).join('')
        : `<div class="podium-member"><span class="face empty" style="width:${size}px;height:${size}px"></span><div class="podium-name">&nbsp;</div></div>`;
      const score = group.length ? `${group[0].points} ${group[0].points === 1 ? 'pt' : 'pts'}` : '&nbsp;';
      return `<div class="podium-col rank${rank + 1}"><div class="podium-faces">${faces}</div><div class="podium-score">${score}</div><div class="step">${rank + 1}</div></div>`;
    };
    return `<div class="podium">${step(steps[1], 1)}${step(steps[0], 0)}${step(steps[2], 2)}</div>`;
  }
  renderTask(task) {
    const busy = this._busy.get(task.id);
    const flash = this._flash.get(task.id);
    let right;
    if (flash) right = `<span class="flash">${escape(flash)}</span>`;
    else if (task.pending) {
      const approval = this._config.show_approval ? `
        <button class="icon-btn ok" data-action="approve" data-task="${task.id}" ${busy !== undefined ? 'disabled' : ''} aria-label="${escape(this.t('approve'))}">${svg('check', 18)}</button>
        <button class="icon-btn no" data-action="reject" data-task="${task.id}" ${busy !== undefined ? 'disabled' : ''} aria-label="${escape(this.t('reject'))}">${svg('cross', 16)}</button>` : '';
      const who = task.completedBy ? `<span class="slot waiting" title="${escape(task.completedBy.name)}">${this.face(task.completedBy, 48)}${this.badge('wait', 'clock')}</span>` : '';
      right = `${who}${approval}`;
    } else {
      right = task.members.map(m => `<button class="slot tap${busy === m.id ? ' busy' : ''}" data-action="complete" data-task="${task.id}" data-member="${m.id}"
        ${busy !== undefined ? 'disabled' : ''} aria-label="${escape(`${m.name} : ${task.name}`)}">${this.face(m, 48)}</button>`).join('');
    }
    const waiting = task.pending ? `<span class="hourglass">${svg('hourglass', 18, this.t('pending'))}</span>` : '';
    return `<div class="row${task.pending ? ' is-pending' : ''}"><span class="name">${escape(task.name)}</span>${this.points(task.points)}${waiting}<span class="faces">${right}</span></div>`;
  }
  renderDone(item) {
    return `<div class="row small"><span class="name muted">${escape(item.name)}</span>${this.points(item.points, true)}<span class="faces"><span class="slot" title="${escape(item.member.name)}">${this.face(item.member, 40)}${this.badge('done', 'check')}</span></span></div>`;
  }
  renderReward(reward, members) {
    const period = reward.quota_count > 0 && reward.quota_period ? `<span class="sub">${escape(this.t(reward.quota_period, {n: reward.quota_count}))}</span>` : '';
    const slots = members.map(m => {
      const state = rewardState(reward, m);
      const key = `reward-${reward.id}-${m.id}`;
      if (state.kind === 'quota') {
        const time = state.resetsAt ? this.duration(state.resetsAt) : '';
        return `<span class="slot off" title="${escape(`${m.name} : ${this.t('quota', {time})}`)}">${this.face(m, 44, ' grey')}${this.badge('gray', 'clock', time)}</span>`;
      }
      if (state.kind === 'points') {
        return `<span class="slot off" title="${escape(`${m.name} : ${this.t('missing', {n: state.missing})}`)}">${this.face(m, 44, ' grey')}${this.badge('gray', 'lock', `−${state.missing}`)}</span>`;
      }
      const content = `${this.face(m, 44)}${this.badge('gift', 'gift')}`;
      return this._config.allow_redeem
        ? `<button class="slot tap${this._armed === key ? ' armed' : ''}" data-action="redeem" data-reward="${reward.id}" data-member="${m.id}" ${this._busy.has(key) ? 'disabled' : ''}
            aria-label="${escape(`${m.name} : ${this._armed === key ? this.t('confirm') : this.t('available')} ${reward.name}`)}">${content}</button>`
        : `<span class="slot" title="${escape(m.name)}">${content}</span>`;
    }).join('');
    const armed = members.some(m => this._armed === `reward-${reward.id}-${m.id}`) ? `<span class="sub armed-text">${escape(this.t('confirm'))}</span>` : period;
    return `<div class="row"><span class="name"><span>${escape(reward.name)}</span>${armed}</span>${this.points(reward.points_cost, false, true)}<span class="faces">${slots}</span></div>`;
  }
  render() {
    if (!this._config || !this._hass) return;
    const data = this._data = boardData(this._hass, this._config);
    const title = this._config.title ?? (this._config.due === 'today' ? this.t('today') : this.t('all'));
    const empty = data.members.length ? (this._config.due === 'today' ? this.t('allDone') : this.t('noTasks')) : this.t('noMembers');
    const rewards = this._config.show_rewards && data.members.length ? data.rewards : [];
    const done = this._config.show_done ? data.done : [];
    this.shadowRoot.innerHTML = `<style>
      :host { --dt-gold: #f5b400; --dt-blue: #3b6fd8; --dt-green: #1e8e3e; --dt-line: var(--divider-color, rgba(127,127,127,.2)); }
      ha-card { padding: 20px 20px 12px; }
      .face { border-radius: 50%; object-fit: cover; display: block; flex: none; }
      .initial { display: grid; place-items: center; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 700; }
      .face.grey { filter: grayscale(1); opacity: .35; }
      .face.empty { border: 2px dashed var(--dt-line); box-sizing: border-box; }
      .face.leader { box-shadow: 0 0 0 3px var(--card-background-color, #fff), 0 0 0 5px var(--dt-gold); }
      .podium { display: flex; justify-content: center; align-items: flex-end; gap: 10px; margin: 4px 0 24px; }
      .podium-col { flex: 0 1 150px; display: flex; flex-direction: column; align-items: center; min-width: 0; }
      .podium-col.rank1 { flex-basis: 170px; }
      .podium-faces { display: flex; gap: 10px; justify-content: center; }
      .podium-member { display: flex; flex-direction: column; align-items: center; }
      .crown { line-height: 0; margin-bottom: 2px; }
      .podium-name { margin-top: 6px; font-weight: 600; font-size: 15px; }
      .podium-score { font-size: 13px; color: var(--secondary-text-color); margin: 2px 0 8px; }
      .step { width: 100%; border-radius: 14px 14px 0 0; display: grid; place-items: center; font-weight: 800; }
      .rank1 .step { height: 96px; font-size: 26px; background: rgba(245,180,0,.16); color: #a87300; }
      .rank2 .step { height: 64px; font-size: 22px; background: rgba(59,111,216,.12); color: var(--dt-blue); }
      .rank3 .step { height: 40px; font-size: 18px; background: rgba(160,110,70,.14); color: #8a6f57; }
      section { margin-bottom: 20px; }
      .head { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; }
      .head h2 { margin: 0; font-size: 17px; font-weight: 700; }
      .head-icon { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; flex: none; }
      .head-icon.todo { background: rgba(59,111,216,.12); color: var(--dt-blue); }
      .head-icon.done { background: rgba(30,142,62,.12); color: var(--dt-green); }
      .head-icon.gift { background: rgba(245,180,0,.16); color: #a87300; }
      .count { margin-left: auto; font-size: 13px; font-weight: 700; }
      .count.todo { color: var(--dt-blue); } .count.done { color: var(--dt-green); } .count.gift { color: #a87300; }
      .row { display: flex; align-items: center; gap: 10px; min-height: 64px; border-top: 1px solid var(--dt-line); }
      .row:last-child { border-bottom: 1px solid var(--dt-line); }
      .row.small { min-height: 56px; }
      .name { flex: 1 1 auto; min-width: 0; font-size: 17px; font-weight: 400; display: flex; flex-direction: column; }
      .name.muted { font-size: 16px; font-weight: 400; color: var(--secondary-text-color); }
      .sub { font-size: 12px; font-weight: 400; color: var(--secondary-text-color); margin-top: 2px; }
      .armed-text { color: var(--dt-green); font-weight: 600; }
      .pts { display: inline-flex; align-items: center; gap: 3px; padding: 4px 10px 4px 8px; border-radius: 999px; font-size: 14px; font-weight: 800;
        background: rgba(79,70,229,.12); color: #4f46e5; white-space: nowrap; }
      .pts svg { color: var(--dt-gold); }
      .pts.muted { background: rgba(127,127,127,.12); color: var(--secondary-text-color); font-weight: 700; } .pts.muted svg { color: rgba(127,127,127,.5); }
      .pts.cost { background: rgba(245,180,0,.16); color: #8a5a00; }
      .hourglass { color: #8a6f57; line-height: 0; }
      .faces { display: flex; gap: 8px; margin-left: 6px; justify-content: flex-end; align-items: center; padding: 6px 0; }
      .slot { position: relative; display: block; line-height: 0; margin: 0 2px; }
      button { font: inherit; color: inherit; cursor: pointer; border: none; background: none; padding: 0; }
      button:disabled { cursor: default; opacity: .5; }
      .tap { border-radius: 50%; touch-action: manipulation; }
      .tap:not(:disabled):active { transform: scale(.92); }
      .tap.busy { opacity: 1; box-shadow: 0 0 0 3px var(--primary-color); }
      .tap.armed { box-shadow: 0 0 0 3px var(--card-background-color, #fff), 0 0 0 5px var(--dt-green); }
      .waiting .face { opacity: .55; box-shadow: 0 0 0 2px var(--card-background-color, #fff), 0 0 0 4px #c9b8a8; }
      .badge { position: absolute; right: -3px; bottom: -3px; min-width: 20px; height: 20px; box-sizing: border-box; border-radius: 10px;
        border: 2px solid var(--card-background-color, #fff); display: flex; align-items: center; justify-content: center; gap: 2px;
        color: #fff; font-size: 10px; font-weight: 700; line-height: 1; white-space: nowrap; }
      .badge.wide { right: -10px; padding: 0 5px 0 3px; }
      .badge.gift, .badge.done { background: var(--dt-green); } .badge.wait { background: #8a6f57; } .badge.gray { background: #80868b; }
      .icon-btn { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; }
      .icon-btn.ok { background: rgba(30,142,62,.14); color: var(--dt-green); } .icon-btn.no { background: rgba(217,48,37,.12); color: var(--error-color, #d93025); }
      .flash { font-weight: 700; color: var(--success-color, var(--dt-green)); }
      .empty-text { font-size: 17px; padding: 12px 0; border-top: 1px solid var(--dt-line); }
      .error { color: var(--error-color); margin: 8px 0; }
    </style><ha-card>
      ${this._config.show_points && data.members.length ? this.renderPodium(data.members) : ''}
      <section>${this.header('todo', 'todo', title, data.tasks.length)}
        ${data.tasks.length ? data.tasks.map(task => this.renderTask(task)).join('') : `<div class="empty-text">${escape(empty)}</div>`}</section>
      ${done.length ? `<section>${this.header('check', 'done', this.t('done'), done.length)}${done.map(item => this.renderDone(item)).join('')}</section>` : ''}
      ${rewards.length ? `<section>${this.header('gift', 'gift', this.t('rewards'), rewards.length)}${rewards.map(r => this.renderReward(r, data.members)).join('')}</section>` : ''}
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
        due: 'Tasks shown', show_points: 'Show the points podium', show_done: 'Show tasks done today', show_rewards: 'Show rewards',
        show_approval: 'Show approve and reject buttons', allow_redeem: 'Allow redeeming rewards from the card'}[schema.name] ?? schema.name);
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
      {name: 'show_done', selector: {boolean: {}}},
      {name: 'show_rewards', selector: {boolean: {}}},
      {name: 'show_approval', selector: {boolean: {}}},
      {name: 'allow_redeem', selector: {boolean: {}}},
    ];
    this._form.data = {due: 'today', show_points: true, show_done: true, show_rewards: true, show_approval: false, allow_redeem: false,
      ...this._config, members: (this._config.members || []).map(String)};
  }
}

if (!customElements.get('donetick-family-card')) customElements.define('donetick-family-card', DonetickFamilyCard);
if (!customElements.get('donetick-family-card-editor')) customElements.define('donetick-family-card-editor', DonetickFamilyCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === 'donetick-family-card')) window.customCards.push({type: 'donetick-family-card', name: 'Donetick Family Board', description: "A points podium, today's tasks with a photo per member to mark who did it, what is done, and rewards"});
