"""Browser E2E for server mode: runs the FastAPI app with the fake network
(no internet needed) so tests/e2e/server-mode.mjs can drive it with Playwright.

    python tests_py/e2e_server.py 8765
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

import fake_net  # noqa: E402
import refscope.core.pipeline as p  # noqa: E402
import refscope.services.fingerprint as fp  # noqa: E402
import refscope.services.itunes as it  # noqa: E402
from refscope.config import Secrets  # noqa: E402
from refscope.server import create_app  # noqa: E402

it.limiter.tokens = it.limiter.capacity = 100
p.client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake_net.handler))


async def _none(*_a, **_k):
    return None


async def _empty(*_a, **_k):
    return []


fp.identify_shazam = _none
p.recording_tags = _empty
uvicorn.run(create_app(Secrets(shazam_enabled=True)), host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
