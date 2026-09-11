"""
Run one MCP server standalone.

    python -m deedpilot.mcp atlas                  # stdio, for a local client
    python -m deedpilot.mcp inventory --http 8801  # streamable HTTP, for AWS

stdio is the local development transport; streamable HTTP is what a deployed
agent or an AgentCore Gateway target connects to.
"""

from __future__ import annotations

import argparse
import sys

from .servers import ALL_SERVERS


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m deedpilot.mcp")
    parser.add_argument("server", choices=sorted(ALL_SERVERS))
    parser.add_argument(
        "--http",
        type=int,
        metavar="PORT",
        help="serve streamable HTTP on this port instead of stdio",
    )
    args = parser.parse_args()

    server = ALL_SERVERS[args.server]
    if args.http:
        server.settings.port = args.http
        server.settings.host = "0.0.0.0"
        server.run(transport="streamable-http")
    else:
        server.run(transport="stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
