"""Long-term lesson store (JSONL) — vector/graph can replace later."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from .schemas import ReflectionLesson, utc_now

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "lessons.jsonl"


class LessonMemory:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or DEFAULT_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("")

    def add(self, lesson: ReflectionLesson) -> None:
        with self.path.open("a") as f:
            f.write(lesson.model_dump_json() + "\n")

    def all(self, active_only: bool = True) -> list[ReflectionLesson]:
        out: list[ReflectionLesson] = []
        for line in self.path.read_text().splitlines():
            if not line.strip():
                continue
            lesson = ReflectionLesson.model_validate_json(line)
            if active_only and not lesson.active:
                continue
            out.append(lesson)
        return out

    def as_dicts(self, active_only: bool = True) -> list[dict[str, Any]]:
        return [l.model_dump() for l in self.all(active_only=active_only)]

    def add_from_text(
        self,
        lesson: str,
        *,
        scope: str = "global",
        scope_key: str | None = None,
        trajectory_ids: list[str] | None = None,
        suggested_buffer_usd: float | None = None,
        suggested_p_redeem_delta: float | None = None,
        confidence: float = 0.55,
    ) -> ReflectionLesson:
        item = ReflectionLesson(
            id=str(uuid.uuid4()),
            created_at=utc_now(),
            scope=scope,  # type: ignore[arg-type]
            scope_key=scope_key,
            lesson=lesson,
            evidence_trajectory_ids=trajectory_ids or [],
            suggested_buffer_usd=suggested_buffer_usd,
            suggested_p_redeem_delta=suggested_p_redeem_delta,
            confidence=confidence,
        )
        self.add(item)
        return item
