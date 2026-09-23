"""Use pgdbm's database lifecycle fixtures without copying their implementation."""

import os

# Match the dedicated local test service. CI and external PostgreSQL servers
# override these before pgdbm reads its fixture configuration at import time.
os.environ.setdefault("TEST_DB_HOST", "127.0.0.1")
os.environ.setdefault("TEST_DB_PORT", "25433")

from pgdbm.fixtures.conftest import test_db, test_db_factory  # noqa: F401
