"""Track tasks waiting for approval and announce changes as Home Assistant events."""

STATUS_PENDING_APPROVAL = 3
HISTORY_PENDING_APPROVAL = 3

EVENT_PENDING_APPROVAL = "donetick_task_pending_approval"
EVENT_APPROVAL_RESOLVED = "donetick_task_approval_resolved"


def member_name(members, user_id):
    """Return a member's display name, or None when unknown."""
    for member in members:
        if member.user_id == user_id:
            return member.display_name or member.username
    return None


def pending_approvals(tasks, history, members):
    """Describe each active task waiting for approval and who completed it.

    The completer comes from the task's pending history entry; it is None when
    that entry is older than the history window.
    """
    completers = {}
    for occurrence in history:
        if occurrence.status == HISTORY_PENDING_APPROVAL and occurrence.chore_id not in completers:
            completers[occurrence.chore_id] = occurrence.completed_by
    pending = []
    for task in tasks:
        if not task.is_active or task.status != STATUS_PENDING_APPROVAL:
            continue
        completed_by = completers.get(task.id)
        pending.append({
            "task_id": task.id,
            "task_name": task.name,
            "points": task.points,
            "completed_by": completed_by,
            "completed_by_name": member_name(members, completed_by),
        })
    return pending


class ApprovalTracker:
    """Fire one event when a task starts waiting for approval and one when it stops.

    The first refresh only records the current state, so a Home Assistant
    restart does not repeat notifications for tasks that were already waiting.
    """

    def __init__(self, fire):
        self._fire = fire
        self._known = None

    def update(self, pending, entry_id):
        current = {item["task_id"]: item for item in pending}
        if self._known is not None:
            for task_id, item in current.items():
                if task_id not in self._known:
                    self._fire(EVENT_PENDING_APPROVAL, {**item, "config_entry_id": entry_id})
            for task_id, item in self._known.items():
                if task_id not in current:
                    self._fire(EVENT_APPROVAL_RESOLVED, {
                        "task_id": task_id,
                        "task_name": item["task_name"],
                        "config_entry_id": entry_id,
                    })
        self._known = current
