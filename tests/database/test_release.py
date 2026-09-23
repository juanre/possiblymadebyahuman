"""Exercise the production image with a pgdbm-owned blank database."""

import asyncio
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_release_image(test_db):
    env = {**os.environ, "PMBAH_TEST_DATABASE_URL": test_db.config.get_dsn()}
    child = await asyncio.create_subprocess_exec(
        "node", "scripts/test-release-container.mjs", cwd=ROOT, env=env
    )
    try:
        assert await child.wait() == 0, "Release image tests failed; see their output above"
    finally:
        if child.returncode is None:
            child.terminate()
            await child.wait()
