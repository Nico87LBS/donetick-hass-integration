import assert from 'node:assert/strict';
globalThis.HTMLElement = class {};
globalThis.customElements = {define() {}, get() {}, whenDefined() { return Promise.resolve(); }};
globalThis.window = {};
const {boardData, labelNames} = await import('../custom_components/donetick/frontend/donetick-family-card.js');

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
console.log('family card tests passed');
