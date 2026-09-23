"""Run the Node suite against databases owned and cleaned up by pgdbm."""

import asyncio
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_node_suite(test_db_factory):
    current = await test_db_factory.create_db(suffix="pmbah_current")
    upgrade = await test_db_factory.create_db(suffix="pmbah_upgrade")
    env = {
        **os.environ,
        "PMBAH_TEST_DATABASE_URL": current.config.get_dsn(),
        "PMBAH_TEST_UPGRADE_DATABASE_URL": upgrade.config.get_dsn(),
    }
    tests = sorted(str(path.relative_to(ROOT)) for path in (ROOT / "tests").glob("*.test.mjs"))
    child = await asyncio.create_subprocess_exec("node", "--test", *tests, cwd=ROOT, env=env)
    try:
        assert await child.wait() == 0, "Node tests failed; see their output above"
    finally:
        # An interrupted test must stop using these databases before pgdbm's
        # factory fixture tears them down.
        if child.returncode is None:
            child.terminate()
            await child.wait()
