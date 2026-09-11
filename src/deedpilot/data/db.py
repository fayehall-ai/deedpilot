"""
Database engine and session management.

Async throughout, because every caller is: the agent loop, the MCP servers and
the voice channel all await, and a blocking driver in a voice call shows up as
dead air.

Pooling matters more here than it looks. Serverless Postgres charges for
connection churn and the platform's pooler has a finite ceiling, so the engine
is created once per process and reused -- a fresh engine per request will
exhaust the pooler long before it exhausts the database.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from deedpilot.config import settings


def _async_url(raw: str) -> str:
    """
    Normalise a connection string for the async psycopg driver.

    Hosted Postgres hands out `postgresql://` (and sometimes `postgres://`)
    URLs that SQLAlchemy would route to the default sync driver. The
    `channel_binding` parameter some providers append is also rejected by
    psycopg's async path, so it is dropped rather than left to fail at connect
    time with an error that names neither the parameter nor the fix.
    """
    url = raw.strip()
    for prefix in ("postgresql+psycopg://", "postgresql+asyncpg://"):
        if url.startswith(prefix):
            url = "postgresql://" + url[len(prefix) :]
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    url = url.replace("postgresql://", "postgresql+psycopg://", 1)

    if "channel_binding=" in url:
        base, _, query = url.partition("?")
        kept = [p for p in query.split("&") if p and not p.startswith("channel_binding=")]
        url = base + ("?" + "&".join(kept) if kept else "")
    return url


@lru_cache(maxsize=1)
def engine() -> AsyncEngine:
    """The process's engine. One per process, reused for its lifetime."""
    cfg = settings()
    if cfg.database_url is None:
        raise RuntimeError(
            "DATABASE_URL is not set. Inventory lookups need it; the atlas and the max-bid "
            "engine do not, and will keep working without it."
        )
    return create_async_engine(
        _async_url(cfg.database_url.get_secret_value()),
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,
        #: Serverless Postgres drops idle connections; recycling under that
        #: window turns a stale-connection error into a silent reconnect.
        pool_recycle=280,
        echo=False,
    )


@lru_cache(maxsize=1)
def session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine(), expire_on_commit=False, autoflush=False)


@asynccontextmanager
async def session() -> AsyncIterator[AsyncSession]:
    """
    A session scoped to one unit of work.

    Read-only by default: nothing in the coach path writes, and a tool that
    wants to must commit explicitly.
    """
    async with session_factory()() as s:
        yield s


async def healthcheck() -> bool:
    """Can we reach the database right now? Used by `/health` and the CLI."""
    from sqlalchemy import text

    try:
        async with session() as s:
            await s.execute(text("select 1"))
        return True
    except Exception:
        return False


async def dispose() -> None:
    """Close the pool. Called on application shutdown."""
    if engine.cache_info().currsize:
        await engine().dispose()
