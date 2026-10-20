import assert from 'node:assert/strict';
globalThis.HTMLElement = class {};
globalThis.customElements = {define() {}, get() {}, whenDefined() { return Promise.resolve(); }};
globalThis.window = {};
const {boardData, labelNames, podium, rewardState} = await import('../custom_components/donetick/frontend/donetick-family-card.js');

assert.deepEqual(labelNames([{name: 'Enfants '}, 'Maison', {name: ''}, null]), ['enfants', 'maison']);
assert.deepEqual(labelNames('a, b'), ['a', 'b']);

const member = (id, name, points, role = 'member') => ({state: String(points), attributes: {donetick_member_id: id, display_name: name, role, entity_picture: `/p/${id}.jpg`}});
const task = (id, name, extra = {}) => ({state: name, attributes: {task_id: id, friendly_name: name, is_active: true, assignee_ids: [2, 3], labels: [{name: 'enfants'}], ...extra}});
const hass = {
  entities: {'sensor.other_task': {platform: 'other'}},
  states: {
    'sensor.donetick_points_nico': member(1, 'Nico', 0, 'admin'),
    'sensor.donetick_points_elena': member(2, 'Elena', 5),
    'sensor.donetick_points_anna': member(3, 'Anna', 2),
    'sensor.chambre': task(10, 'Chambre', {next_due_date: '2026-10-20T08:00:00Z', points: 3, pending_approval: true}),
    'sensor.table': task(11, 'Table', {next_due_date: '2026-10-20T17:00:00Z', assignee_ids: [3]}),
    'sensor.dents': task(12, 'Dents'),
    'sensor.plantes': task(13, 'Plantes', {next_due_date: '2026-10-25T09:00:00Z'}),
    'sensor.poubelles': task(14, 'Poubelles', {labels: [], assignee_ids: [1]}),
    'sensor.archived': task(15, 'Archived', {is_active: false}),
    'sensor.other_task': task(16, 'Other integration'),
    'sensor.donetick_rewards': {state: '1', attributes: {rewards: [{id: 1, name: 'Lecture', points_cost: 3}]}},
  },
};
const now = new Date('2026-10-20T12:00:00');

let data = boardData(hass, {due: 'today', labels: ['Enfants'], members: [2, 3]}, now);
assert.deepEqual(data.members.map(m => m.name), ['Elena', 'Anna']);
assert.deepEqual(data.tasks.map(t => t.name), ['Chambre', 'Table', 'Dents'], 'today and undated tasks, other integrations excluded');
assert.equal(data.tasks[0].pending, true);
assert.deepEqual(data.tasks[1].members.map(m => m.name), ['Anna'], 'only assignees get a photo');
assert.deepEqual(data.rewards.map(r => r.name), ['Lecture']);

data = boardData(hass, {due: 'all'}, now);
assert.deepEqual(data.tasks.map(t => t.name), ['Chambre', 'Table', 'Plantes', 'Dents', 'Poubelles']);
assert.deepEqual(data.tasks.at(-1).members.map(m => m.name), ['Nico']);

// A task assigned only to members outside the board is hidden.
data = boardData(hass, {due: 'all', members: [2, 3]}, now);
assert.equal(data.tasks.some(t => t.name === 'Poubelles'), false);
// The bare task name is the state; friendly_name may carry the device name.
data = boardData({states: {'sensor.e': member(2, 'Elena', 1), 'sensor.x': {state: 'Ranger', attributes: {task_id: 1, friendly_name: 'Donetick Chores Ranger', is_active: true}}}}, {due: 'all'}, now);
assert.equal(data.tasks[0].name, 'Ranger');

// A pending task knows who completed it, from the pending approvals sensor.
const withPending = {states: {...hass.states, 'sensor.donetick_pending_approvals': {state: '1', attributes: {tasks: [{task_id: 10, completed_by: 2}]}}}};
data = boardData(withPending, {due: 'today', members: [2, 3]}, now);
assert.equal(data.tasks.find(t => t.id === 10).completedBy.name, 'Elena');

// Tasks done today come from each member's recent completions, newest first.
const recent = (id, name, points, items) => ({...member(id, name, points), attributes: {...member(id, name, points).attributes, recent_completions: items}});
const withDone = {states: {...hass.states,
  'sensor.donetick_points_elena': recent(2, 'Elena', 5, [{task_id: 20, name: 'Lit', points: 1, completed_at: '2026-10-20T07:00:00Z', labels: []}, {task_id: 21, name: 'Hier', completed_at: '2026-10-19T07:00:00Z'}]),
  'sensor.donetick_points_anna': recent(3, 'Anna', 2, [{task_id: 22, name: 'Chat', points: 2, completed_at: '2026-10-20T09:00:00Z', labels: []}])}};
data = boardData(withDone, {due: 'today', members: [2, 3]}, now);
assert.deepEqual(data.done.map(d => `${d.name}:${d.member.name}`), ['Chat:Anna', 'Lit:Elena']);
assert.deepEqual(boardData(withDone, {due: 'today', members: [2, 3], labels: ['enfants']}, now).done, [], 'label filter applies to done tasks');

// Podium: three distinct scores, ties share a step.
const m = (id, points) => ({id, points});
assert.deepEqual(podium([m(1, 5), m(2, 3)]).map(step => step.map(x => x.id)), [[1], [2], []]);
assert.deepEqual(podium([m(1, 4), m(2, 4), m(3, 1)]).map(step => step.map(x => x.id)), [[1, 2], [3], []]);
assert.deepEqual(podium([m(1, 9), m(2, 7), m(3, 5), m(4, 1)]).map(step => step.map(x => x.id)), [[1], [2], [3]]);

// Rewards: available, missing points, or out of quota until the reset.
const elena = {id: 2, points: 5};
assert.deepEqual(rewardState({points_cost: 3}, elena, now), {kind: 'available'});
assert.deepEqual(rewardState({points_cost: 9}, elena, now), {kind: 'points', missing: 4});
const daily = {points_cost: 3, quota_count: 1, quota_used: {'2': 1}, quota_resets_at: '2026-10-20T22:00:00Z'};
assert.equal(rewardState(daily, elena, now).kind, 'quota');
assert.equal(rewardState(daily, {id: 3, points: 3}, now).kind, 'available', 'quota is per member');
assert.equal(rewardState(daily, elena, new Date('2026-10-21T08:00:00')).kind, 'available', 'usage expires with the period');
console.log('family card tests passed');
