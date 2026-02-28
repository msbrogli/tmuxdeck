.PHONY: install lint format test check

install:
	uv pip install -e ".[dev]"

lint:
	uv run ruff check tmuxdeck_bridge/ tests/

format:
	uv run ruff format tmuxdeck_bridge/ tests/
	uv run ruff check --fix tmuxdeck_bridge/ tests/

test:
	uv run pytest tests/ -v

check: lint test
