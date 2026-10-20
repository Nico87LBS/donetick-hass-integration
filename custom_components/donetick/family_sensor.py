"""Donetick points, pending approval and reward sensors."""
import logging
from datetime import timedelta
from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util
from homeassistant.helpers.update_coordinator import (
    CoordinatorEntity,
    DataUpdateCoordinator,
)

from .const import CONF_URL, DOMAIN
from .model import DonetickMember

_LOGGER = logging.getLogger(__name__)


def member_picture(base_url: str, image: str | None) -> str | None:
    """Return a browser URL for a member photo stored by Donetick."""
    if not image:
        return None
    if image.startswith(("http://", "https://")):
        return image
    # Locally stored profile photos are public assets served by Donetick.
    return f"{base_url.rstrip('/')}/api/v1/assets/{image.lstrip('/')}"


def recent_completions(completed, user_id, now=None, limit=30):
    """Tasks a member completed in the last two days, newest first.

    The card keeps the ones done today in the viewer's timezone.
    """
    since = (now or dt_util.utcnow()) - timedelta(days=2)
    recent = []
    for item in completed:
        if item.get("completed_by") != user_id:
            continue
        completed_at = dt_util.parse_datetime(item.get("completed_at") or "")
        if completed_at is None or completed_at < since:
            continue
        recent.append({key: item.get(key) for key in ("task_id", "name", "points", "labels", "completed_at")})
    return recent[:limit]


async def async_setup_family_sensors(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up one points sensor per member, the approvals sensor and the rewards sensor."""
    config = hass.data[DOMAIN][config_entry.entry_id]
    coordinator = config["coordinator"]
    members: list[DonetickMember] = config["circle_members"]

    entities: list[SensorEntity] = [DonetickPendingApprovalSensor(coordinator, config_entry)]
    if coordinator.rewards is not None:
        entities.append(DonetickRewardsSensor(coordinator, config_entry))

    known: set[int] = set()

    @callback
    def _add_new_members() -> None:
        new = [DonetickPointsSensor(coordinator, config_entry, member.user_id)
               for member in members if member.is_active and member.user_id not in known]
        known.update(sensor.user_id for sensor in new)
        if new:
            async_add_entities(new)

    async_add_entities(entities)
    _add_new_members()
    coordinator.async_add_listener(_add_new_members)


class _FamilySensor(CoordinatorEntity, SensorEntity):
    """Shared device and naming for the family sensors."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: DataUpdateCoordinator, config_entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._config_entry = config_entry

    @property
    def _members(self) -> list[DonetickMember]:
        return self.hass.data[DOMAIN][self._config_entry.entry_id]["circle_members"]

    @property
    def device_info(self) -> dict[str, Any]:
        return {
            "identifiers": {(DOMAIN, f"family_{self._config_entry.entry_id}")},
            "name": "Donetick",
            "manufacturer": "Donetick",
            "model": "Points and rewards",
        }


class DonetickPointsSensor(_FamilySensor):
    """Points a member can still spend, with their photo."""

    _attr_icon = "mdi:star-circle"
    _attr_native_unit_of_measurement = "points"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: DataUpdateCoordinator, config_entry: ConfigEntry, user_id: int) -> None:
        super().__init__(coordinator, config_entry)
        self.user_id = user_id
        self._attr_unique_id = f"dt_points_{config_entry.entry_id}_{user_id}"

    @property
    def _member(self) -> DonetickMember | None:
        return next((m for m in self._members if m.user_id == self.user_id), None)

    @property
    def available(self) -> bool:
        return self._member is not None and super().available

    @property
    def name(self) -> str:
        member = self._member
        label = (member.display_name or member.username) if member else str(self.user_id)
        return f"Points {label}"

    @property
    def native_value(self) -> int | None:
        member = self._member
        return member.points - member.points_redeemed if member else None

    @property
    def entity_picture(self) -> str | None:
        member = self._member
        return member_picture(self._config_entry.data[CONF_URL], member.image) if member else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        member = self._member
        if not member:
            return {}
        return {
            "donetick_member_id": member.user_id,
            "display_name": member.display_name or member.username,
            "username": member.username,
            "role": member.role,
            "total_points": member.points,
            "points_redeemed": member.points_redeemed,
            "recent_completions": recent_completions(
                getattr(self.coordinator, "completed_tasks", []), member.user_id),
        }


class DonetickPendingApprovalSensor(_FamilySensor):
    """Number of task completions waiting for an admin, with the details."""

    _attr_icon = "mdi:account-clock"
    _attr_name = "Pending approvals"

    def __init__(self, coordinator: DataUpdateCoordinator, config_entry: ConfigEntry) -> None:
        super().__init__(coordinator, config_entry)
        self._attr_unique_id = f"dt_pending_approvals_{config_entry.entry_id}"

    @property
    def native_value(self) -> int:
        return len(self.coordinator.pending_approvals)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"tasks": self.coordinator.pending_approvals}


class DonetickRewardsSensor(_FamilySensor):
    """Active rewards members can spend their points on."""

    _attr_icon = "mdi:gift"
    _attr_name = "Rewards"

    def __init__(self, coordinator: DataUpdateCoordinator, config_entry: ConfigEntry) -> None:
        super().__init__(coordinator, config_entry)
        self._attr_unique_id = f"dt_rewards_{config_entry.entry_id}"

    @property
    def _rewards(self):
        return sorted((r for r in self.coordinator.rewards or [] if r.is_active),
                      key=lambda reward: (reward.points_cost, reward.name))

    @property
    def native_value(self) -> int:
        return len(self._rewards)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"rewards": [
            {
                "id": r.id,
                "name": r.name,
                "points_cost": r.points_cost,
                "description": r.description,
                "quota_count": r.quota_count,
                "quota_period": r.quota_period,
                "quota_used": r.quota_used,
                "quota_resets_at": r.quota_resets_at.isoformat() if r.quota_resets_at else None,
            }
            for r in self._rewards
        ]}
