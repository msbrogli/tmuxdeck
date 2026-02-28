"""CLI entry point: python -m tmuxdeck_bridge"""

from __future__ import annotations

import asyncio
import logging
import signal


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    from .bridge import Bridge
    from .config import parse_config

    config = parse_config()
    bridge = Bridge(config)

    loop = asyncio.new_event_loop()

    def _shutdown(sig: int, frame) -> None:
        logging.info("Received signal %s, shutting down...", sig)
        bridge.stop()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        loop.run_until_complete(bridge.run())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
